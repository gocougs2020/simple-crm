import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";

/**
 * The newest change anywhere in the CRM, as an opaque version string. Every
 * record change writes an `events` row, and every note, call, text, email,
 * meeting and task (logged by hand, by the agent or by a webhook) is an
 * `activities` row whose `updated_at` moves on each edit. Team chat messages
 * move `chat_messages.updated_at` when posted, edited or deleted. Each max reads one
 * end of an index, so this costs well under a millisecond however big the
 * tables get. Open pages compare it with the one they last saw and refresh
 * when it moved (src/components/live-updates.tsx).
 */
export async function latestChange(): Promise<string> {
  const db = await getDb();
  const result = await db.execute<{ v: string | null }>(
    sql`select greatest((select max(created_at) from events), (select max(updated_at) from activities), (select max(updated_at) from chat_messages))::text as v`,
  );
  const rows = (result as unknown as { rows?: { v: string | null }[] }).rows ?? (result as unknown as { v: string | null }[]);
  return rows[0]?.v ?? "";
}
