import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import type { EntityType } from "@/lib/constants";
import { actorUserId, assertCan, can, stamp, type Actor } from "@/lib/crm/actor";
import { uploadLinks } from "@/lib/crm/activities";
import { recordEvent, touch } from "@/lib/crm/events";
import { onAnyRecord, recordsFor } from "@/lib/crm/files";
import { ActionError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { cleanFileName, fileProblem } from "@/lib/files";
import { bytesUploadInput, fileRecordInput, type FileRecordInput } from "@/lib/crm/schemas";
export { bytesUploadInput, fileRecordInput, type FileRecordInput };
import { MAX_API_FILE_BYTES } from "@/lib/api/body";
import { describeSoon } from "@/lib/file-describe";
import { storeBytes } from "@/lib/file-store";
import { embedSoon } from "@/lib/file-search";
import { cleanModelText, DESCRIPTION_MAX } from "@/lib/file-describe-rules";

/**
 * Changes to files and folders: which records a file is on, which folder it's
 * in, whether anyone with its link can open it, and folders themselves.
 * Attaching a file to a record, taking it off one, and sharing or unsharing
 * one that's on a record write that record's history.
 */

const { files, fileLinks, fileFolders } = schema;

const MAX_RECORDS = 50;
const MAX_FOLDER_DEPTH = 8;


async function loadFile(id: string) {
  const db = await getDb();
  const [f] = await db.select().from(files).where(eq(files.id, z.uuid().parse(id)));
  if (!f || f.deletedAt) throw new NotFoundError("That file was removed.");
  return f;
}

const ownColumn = { person: "personId", organization: "organizationId", client: "clientId" } as const;

async function assertRecordExists(r: FileRecordInput) {
  const db = await getDb();
  const table = r.entity === "person" ? schema.people : r.entity === "organization" ? schema.organizations : schema.clients;
  const [row] = await db.select({ id: table.id }).from(table).where(eq(table.id, r.id));
  if (!row) throw new NotFoundError(`That ${r.entity} was deleted. Pick another one.`);
}

/**
 * Sets every record a file is on to exactly `wanted`. Records it was uploaded
 * on that aren't wanted any more are cleared from the file; new ones are
 * attached through `file_links`. Each record that gained or lost the file
 * gets a history entry.
 */
export async function setFileRecords(a: Actor, fileId: string, wanted: FileRecordInput[]) {
  assertCan(a, "records:write");
  const list = z.array(fileRecordInput).max(MAX_RECORDS, `A file can be on ${MAX_RECORDS} records at most.`).parse(wanted);
  const f = await loadFile(fileId);
  const db = await getDb();
  const key = (r: { entity: EntityType; id: string }) => `${r.entity}:${r.id}`;
  const want = new Map(list.map((r) => [key(r), r]));
  const current = (await recordsFor([f.id])).get(f.id) ?? [];
  const have = new Set(current.map(key));
  const by = stamp(a);

  const removed = current.filter((r) => !want.has(key(r)));
  const added = [...want.values()].filter((r) => !have.has(key(r)));
  for (const r of added) await assertRecordExists(r);

  const clear: Partial<Record<(typeof ownColumn)[EntityType], null>> = {};
  for (const r of removed) {
    if (r.via === "upload") clear[ownColumn[r.entity]] = null;
    else await db.delete(fileLinks).where(and(eq(fileLinks.fileId, f.id), eq(fileLinks[ownColumn[r.entity]], r.id)));
  }
  // A file the browser attached to a note or call follows that activity; once it's off the activity's records it stands on its own.
  if (Object.keys(clear).length) await db.update(files).set({ ...clear, ...(f.activityId ? { activityId: null } : {}) }).where(eq(files.id, f.id));
  if (added.length) {
    await db
      .insert(fileLinks)
      .values(added.map((r) => ({ fileId: f.id, [ownColumn[r.entity]]: r.id, createdBy: actorUserId(a) })))
      .onConflictDoNothing();
  }
  for (const r of added) await recordEvent({ entityType: r.entity, entityId: r.id, action: "file_attached", data: { name: f.name, fileId: f.id }, ...by });
  for (const r of removed) await recordEvent({ entityType: r.entity, entityId: r.id, action: "file_detached", data: { name: f.name, fileId: f.id }, ...by });
  return { added: added.length, removed: removed.length };
}

async function assertFolder(id: string | null | undefined) {
  if (!id) return null;
  const db = await getDb();
  const [folder] = await db.select().from(fileFolders).where(eq(fileFolders.id, z.uuid().parse(id)));
  if (!folder) throw new NotFoundError("That folder was deleted. Pick another one.");
  return folder;
}

const fileName = z.string().trim().min(1, "Give the file a name.").max(180);

/**
 * Renames a file, moves it to a folder (null is the top level) or rewrites
 * its description. Its extension stays, so it still opens with the right
 * app. A description written here is kept from then on; clearing it hands it
 * back to the model.
 */
export async function updateFile(a: Actor, fileId: string, patch: { name?: string; folderId?: string | null; description?: string | null }) {
  assertCan(a, "records:write");
  const f = await loadFile(fileId);
  const set: Partial<typeof files.$inferInsert> = {};
  let redescribe = false;
  if (patch.description !== undefined) {
    const text = cleanModelText(patch.description ?? "", DESCRIPTION_MAX);
    if (text !== (f.description ?? "")) {
      if (text) Object.assign(set, { description: text, descriptionBy: actorUserId(a), describeStatus: "done", describedAt: new Date() });
      else {
        Object.assign(set, { description: null, contentNotes: null, descriptionBy: null, describeStatus: null, describedAt: null });
        redescribe = true;
      }
    }
  }
  if (patch.name !== undefined) {
    let name = cleanFileName(fileName.parse(patch.name));
    const ext = f.name.match(/\.[\w]{1,10}$/)?.[0];
    if (ext && !name.toLowerCase().endsWith(ext.toLowerCase())) name = `${name}${ext}`;
    if (name !== f.name) set.name = name;
  }
  if (patch.folderId !== undefined) set.folderId = (await assertFolder(patch.folderId))?.id ?? null;
  if (!Object.keys(set).length) return;
  const db = await getDb();
  await db.update(files).set(set).where(eq(files.id, f.id));
  // The vector follows the description: rewritten when it's edited, cleared when it's removed (until it's described again).
  if (set.description !== undefined || set.name !== undefined) embedSoon(f.id);
  if (redescribe) describeSoon(f.id);
}

/** Moves files to a folder (null is the top level). */
export async function moveFiles(a: Actor, fileIds: string[], folderId: string | null) {
  assertCan(a, "records:write");
  const ids = z.array(z.uuid()).min(1).max(500).parse(fileIds);
  const folder = await assertFolder(folderId);
  const db = await getDb();
  await db
    .update(files)
    .set({ folderId: folder?.id ?? null })
    .where(and(inArray(files.id, ids), isNull(files.deletedAt)));
}

/** A link nobody can guess: 24 random bytes, URL-safe. */
const newToken = () => randomBytes(24).toString("base64url");

/**
 * Public files open for anyone with their link (/share/<token>), signed in or
 * not. Internal ones need a signed-in teammate. Making a file internal clears
 * the token, so links already sent stop working; sharing it again makes a new one.
 */
export async function setFileVisibility(a: Actor, fileId: string, visibility: "internal" | "public") {
  assertCan(a, "records:write");
  const f = await loadFile(fileId);
  const db = await getDb();
  const isPublic = visibility === "public";
  if (isPublic === !!f.publicToken) return { token: f.publicToken };
  const token = isPublic ? newToken() : null;
  await db
    .update(files)
    .set({ publicToken: token, publicAt: isPublic ? new Date() : null })
    .where(eq(files.id, f.id));
  const records = (await recordsFor([f.id])).get(f.id) ?? [];
  for (const r of records) {
    await recordEvent({ entityType: r.entity, entityId: r.id, action: isPublic ? "file_shared" : "file_unshared", data: { name: f.name, fileId: f.id }, ...stamp(a) });
  }
  return { token };
}

/** Removes a file from the CRM. The uploader or an admin can do this. History on its records says it was removed. */
export async function deleteFile(a: Actor, fileId: string) {
  assertCan(a, "records:write");
  const db = await getDb();
  const [f] = await db.select().from(files).where(eq(files.id, z.uuid().parse(fileId)));
  if (!f || f.deletedAt) return;
  if (f.uploadedBy !== actorUserId(a) && !can(a, "activities:moderate")) throw new ForbiddenError("Only the person who uploaded this, or an admin, can remove it.");
  const records = (await recordsFor([f.id])).get(f.id) ?? [];
  await db.update(files).set({ deletedAt: new Date(), publicToken: null }).where(eq(files.id, f.id));
  await removeStoredBytes([f.url]);
  for (const r of records) await recordEvent({ entityType: r.entity, entityId: r.id, action: "file_deleted", data: { name: f.name }, ...stamp(a) });
}

/** Deletes the bytes behind removed files from Vercel Blob, unless a file still in the CRM uses them. Local development files stay on disk. */
export async function removeStoredBytes(urls: string[]) {
  let remote = urls.filter((u) => !u.startsWith("local:"));
  if (!remote.length || !process.env.BLOB_READ_WRITE_TOKEN) return;
  const db = await getDb();
  const kept = await db
    .select({ url: files.url })
    .from(files)
    .where(and(inArray(files.url, remote), isNull(files.deletedAt)));
  remote = remote.filter((u) => !kept.some((k) => k.url === u));
  if (!remote.length) return;
  const { del } = await import("@vercel/blob");
  await del(remote).catch((err) => console.error("[files] blob delete", err));
}

export const uploadInput = z.object({
  url: z.string().min(1).max(1000),
  pathname: z.string().min(1).max(500),
  name: z.string().min(1).max(300),
  size: z.number().int().positive(),
  contentType: z.string().max(200),
  personId: z.uuid().nullable().optional(),
  organizationId: z.uuid().nullable().optional(),
  clientId: z.uuid().nullable().optional(),
  /** The note, call or other activity it's attached to. */
  activityId: z.uuid().nullable().optional(),
  /** The folder it goes in on the Files page. */
  folderId: z.uuid().nullable().optional(),
  /** "chat" for an attachment to a team chat message. */
  origin: z.literal("chat").nullable().optional(),
});
export type UploadInput = z.input<typeof uploadInput>;

/** Records a file whose bytes were just stored (in Blob, or on disk locally). */
export async function saveUpload(a: Actor, input: UploadInput) {
  // Viewers can't add files anywhere, the team chat included.
  assertCan(a, "records:write");
  const data = uploadInput.parse(input);
  const problem = fileProblem(data.name, data.size, data.contentType);
  if (problem) throw new ActionError(problem);
  // A chat attachment belongs to the message, not to a record.
  const linked = data.origin === "chat" ? { personId: null, organizationId: null, clientId: null, activityId: null } : await uploadLinks(data);
  const folder = data.origin === "chat" ? null : await assertFolder(data.folderId);
  const userId = actorUserId(a);
  if (!userId) throw new ActionError("Uploads need a teammate behind them.");
  const db = await getDb();
  // Each upload is registered once (a unique index on the URL): a second row on the same stored bytes could later delete them out from under the first.
  const [row] = await db
    .insert(files)
    .values({
      url: data.url,
      pathname: data.pathname,
      size: data.size,
      contentType: data.contentType || "application/octet-stream",
      ...linked,
      folderId: folder?.id ?? null,
      origin: data.origin ?? null,
      name: cleanFileName(data.name),
      uploadedBy: userId,
    })
    .onConflictDoNothing({ target: files.url })
    .returning({ id: files.id });
  if (!row) throw new ActionError("That upload was already added. Upload the file again.");
  await touch(linked);
  describeSoon(row.id);
  return row;
}

const typesByExtension: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};


