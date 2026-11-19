import "server-only";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ActionError } from "@/lib/errors";
import { blobConfigured, cleanFileName, LOCAL_UPLOAD_DIR } from "@/lib/files";

/**
 * Stores bytes the server received itself (an upload through the REST API or
 * MCP; the browser uploads straight to Blob instead): private Vercel Blob, or
 * the dev server's disk locally. Returns what a `files` row records.
 */
export async function storeBytes(name: string, bytes: Buffer, contentType: string): Promise<{ url: string; pathname: string }> {
  const clean = cleanFileName(name);
  if (blobConfigured()) {
    const { put } = await import("@vercel/blob");
    const safe = clean.replace(/[^\w.\- ]+/g, "_");
    const r = await put(`files/${safe}`, bytes, { access: "private", addRandomSuffix: true, contentType });
    return { url: r.url, pathname: r.pathname };
  }
  if (process.env.VERCEL) throw new ActionError("File storage isn't set up. Connect Vercel Blob to upload files.");
  const pathname = `${crypto.randomUUID()}${path.extname(clean).slice(0, 12)}`;
  await mkdir(LOCAL_UPLOAD_DIR, { recursive: true });
  await writeFile(path.join(LOCAL_UPLOAD_DIR, pathname), bytes);
  return { url: `local:${pathname}`, pathname };
}
