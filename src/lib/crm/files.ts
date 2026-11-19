import "server-only";
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { EntityType } from "@/lib/constants";
import { likeTerm } from "@/lib/crm/records";

/**
 * The Files page and the records a file is on. A file is on the records it
 * was uploaded on (`files.person_id`, `organization_id`, `client_id`) and on
 * any it was attached to later (`file_links`); both count the same everywhere.
 */

const { files, fileLinks, fileFolders, people, organizations, clients } = schema;

/** Which list the Files page shows: every file, general files (in folders), files on records, or chat attachments. */
export const fileViews = ["all", "general", "records", "chat"] as const;
export type FileView = (typeof fileViews)[number];

export type FileRecord = { entity: EntityType; id: string; name: string; /** "upload" when it was uploaded there; "link" when attached later. */ via: "upload" | "link" };

/** A file is on a record when one of its own columns or a `file_links` row says so. */
export const onAnyRecord = sql`(${files.personId} is not null or ${files.organizationId} is not null or ${files.clientId} is not null or exists (select 1 from file_links fl where fl.file_id = ${files.id}))`;

/** A file is on exactly this record: added on it, or attached to it later. */
export function onRecord(entity: EntityType, id: string) {
  const column = entity === "person" ? "person_id" : entity === "organization" ? "organization_id" : "client_id";
  const own = entity === "person" ? files.personId : entity === "organization" ? files.organizationId : files.clientId;
  return sql`(${own} = ${id} or exists (select 1 from file_links fl where fl.file_id = ${files.id} and ${sql.raw(`fl.${column}`)} = ${id}))`;
}

/**
 * What a record's Files card and timeline show. A person or an organization
 * shows its own files. A client also shows its contact's, its people's and
 * its organization's: files reach a client from below, never the other way.
 */
export function inRecordView(entity: EntityType, id: string) {
  if (entity !== "client") return onRecord(entity, id);
  const people = sql`(select c.person_id from clients c where c.id = ${id} and c.person_id is not null union select cp.person_id from client_people cp where cp.client_id = ${id})`;
  const org = sql`(select c.organization_id from clients c where c.id = ${id})`;
  return sql`(${files.clientId} = ${id} or ${files.personId} in ${people} or ${files.organizationId} = ${org}
    or exists (select 1 from file_links fl where fl.file_id = ${files.id} and (fl.client_id = ${id} or fl.person_id in ${people} or fl.organization_id = ${org})))`;
}

/** Every file in the CRM, except chat uploads nobody posted. */
const anywhere = sql`(${files.origin} is distinct from 'chat' or ${files.chatMessageId} is not null)`;

/** A general file: not on any record and not a chat attachment, unless someone put it in a folder (a folder keeps whatever is put in it). */
const general = sql`((not ${onAnyRecord} and ${files.origin} is distinct from 'chat') or ${files.folderId} is not null)`;

const fileColumns = {
  id: files.id,
  name: files.name,
  size: files.size,
  contentType: files.contentType,
  uploadedBy: files.uploadedBy,
  createdAt: files.createdAt,
  folderId: files.folderId,
  publicToken: files.publicToken,
  chatMessageId: files.chatMessageId,
  description: files.description,
  contentNotes: files.contentNotes,
  descriptionBy: files.descriptionBy,
  describeStatus: files.describeStatus,
};

export type FileRow = {
  id: string;
  name: string;
  size: number;
  contentType: string;
  uploadedBy: string;
  createdAt: Date;
  folderId: string | null;
  publicToken: string | null;
  chatMessageId: string | null;
  /** What's in it, written by the model on upload or by a teammate (`descriptionBy`). */
  description: string | null;
  contentNotes: string | null;
  descriptionBy: string | null;
  describeStatus: "done" | "skipped" | "failed" | null;
  records: FileRecord[];
};

/**
 * One page of the Files page. General files list one folder at a time (the top
 * level is `folderId` null); a search looks through every folder. Files on
 * records and chat attachments are flat lists, newest first.
 */
export async function listFiles(f: { view: FileView; folderId?: string | null; q?: string }): Promise<FileRow[]> {
  const db = await getDb();
  const where: SQL[] = [isNull(files.deletedAt)];
  const q = f.q?.trim();
  if (q) where.push(or(ilike(files.name, likeTerm(q)), ilike(files.description, likeTerm(q)))!);
  if (f.view === "general") {
    where.push(general);
    if (!q) where.push(f.folderId ? eq(files.folderId, f.folderId) : isNull(files.folderId));
  } else if (f.view === "all") {
    where.push(anywhere);
  } else if (f.view === "records") {
    where.push(onAnyRecord);
  } else {
    where.push(eq(files.origin, "chat"), isNotNull(files.chatMessageId));
  }
  const rows = await db
    .select(fileColumns)
    .from(files)
    .where(and(...where))
    .orderBy(f.view === "general" && !q ? asc(sql`lower(${files.name})`) : desc(files.createdAt))
    .limit(500);
  const records = await recordsFor(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, records: records.get(r.id) ?? [] }));
}

