import "server-only";
import { connection } from "next/server";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;

const globalForDb = globalThis as unknown as { __crmDb?: Promise<Database> };

/**
 * Neon (serverless Postgres from the Vercel Marketplace) in deployed
 * environments. Without DATABASE_URL, local development falls back to an
 * embedded PGlite database in .data/ so the whole app runs with zero setup.
 */
async function connect(): Promise<Database> {
  if (databaseUrl) {
    const { neon } = await import("@neondatabase/serverless");
    const { drizzle } = await import("drizzle-orm/neon-http");
    return drizzle({ client: neon(databaseUrl), schema }) as unknown as Database;
  }

  if (process.env.VERCEL) {
    throw new Error("DATABASE_URL is not set. Add a Neon database from the Vercel Marketplace.");
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(".data", { recursive: true });
  const client = new PGlite(".data/pglite");
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: "drizzle" });
  return db as unknown as Database;
}

/**
 * The database for this request. Every read in this app is per-request (it's
 * all behind a login), so this also marks the caller as dynamic for Cache
 * Components: nothing that touches the database is prerendered.
 */
export async function getDb(): Promise<Database> {
  await connection();
  // Don't cache a failed connection; the next call retries.
  globalForDb.__crmDb ??= connect().catch((err) => {
    globalForDb.__crmDb = undefined;
    throw err;
  });
  return globalForDb.__crmDb;
}

export { schema };
