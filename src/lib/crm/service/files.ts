import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { entityTypes, type EntityType } from "@/lib/constants";
import { actorUserId, assertCan, can, stamp, type Actor } from "@/lib/crm/actor";
import { uploadLinks } from "@/lib/crm/activities";
import { recordEvent, touch } from "@/lib/crm/events";
import { recordsFor } from "@/lib/crm/files";
import { ActionError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { cleanFileName, fileProblem } from "@/lib/files";

/**
 * Changes to files and folders: which records a file is on, which folder it's
 * in, whether anyone with its link can open it, and folders themselves.
 * Attaching a file to a record, taking it off one, and sharing or unsharing
 * one that's on a record write that record's history.
 */

const { files, fileLinks, fileFolders } = schema;

const MAX_RECORDS = 50;
const MAX_FOLDER_DEPTH = 8;

export const fileRecordInput = z.object({ entity: z.enum(entityTypes), id: z.uuid() });
export type FileRecordInput = z.infer<typeof fileRecordInput>;

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

/** Renames a file or moves it to a folder (null is the top level). Its extension stays, so it still opens with the right app. */
export async function updateFile(a: Actor, fileId: string, patch: { name?: string; folderId?: string | null }) {
  assertCan(a, "records:write");
  const f = await loadFile(fileId);
  const set: { name?: string; folderId?: string | null } = {};
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

/** Deletes the bytes behind removed files from Vercel Blob. Local development files stay on disk. */
export async function removeStoredBytes(urls: string[]) {
  const remote = urls.filter((u) => !u.startsWith("local:"));
  if (!remote.length || !process.env.BLOB_READ_WRITE_TOKEN) return;
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
  /** "chat" for an attachment to a team chat message: anyone who can sign in may add one, viewers included. */
  origin: z.literal("chat").nullable().optional(),
});
export type UploadInput = z.input<typeof uploadInput>;

/** Records a file whose bytes were just stored (in Blob, or on disk locally). */
export async function saveUpload(a: Actor, input: UploadInput) {
  const data = uploadInput.parse(input);
  if (data.origin !== "chat") assertCan(a, "records:write");
  const problem = fileProblem(data.name, data.size, data.contentType);
  if (problem) throw new ActionError(problem);
  // A chat attachment belongs to the message, not to a record.
  const linked = data.origin === "chat" ? { personId: null, organizationId: null, clientId: null, activityId: null } : await uploadLinks(data);
  const folder = data.origin === "chat" ? null : await assertFolder(data.folderId);
  const userId = actorUserId(a);
  if (!userId) throw new ActionError("Uploads need a teammate behind them.");
  const db = await getDb();
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
    .returning({ id: files.id });
  await touch(linked);
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

/**
 * Deletes a folder. Nothing in it is lost: its files and folders move up to
 * where the folder was. Whoever made it, or an admin, can delete it.
 */
export async function deleteFolder(a: Actor, folderId: string) {
  assertCan(a, "records:write");
  const folder = await assertFolder(folderId);
  if (!folder) return;
  if (folder.createdBy && folder.createdBy !== actorUserId(a) && !can(a, "activities:moderate")) throw new ForbiddenError("Only the person who made this folder, or an admin, can delete it.");
  const db = await getDb();
  await db.update(files).set({ folderId: folder.parentId }).where(eq(files.folderId, folder.id));
  await db.update(fileFolders).set({ parentId: folder.parentId }).where(eq(fileFolders.parentId, folder.id));
  await db.delete(fileFolders).where(eq(fileFolders.id, folder.id));
  return { parentId: folder.parentId };
}
