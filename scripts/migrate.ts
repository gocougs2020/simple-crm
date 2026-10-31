// Applies drizzle/ migrations to Neon during `vercel build`. Skipped when no
// database is configured (local dev migrates the embedded PGlite on first use).
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;

async function main() {
  if (!url) {
    console.log("[migrate] No DATABASE_URL; skipping.");
    return;
  }
  await migrate(drizzle({ client: neon(url) }), { migrationsFolder: "drizzle" });
  console.log("[migrate] Database is up to date.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
