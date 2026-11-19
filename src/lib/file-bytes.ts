import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { schema } from "@/db";
import { ActionError } from "@/lib/errors";
import { LOCAL_UPLOAD_DIR } from "@/lib/files";

/** A stored file's bytes, from private Blob or (locally) disk. Throws a readable error when they've gone missing. */
export async function readStoredBytes(f: Pick<typeof schema.files.$inferSelect, "url" | "pathname" | "name">): Promise<Buffer> {
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