/** How many files each view holds, for the toggle. */
export async function fileViewCounts() {
  const db = await getDb();
  const [row] = await db
    .select({
      all: sql<number>`count(*) filter (where ${anywhere})`.mapWith(Number),
      general: sql<number>`count(*) filter (where ${general})`.mapWith(Number),
      records: sql<number>`count(*) filter (where ${onAnyRecord})`.mapWith(Number),
      chat: sql<number>`count(*) filter (where ${files.origin} = 'chat' and ${files.chatMessageId} is not null)`.mapWith(Number),
    })
    .from(files)
    .where(isNull(files.deletedAt));
  return row ?? { all: 0, general: 0, records: 0, chat: 0 };
}

const personLabel = sql<string>`${people.firstName} || coalesce(' ' || ${people.lastName}, '')`;

/** Every record each file is on, clients first, then organizations, then people. */
export async function recordsFor(fileIds: string[]): Promise<Map<string, FileRecord[]>> {
  const out = new Map<string, FileRecord[]>();
  if (!fileIds.length) return out;
  const db = await getDb();
  const [own, linked] = await Promise.all([
    db
      .select({ fileId: files.id, personId: files.personId, personName: personLabel, organizationId: files.organizationId, organizationName: organizations.name, clientId: files.clientId, clientName: clients.name })
      .from(files)
      .leftJoin(people, eq(people.id, files.personId))
      .leftJoin(organizations, eq(organizations.id, files.organizationId))
      .leftJoin(clients, eq(clients.id, files.clientId))
      .where(inArray(files.id, fileIds)),
    db
      .select({ fileId: fileLinks.fileId, personId: fileLinks.personId, personName: personLabel, organizationId: fileLinks.organizationId, organizationName: organizations.name, clientId: fileLinks.clientId, clientName: clients.name })
      .from(fileLinks)
      .leftJoin(people, eq(people.id, fileLinks.personId))
      .leftJoin(organizations, eq(organizations.id, fileLinks.organizationId))
      .leftJoin(clients, eq(clients.id, fileLinks.clientId))
      .where(inArray(fileLinks.fileId, fileIds))
      .orderBy(asc(fileLinks.createdAt)),
  ]);
  const add = (via: FileRecord["via"]) => (r: (typeof own)[number]) => {
    const list = out.get(r.fileId) ?? [];
    const push = (entity: EntityType, id: string | null, name: string | null) => {
      if (id && !list.some((x) => x.entity === entity && x.id === id)) list.push({ entity, id, name: name ?? "Deleted record", via });
    };
    push("client", r.clientId, r.clientName);
    push("organization", r.organizationId, r.organizationName);
    push("person", r.personId, r.personName);
    out.set(r.fileId, list);
  };
  own.forEach(add("upload"));
  linked.forEach(add("link"));
  const rank = { client: 0, organization: 1, person: 2 };
  for (const list of out.values()) list.sort((a, b) => rank[a.entity] - rank[b.entity]);
  return out;
}

export type FolderRow = { id: string; name: string; parentId: string | null; createdBy: string | null; files: number };

/** Every folder, with how many files are directly in each. Folders are few, so the page gets them all and walks the tree itself. */
export async function listFolders(): Promise<FolderRow[]> {
  const db = await getDb();
  const [folders, counts] = await Promise.all([
    db.select({ id: fileFolders.id, name: fileFolders.name, parentId: fileFolders.parentId, createdBy: fileFolders.createdBy }).from(fileFolders).orderBy(asc(sql`lower(${fileFolders.name})`)),
    db
      .select({ folderId: files.folderId, n: count() })
      .from(files)
      .where(and(isNull(files.deletedAt), isNotNull(files.folderId)))
      .groupBy(files.folderId),
  ]);
  const n = new Map(counts.map((c) => [c.folderId, c.n]));
  return folders.map((f) => ({ ...f, files: n.get(f.id) ?? 0 }));
}

/** One file for the file dialog: its details, every record it's on, and every folder it could go in. Null once it's removed. */
export async function fileDetails(fileId: string) {
  const db = await getDb();
  const [row] = await db
    .select(fileColumns)
    .from(files)
    .where(and(eq(files.id, fileId), isNull(files.deletedAt)));
  if (!row) return null;
  const [records, folders] = await Promise.all([recordsFor([row.id]), listFolders()]);
  return { file: { ...row, records: records.get(row.id) ?? [] } satisfies FileRow, folders };
}
