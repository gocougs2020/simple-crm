import "server-only";
import { and, asc, cosineDistance, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { after } from "next/server";
import { embed } from "ai";
import { appConfig } from "@/app.config";
import { getDb, schema } from "@/db";
import { aiFeatures } from "@/lib/agent/config";
import { aiGateway } from "@/lib/agent/gateway";
import type { EntityType } from "@/lib/constants";
import { inRecordView, onAnyRecord, recordsFor, type FileRecord } from "@/lib/crm/files";
import { likeTerm } from "@/lib/crm/records";

/**
 * Finding files by what they're about. Each file's name, description and key
 * facts are embedded once (`agent.embeddingModel`) and stored as a pgvector
 * column with an HNSW index, so a search embeds only the question and the
 * database returns the nearest files in milliseconds: no file text is sent
 * to a model to search. Without an AI Gateway key, search matches words in
 * names, descriptions and key facts instead.
 */

const { files } = schema;
const EMBED_CHARS = 8000;
/** Nearer than this (cosine distance, 0 is identical) counts as a match. */
const MAX_DISTANCE = 0.75;

const model = () => aiGateway.embeddingModel(appConfig.agent.embeddingModel);

/** The text a file is found by. */
const embeddable = (f: { name: string; description: string | null; contentNotes: string | null }) => [f.name, f.description, f.contentNotes].filter(Boolean).join("\n").slice(0, EMBED_CHARS);

/**
 * Rewrites a file's vector from its current description: called whenever the
 * description is written, edited or cleared. No description, no vector (it's
 * found by name only).
 */
export async function embedFile(fileId: string) {
  const db = await getDb();
  const [f] = await db.select({ name: files.name, description: files.description, contentNotes: files.contentNotes }).from(files).where(eq(files.id, fileId));
  if (!f) return;
  if (!f.description || !aiFeatures().files) {
    await db.update(files).set({ embedding: null }).where(eq(files.id, fileId));
    return;
  }
  const { embedding } = await embed({ model: model(), value: embeddable(f), maxRetries: 1, abortSignal: AbortSignal.timeout(30_000) });
  // Only if the description is still the one embedded: an edit in the meantime embeds again.
  await db
    .update(files)
    .set({ embedding })
    .where(and(eq(files.id, fileId), f.description ? eq(files.description, f.description) : isNull(files.description)));
}

/** Rewrites a file's vector after the response is sent. */
export function embedSoon(fileId: string) {
  const work = () => embedFile(fileId).catch((err) => console.error("[files] embed", fileId, err));
  try {
    after(work);
  } catch {
    void work();
  }
}

/** Files with a description but no vector yet (described before this existed, or the embed failed). */
export async function embedBacklog(limit = 25) {
  if (!aiFeatures().files) return { embedded: 0 };
  const db = await getDb();
  const rows = await db
    .select({ id: files.id })
    .from(files)
    .where(and(isNull(files.deletedAt), isNotNull(files.description), isNull(files.embedding)))
    .orderBy(desc(files.createdAt))
    .limit(limit);
  for (const r of rows) await embedFile(r.id).catch((err) => console.error("[files] embed", r.id, err));
  return { embedded: rows.length };
}

export type FileSearch = {
  /** What to look for, in plain words: "current pricing", "the Globex MSA". */
  q?: string;
  /** Only files on this record (for a client, also its contact's, people's and organization's). */
  record?: { entity: EntityType; id: string };
  /** Only files on some record, or only files on none. */
  onRecords?: boolean;
  folderId?: string | null;
  limit?: number;
};

export type FoundFile = {
  id: string;
  name: string;
  contentType: string;
  size: number;
  description: string | null;
  folderId: string | null;
  publicToken: string | null;
  uploadedBy: string;
  createdAt: Date;
  chatMessageId: string | null;
  records: FileRecord[];
  /** How close it is to the question, 0 to 1 (1 is the same meaning). Null for a word match or a plain list. */
  score: number | null;
};

const columns = {
  id: files.id,
  name: files.name,
  contentType: files.contentType,
  size: files.size,
  description: files.description,
  folderId: files.folderId,
  publicToken: files.publicToken,
  uploadedBy: files.uploadedBy,
  createdAt: files.createdAt,
  chatMessageId: files.chatMessageId,
};

/**
 * Files that match a question, best first: by meaning when AI is on (with
 * exact name matches first), else by words. Every file a teammate can see is
 * searchable; chat uploads nobody posted aren't.
 */
export async function searchFiles(f: FileSearch): Promise<FoundFile[]> {
  const db = await getDb();
  const limit = Math.min(Math.max(f.limit ?? 10, 1), 50);
  const where: SQL[] = [isNull(files.deletedAt), sql`(${files.origin} is distinct from 'chat' or ${files.chatMessageId} is not null)`];
  if (f.record) where.push(inRecordView(f.record.entity, f.record.id));
  if (f.onRecords === true) where.push(onAnyRecord);
  if (f.onRecords === false) where.push(sql`not ${onAnyRecord}`);
  if (f.folderId !== undefined) where.push(f.folderId ? eq(files.folderId, f.folderId) : isNull(files.folderId));
  const q = f.q?.trim().slice(0, 500);

  let rows: (Omit<FoundFile, "records" | "score"> & { distance?: number })[] = [];
  if (q && aiFeatures().files) {
    const { embedding } = await embed({ model: model(), value: q, maxRetries: 1, abortSignal: AbortSignal.timeout(15_000) });
    const distance = cosineDistance(files.embedding, embedding);
    const [near, named] = await Promise.all([
      db
        .select({ ...columns, distance: sql<number>`${distance}`.mapWith(Number) })
        .from(files)
        .where(and(...where, isNotNull(files.embedding), sql`${distance} < ${MAX_DISTANCE}`))
        .orderBy(asc(distance))
        .limit(limit),
      // A file named for what was asked always counts, described or not.
      db
        .select(columns)
        .from(files)
        .where(and(...where, ilike(files.name, likeTerm(q))))
        .orderBy(desc(files.createdAt))
        .limit(limit),
    ]);
    rows = [...named, ...near.filter((n) => !named.some((x) => x.id === n.id))].slice(0, limit);
  } else if (q) {
    const words = q.split(/\s+/).filter((w) => w.length > 1).slice(0, 8);
    const each = words.map((w) => or(ilike(files.name, likeTerm(w)), ilike(files.description, likeTerm(w)), ilike(files.contentNotes, likeTerm(w)))!);
    rows = await db
      .select(columns)
      .from(files)
      .where(and(...where, ...(each.length ? each : [ilike(files.name, likeTerm(q))])))
      .orderBy(desc(files.createdAt))
      .limit(limit);
  } else {
    rows = await db
      .select(columns)
      .from(files)
      .where(and(...where))
      .orderBy(desc(files.createdAt))
      .limit(limit);
  }
  const records = await recordsFor(rows.map((r) => r.id));
  return rows.map(({ distance, ...r }) => ({ ...r, records: records.get(r.id) ?? [], score: distance === undefined ? null : Math.round((1 - distance) * 1000) / 1000 }));
}

/** The files with these ids that still exist, in that order. */
export async function filesByIds(ids: string[]) {
  if (!ids.length) return [];
  const db = await getDb();
  const rows = await db
    .select(columns)
    .from(files)
    .where(and(inArray(files.id, ids), isNull(files.deletedAt)));
  return ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is NonNullable<typeof r> => !!r);
}