/**
 * A file sent to the server as base64 (the REST API and MCP): stored, then
 * recorded like any upload. Viewers can't upload, and the same type and size
 * rules apply as in the browser.
 */
export async function uploadFileBytes(a: Actor, input: z.input<typeof bytesUploadInput>) {
  assertCan(a, "records:write");
  const data = bytesUploadInput.parse(input);
  if ([data.personId, data.organizationId, data.clientId].filter(Boolean).length > 1) throw new ActionError("Add a file to one record: give at most one of personId, organizationId and clientId. Attach it to more with update_file.");
  if (!/^[A-Za-z0-9+/\r\n]*={0,2}\s*$/.test(data.contentBase64)) throw new ActionError("contentBase64 isn't base64.");
  const bytes = Buffer.from(data.contentBase64, "base64");
  if (bytes.length > MAX_API_FILE_BYTES) throw new ActionError(`The file is over ${MAX_API_FILE_BYTES / 1024 / 1024} MB. Upload bigger files on the Files page.`);
  const ext = (/\.([a-z0-9]+)$/i.exec(data.name)?.[1] ?? "").toLowerCase();
  const contentType = data.contentType?.trim() || typesByExtension[ext] || "application/octet-stream";
  const problem = fileProblem(data.name, bytes.length, contentType);
  if (problem) throw new ActionError(problem);
  const stored = await storeBytes(data.name, bytes, contentType);
  const row = await saveUpload(a, { ...stored, name: data.name, size: bytes.length, contentType, personId: data.personId, organizationId: data.organizationId, clientId: data.clientId, folderId: data.folderId });
  if (data.description) await updateFile(a, row.id, { description: data.description });
  return row;
}

