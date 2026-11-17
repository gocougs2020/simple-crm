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
  // A connection that drops is reported as an "error" event; with a listener the query rejects instead of crashing the process.
  pool.on("error", () => {});
  try {
    const db = drizzle({ client: pool, schema });
    return await db.transaction((tx) => fn(tx as unknown as Database));
  } finally {
    await pool.end().catch(() => {});
  }
}
