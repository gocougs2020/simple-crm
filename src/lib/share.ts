import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { fileRow } from "@/lib/crm/files";

/** The public file a share link points to, or null when it's internal again, removed, or the link is wrong. */
export async function sharedFile(token: string) {
  if (!/^[\w-]{20,64}$/.test(token)) return null;
  const db = await getDb();
  const [f] = await db
    .select(fileRow)
    .from(schema.files)
    .where(and(eq(schema.files.publicToken, token), isNull(schema.files.deletedAt)));
  return f ?? null;
}