// ─── Folders ─────────────────────────────────────────────────────────────

const folderName = z.string().trim().min(1, "Give the folder a name.").max(80, "Keep folder names under 80 characters.");

/** The folder's parents, nearest first. */
async function ancestors(id: string) {
  const db = await getDb();
  const all = await db.select({ id: fileFolders.id, parentId: fileFolders.parentId }).from(fileFolders);
  const parent = new Map(all.map((f) => [f.id, f.parentId]));
  const chain: string[] = [];
  for (let at = parent.get(id) ?? null; at && chain.length < 100; at = parent.get(at) ?? null) chain.push(at);
  return chain;
}

/** Two folders in the same place can't share a name, so it's always clear which is which. */
async function assertNameFree(name: string, parentId: string | null, except?: string) {
  const db = await getDb();
  const [clash] = await db
    .select({ id: fileFolders.id })
    .from(fileFolders)
    .where(and(sql`lower(${fileFolders.name}) = lower(${name})`, parentId ? eq(fileFolders.parentId, parentId) : isNull(fileFolders.parentId), except ? ne(fileFolders.id, except) : undefined));
  if (clash) throw new ActionError(`There's already a folder called ${name} here. Pick another name.`);
}

async function assertDepth(parentId: string | null) {
  if (parentId && (await ancestors(parentId)).length + 1 >= MAX_FOLDER_DEPTH) throw new ActionError(`Folders go ${MAX_FOLDER_DEPTH} levels deep at most. Put this one higher up.`);
}

