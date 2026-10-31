import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { getUser } from "@/lib/auth";
import { inlineTypes, LOCAL_UPLOAD_DIR } from "@/lib/files";

/**
 * Downloads a file after checking the session. Files live in a private store,
 * so this route is the only way to read them. Responses are sandboxed so an
 * uploaded document can never run script on this site.
 */
export async function GET(request: Request, { params }: RouteContext<"/api/files/[id]">) {
  const user = await getUser();
  if (!user) return new NextResponse("Sign in to download files.", { status: 401 });
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return new NextResponse("Not found", { status: 404 });
  const db = await getDb();
  const [f] = await db.select().from(schema.files).where(eq(schema.files.id, id));
  if (!f || f.deletedAt) return new NextResponse("This file was removed.", { status: 404 });

  const download = new URL(request.url).searchParams.has("download") || !inlineTypes.test(f.contentType);
  const headers = new Headers({
    "Content-Type": f.contentType,
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    "Cache-Control": "private, max-age=300",
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
