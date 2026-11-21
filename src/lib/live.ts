import "server-only";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { activeSession } from "@/lib/auth";
import { noVersions, type LiveVersions } from "@/lib/live-rules";

/**
 * The newest change in each part of the CRM, as microseconds since the epoch
 * (opaque strings to the browser; see live-rules.ts for the scopes):
 * - `records`: every record change writes an `events` row, and every note,
 *   call, text, email, meeting and task (logged by hand, by the agent or by a
 *   webhook) is an `activities` row whose `updated_at` moves on each edit.
 * - `chat`: `chat_messages.updated_at` moves when a message is posted, edited or deleted.
 * - `mail`: a conversation's `updated_at` (`inbox_threads`, `text_threads`)
 *   moves when it syncs, is read or unread, moves folder or is linked.
 * Each max reads one end of an index, so this costs well under a millisecond
 * however big the tables get. Open pages compare these with the ones they last
 * saw and refresh what moved (src/components/live-updates.tsx).
 */
const us = (t: ReturnType<typeof sql>) => sql`coalesce((extract(epoch from ${t}) * 1000000)::bigint, 0)::text`;
const versionColumns = sql`${us(sql`greatest((select max(created_at) from events), (select max(updated_at) from activities))`)} as records,
  ${us(sql`(select max(updated_at) from chat_messages)`)} as chat,
  ${us(sql`greatest((select max(updated_at) from inbox_threads), (select max(updated_at) from text_threads))`)} as mail`;

type Row = LiveVersions & { ok?: boolean };
const rowsOf = (r: unknown) => (r as { rows?: Row[] }).rows ?? (r as Row[]);
const versionsOf = (row: Row | undefined): LiveVersions => (row ? { records: String(row.records), chat: String(row.chat), mail: String(row.mail) } : noVersions);

/** The current versions. Read by the app layout before any page data, so a page never adopts a version newer than what it shows. */
export async function liveVersions(): Promise<LiveVersions> {
  const db = await getDb();
  return versionsOf(rowsOf(await db.execute(sql`select ${versionColumns}`))[0]);
}

/**
 * The poll from open pages in one statement: whether the cookie's session is
 * still good (the same check as `getUser`, through `activeSession`) and the
 * versions. One round trip.
 */
export async function liveCheck(claims: { userId: string; sid: string }): Promise<{ signedIn: boolean; versions: LiveVersions }> {
  const db = await getDb();
  const session = db
    .select({ one: sql`1` })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(activeSession(claims));
  const [row] = rowsOf(await db.execute(sql`select exists(${session}) as ok, ${versionColumns}`));
  return { signedIn: !!row?.ok, versions: versionsOf(row) };
}
