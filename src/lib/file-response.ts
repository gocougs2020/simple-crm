import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import type { schema } from "@/db";
import { inlineTypes, LOCAL_UPLOAD_DIR } from "@/lib/files";

/**
 * A stored file's bytes as a response. Files live in a private store, so a
 * route has to read them; this is the one way to. Responses are sandboxed so
 * an uploaded document can never run script on this site. `cache` is how long
 * a browser may keep it (always private: the same URL can stop working).
 */
export async function fileResponse(f: Pick<typeof schema.files.$inferSelect, "contentType" | "name" | "url" | "pathname">, o: { download: boolean; cache?: string }) {
  const download = o.download || !inlineTypes.test(f.contentType);
  const headers = new Headers({
    "Content-Type": f.contentType,
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    "Cache-Control": o.cache ?? "private, max-age=300",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
  });

  if (f.url.startsWith("local:")) {
    const file = await readFile(path.join(LOCAL_UPLOAD_DIR, path.basename(f.pathname))).catch(() => null);
    if (!file) return new NextResponse("This file is missing from local storage.", { status: 404 });
    return new NextResponse(file, { headers });
  }
  const { get } = await import("@vercel/blob");
  const blob = await get(f.url, { access: "private" });
  if (!blob || blob.statusCode !== 200 || !blob.stream) return new NextResponse("This file is missing from storage.", { status: 404 });
  headers.set("Content-Length", String(blob.blob.size));
  return new NextResponse(blob.stream, { headers });
}
