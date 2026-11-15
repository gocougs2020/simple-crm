import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, inArray, isNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { EmailAttachment } from "@/db/schema";
import { ActionError } from "@/lib/auth";
import { MAX_EMAIL_ATTACHMENT_BYTES, MAX_EMAIL_ATTACHMENTS } from "@/lib/constants";
import { formatBytes } from "@/lib/format";
import { LOCAL_UPLOAD_DIR } from "@/lib/files";

/**
 * Email attachments are ordinary CRM files (uploaded to Blob or, locally, to
 * disk), so a file sent from a record also shows in that record's Files. An
 * email stores the list it went with; the bytes are read at send time.
 */

/** Checks file ids the browser sent and returns what to store on the email. Refuses removed files and anything over the size limits. */
export async function resolveAttachments(fileIds: string[]): Promise<EmailAttachment[]> {
  const ids = [...new Set(fileIds)];
  if (!ids.length) return [];
  if (ids.length > MAX_EMAIL_ATTACHMENTS) throw new ActionError(`Attach up to ${MAX_EMAIL_ATTACHMENTS} files.`);
  const db = await getDb();
  const rows = await db
    .select({ fileId: schema.files.id, name: schema.files.name, size: schema.files.size, contentType: schema.files.contentType })
    .from(schema.files)
    .where(and(inArray(schema.files.id, ids), isNull(schema.files.deletedAt)));
  if (rows.length !== ids.length) throw new ActionError("One of the attachments was removed. Take it off and attach it again.");
  const total = rows.reduce((n, r) => n + r.size, 0);
  if (total > MAX_EMAIL_ATTACHMENT_BYTES) throw new ActionError(`Attachments add up to ${formatBytes(total)}. Keep them under ${formatBytes(MAX_EMAIL_ATTACHMENT_BYTES)}, or share a link instead.`);
  // Keep the order they were attached in.
  return ids.map((id) => rows.find((r) => r.fileId === id)!);
}

export type LoadedAttachment = { filename: string; content: Buffer; contentType: string };

/** Reads the files' bytes for sending. Throws a readable error if one has gone missing from storage. */
export async function loadAttachments(list: EmailAttachment[]): Promise<LoadedAttachment[]> {
  if (!list.length) return [];
  const db = await getDb();
  const rows = await db
    .select()
    .from(schema.files)
    .where(
      and(
        inArray(
          schema.files.id,
          list.map((a) => a.fileId),
        ),
        isNull(schema.files.deletedAt),
      ),
    );
  return Promise.all(
    list.map(async (a) => {
      const f = rows.find((r) => r.id === a.fileId);
      if (!f) throw new ActionError(`${a.name} was removed from the CRM, so it can't be attached.`);
      return { filename: f.name, content: await readBytes(f), contentType: f.contentType };
    }),
  );
}

async function readBytes(f: typeof schema.files.$inferSelect): Promise<Buffer> {
  if (f.url.startsWith("local:")) {
    const bytes = await readFile(path.join(LOCAL_UPLOAD_DIR, path.basename(f.pathname))).catch(() => null);
    if (!bytes) throw new ActionError(`${f.name} is missing from local storage.`);
    return bytes;
  }
  const { get } = await import("@vercel/blob");
  const blob = await get(f.url, { access: "private" });
  if (!blob || blob.statusCode !== 200 || !blob.stream) throw new ActionError(`${f.name} is missing from file storage.`);
  return Buffer.from(await new Response(blob.stream).arrayBuffer());
}
