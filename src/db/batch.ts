import "server-only";
import type { BatchItem } from "drizzle-orm/batch";
import { runBatch, type Batchable } from "./batch-core";
import { getDb, type Database } from "./index";

/**
 * Writes that belong together (a record's update and its history entry), in
 * one round trip and one transaction (src/db/batch-core.ts). Not for long
 * work: `withTransaction` (src/db/transaction.ts) is for the rare merges.
 */
export async function writeBatch(build: (db: Database) => BatchItem<"pg">[]) {
  const db = await getDb();
  await runBatch(db as unknown as Database & Batchable<Database>, build);
}
