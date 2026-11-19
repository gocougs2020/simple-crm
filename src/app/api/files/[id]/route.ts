import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { getUser } from "@/lib/auth";
import { fileResponse } from "@/lib/file-response";

/**
 * Downloads a file after checking the session: the team link to any file,
 * internal or public. Public files also open for anyone at /share/<token>.
 */
export async function GET(request: Request, { params }: RouteContext<"/api/files/[id]">) {
  const user = await getUser();
  if (!user) return new NextResponse("Sign in to download files.", { status: 401 });
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return new NextResponse("Not found", { status: 404 });
  const db = await getDb();
  const [f] = await db.select().from(schema.files).where(eq(schema.files.id, id));
  if (!f || f.deletedAt) return new NextResponse("This file was removed.", { status: 404 });
  return fileResponse(f, { download: new URL(request.url).searchParams.has("download") });
}
