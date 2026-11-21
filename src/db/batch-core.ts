import type { BatchItem } from "drizzle-orm/batch";

/** What `runBatch` needs from a database: Neon's HTTP driver has `batch`; PGlite has only transactions. */
export type Batchable<D> = {
  batch?: (items: readonly [BatchItem<"pg">, ...BatchItem<"pg">[]]) => Promise<unknown>;
  transaction: <T>(fn: (tx: D) => Promise<T>) => Promise<T>;
};

/**
 * Runs statements that belong together as one transaction. Where the driver
 * can batch (Neon over HTTP) they go in one request; otherwise (PGlite in
 * local development) they run in order inside a transaction. `build` makes
 * the statements on the database it's handed, so they run inside the
 * transaction there. Nothing to run, nothing sent.
 */
export async function runBatch<D extends Batchable<D>>(db: D, build: (db: D) => BatchItem<"pg">[]) {
  if (typeof db.batch === "function") {
    const items = build(db);
    if (!items.length) return;
    await db.batch(items as [BatchItem<"pg">, ...BatchItem<"pg">[]]);
    return;
  }
  await db.transaction(async (tx) => {
    for (const q of build(tx)) await q;
  });
}