export async function createFolder(a: Actor, input: { name: string; parentId?: string | null }) {
  assertCan(a, "records:write");
  const name = folderName.parse(input.name);
  const parent = await assertFolder(input.parentId);
  await assertDepth(parent?.id ?? null);
  await assertNameFree(name, parent?.id ?? null);
  const db = await getDb();
  const [row] = await db
    .insert(fileFolders)
    .values({ name, parentId: parent?.id ?? null, createdBy: actorUserId(a) })
    .returning({ id: fileFolders.id });
  return row;
}

/** Renames a folder or moves it into another one (null is the top level). A folder can't go inside itself. */
export async function updateFolder(a: Actor, folderId: string, patch: { name?: string; parentId?: string | null }) {
  assertCan(a, "records:write");
  const folder = await assertFolder(folderId);
  if (!folder) throw new NotFoundError("That folder was deleted.");
  const set: { name?: string; parentId?: string | null; updatedAt: Date } = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = folderName.parse(patch.name);
  if (patch.parentId !== undefined) {
    const parent = await assertFolder(patch.parentId);
    if (parent && (parent.id === folder.id || (await ancestors(parent.id)).includes(folder.id))) throw new ActionError("A folder can't go inside itself. Pick a folder outside it.");
    await assertDepth(parent?.id ?? null);
    set.parentId = parent?.id ?? null;
  }
  if (set.name !== undefined || set.parentId !== undefined) await assertNameFree(set.name ?? folder.name, set.parentId !== undefined ? set.parentId : folder.parentId, folder.id);
  const db = await getDb();
  await db.update(fileFolders).set(set).where(eq(fileFolders.id, folder.id));
}

/** A folder and every folder inside it, at any depth. */
async function folderAndDescendants(folderId: string) {
  const db = await getDb();
  const all = await db.select({ id: fileFolders.id, parentId: fileFolders.parentId }).from(fileFolders);
  const ids = [folderId];
  for (let i = 0; i < ids.length && ids.length < 10_000; i++) for (const f of all) if (f.parentId === ids[i] && !ids.includes(f.id)) ids.push(f.id);
  return ids;
}

export type FolderContents = {
  folders: number;
  files: number;
  /** A few of the files, for the dialog to name. */
  sample: string[];
  /** Files on a client, person or organization: deleting them takes them off those records. */
  onRecords: number;
  public: number;
  /** Files someone else uploaded, which only an admin can delete. */
  notYours: number;
  /** Folders inside that someone else made, which only an admin can delete. */
  foldersNotYours: number;
};

/** What deleting a folder would delete: every file and folder inside it, at any depth. */
export async function folderContents(a: Actor, folderId: string): Promise<FolderContents> {
  const folder = await assertFolder(folderId);
  if (!folder) throw new NotFoundError("That folder was deleted.");
  const ids = await folderAndDescendants(folder.id);
  const db = await getDb();
  const inside = await db
    .select({ name: files.name, uploadedBy: files.uploadedBy, publicToken: files.publicToken, onRecords: sql<boolean>`${onAnyRecord}` })
    .from(files)
    .where(and(inArray(files.folderId, ids), isNull(files.deletedAt)))
    .orderBy(sql`lower(${files.name})`);
  const me = actorUserId(a);
  const others = await othersFolders(a, ids.slice(1));
  return {
    foldersNotYours: others,
    folders: ids.length - 1,
    files: inside.length,
    sample: inside.slice(0, 8).map((f) => f.name),
    onRecords: inside.filter((f) => f.onRecords).length,
    public: inside.filter((f) => f.publicToken).length,
    notYours: can(a, "activities:moderate") ? 0 : inside.filter((f) => f.uploadedBy !== me).length,
  };
}

