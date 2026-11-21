import "server-only";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { activeSession } from "@/lib/auth";

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
const newest = sql`greatest((select max(created_at) from events), (select max(updated_at) from activities), (select max(updated_at) from chat_messages))::text`;

/**
 * The poll from open pages in one statement: whether the cookie's session is
 * still good (the same check as `getUser`, through `activeSession`) and the
 * newest change's version. One round trip instead of two.
 */
export async function liveCheck(claims: { userId: string; sid: string }): Promise<{ signedIn: boolean; v: string }> {
  const db = await getDb();
  const session = db
    .select({ one: sql`1` })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(activeSession(claims));
  const result = await db.execute(sql`select exists(${session}) as ok, ${newest} as v`);
  const [row] = (result as unknown as { rows?: { ok: boolean; v: string | null }[] }).rows ?? (result as unknown as { ok: boolean; v: string | null }[]);
  return { signedIn: !!row?.ok, v: row?.v ?? "" };
}
