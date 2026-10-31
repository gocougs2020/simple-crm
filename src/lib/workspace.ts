import "server-only";
import { cache } from "react";
import { getDb, schema } from "@/db";

export type Workspace = typeof schema.workspace.$inferSelect;

/** The workspace's one settings row. Created on first read, so a fresh database never errors. */
export const getWorkspace = cache(async (): Promise<Workspace> => {
  const db = await getDb();
  const [row] = await db.select().from(schema.workspace).limit(1);
  if (row) return row;
  const [created] = await db.insert(schema.workspace).values({ id: 1 }).onConflictDoNothing().returning();
  return created ?? (await db.select().from(schema.workspace).limit(1))[0];
});