/** How many of these folders someone else made; zero for an admin. */
async function othersFolders(a: Actor, ids: string[]) {
  if (!ids.length || can(a, "activities:moderate")) return 0;
  const db = await getDb();
  const rows = await db.select({ createdBy: fileFolders.createdBy }).from(fileFolders).where(inArray(fileFolders.id, ids));
  return rows.filter((f) => f.createdBy && f.createdBy !== actorUserId(a)).length;
}

export const deleteFolderInput = z.discriminatedUnion("contents", [
  /** Move what's directly inside to another folder (null is the top level), then delete the folder. */
  z.object({ contents: z.literal("move"), to: z.uuid().nullable() }),
  /** Delete the folder with every file and folder in it. */
  z.object({ contents: z.literal("delete") }),
]);

/**
 * Deletes a folder, with what's in it: either moved somewhere else first, or
 * deleted along with it (every file and folder inside, at any depth). Whoever
 * made the folder, or an admin, can delete it; deleting its files also needs
 * the right to delete each one (the uploader, or an admin).
 */
export async function deleteFolder(a: Actor, folderId: string, choice: z.input<typeof deleteFolderInput>) {
  assertCan(a, "records:write");
  const how = deleteFolderInput.parse(choice);
  const folder = await assertFolder(folderId);
  if (!folder) return;
  if (folder.createdBy && folder.createdBy !== actorUserId(a) && !can(a, "activities:moderate")) throw new ForbiddenError("Only the person who made this folder, or an admin, can delete it.");
  const db = await getDb();
  const ids = await folderAndDescendants(folder.id);

  if (how.contents === "move") {
    const to = await assertFolder(how.to);
    if (to && ids.includes(to.id)) throw new ActionError("Pick a folder outside the one you're deleting.");
    await assertDepth(to?.id ?? null);
    const subfolders = await db.select({ id: fileFolders.id, name: fileFolders.name }).from(fileFolders).where(eq(fileFolders.parentId, folder.id));
    for (const f of subfolders) await assertNameFree(f.name, to?.id ?? null, f.id);
    await db.update(files).set({ folderId: to?.id ?? null }).where(eq(files.folderId, folder.id));
    await db.update(fileFolders).set({ parentId: to?.id ?? null, updatedAt: new Date() }).where(eq(fileFolders.parentId, folder.id));
    await db.delete(fileFolders).where(eq(fileFolders.id, folder.id));
    return { parentId: folder.parentId, deletedFiles: 0 };
  }

  const inside = await db
    .select()
    .from(files)
    .where(and(inArray(files.folderId, ids), isNull(files.deletedAt)));
  const me = actorUserId(a);
  const notYours = can(a, "activities:moderate") ? 0 : inside.filter((f) => f.uploadedBy !== me).length;
  if (notYours) throw new ForbiddenError(`${notYours === 1 ? "One file" : `${notYours} files`} in this folder ${notYours === 1 ? "was" : "were"} uploaded by someone else, so only an admin can delete ${notYours === 1 ? "it" : "them"}. Move everything to another folder instead, or ask an admin.`);
  const foldersNotYours = await othersFolders(a, ids.slice(1));
  if (foldersNotYours) throw new ForbiddenError(`${foldersNotYours === 1 ? "One folder" : `${foldersNotYours} folders`} inside this one ${foldersNotYours === 1 ? "was" : "were"} made by someone else, so only an admin can delete ${foldersNotYours === 1 ? "it" : "them"}. Move everything to another folder instead, or ask an admin.`);
  const records = await recordsFor(inside.map((f) => f.id));
  if (inside.length) {
    await db
      .update(files)
      .set({ deletedAt: new Date(), publicToken: null, folderId: null })
      .where(
        inArray(
          files.id,
          inside.map((f) => f.id),
        ),
      );
  }
  // Folders inside go with it (parent_id cascades).
  await db.delete(fileFolders).where(eq(fileFolders.id, folder.id));
  await removeStoredBytes(inside.map((f) => f.url));
  for (const f of inside) for (const r of records.get(f.id) ?? []) await recordEvent({ entityType: r.entity, entityId: r.id, action: "file_deleted", data: { name: f.name }, ...stamp(a) });
  return { parentId: folder.parentId, deletedFiles: inside.length };
}
