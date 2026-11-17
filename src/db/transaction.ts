import "server-only";
import { getDb, schema, type Database } from "./index";

/**
 * Runs `fn` in one transaction, for the few changes that must happen all
 * together or not at all (merging records). The app's Neon driver talks HTTP,
 * which can't hold a transaction open across round trips, so this opens a
 * short-lived WebSocket connection just for it and closes it afterwards.
 * Locally (PGlite) it's an ordinary transaction.
 */
export async function withTransaction<T>(fn: (t: Database) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) {
    const db = await getDb();
    return db.transaction((tx) => fn(tx as unknown as Database));
  }
  await getDb(); // marks the caller as per-request, like every other database call
  const { Pool } = await import("@neondatabase/serverless");
  const { drizzle } = await import("drizzle-orm/neon-serverless");
  const pool = new Pool({ connectionString: url, max: 1 });
  // A dropped WebSocket is reported as an "error" event: on the pool while a connection sits idle,
  // on the connection itself while it's checked out. With listeners on both the query rejects
  // instead of crashing the process.
  pool.on("error", () => {});
  pool.on("connect", (client: { on: (event: "error", listener: () => void) => unknown }) => client.on("error", () => {}));
  try {
    // Not drizzle's db.transaction: it sends BEGIN outside its try, so a BEGIN that fails would
    // never give the connection back and pool.end() would wait for it. This always releases it,
    // and discards it on any failure rather than reuse it (the same as scripts/dedupe.ts).
    const client = await pool.connect();
    let failure: Error | undefined;
    try {
      await client.query("begin");
      try {
        const result = await fn(drizzle({ client, schema }) as unknown as Database);
        await client.query("commit");
        return result;
      } catch (err) {
        await client.query("rollback").catch(() => {});
        throw err;
      }
    } catch (err) {
      failure = err instanceof Error ? err : new Error("The database connection closed.");
      throw err;
    } finally {
      client.release(failure);
    }
  } finally {
    await pool.end().catch(() => {});
  }
}
