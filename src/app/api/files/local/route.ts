import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { getUser } from "@/lib/auth";
import { touch } from "@/lib/crm/events";
import { blobConfigured, cleanFileName, fileProblem, LOCAL_UPLOAD_DIR } from "@/lib/files";

/** Local development without Vercel Blob: files are saved under .data/uploads. Never used on Vercel. */
export async function POST(request: Request) {
  if (process.env.VERCEL || blobConfigured()) return NextResponse.json({ error: "Not available." }, { status: 404 });
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Sign in to upload files." }, { status: 401 });
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file." }, { status: 400 });
  const problem = fileProblem(file.name, file.size, file.type);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  const id = z.uuid().nullable();
  const links = {
    personId: id.parse(form.get("personId") || null),
    organizationId: id.parse(form.get("organizationId") || null),
    clientId: id.parse(form.get("clientId") || null),
  };
  const name = cleanFileName(file.name);
  const pathname = `${crypto.randomUUID()}${path.extname(name).slice(0, 12)}`;
  await mkdir(LOCAL_UPLOAD_DIR, { recursive: true });
  await writeFile(path.join(LOCAL_UPLOAD_DIR, pathname), Buffer.from(await file.arrayBuffer()));
  const db = await getDb();
  const [row] = await db
    .insert(schema.files)
    .values({ name, url: `local:${pathname}`, pathname, size: file.size, contentType: file.type || "application/octet-stream", uploadedBy: user.id, ...links })
    .returning({ id: schema.files.id });
  await touch(links);
  return NextResponse.json({ id: row.id });
}
