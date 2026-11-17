import "server-only";
import { and, desc, eq, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { TextStatus } from "@/db/schema";
import { likeTerm } from "@/lib/crm/records";
import { digitsOf } from "@/lib/phone/numbers";
import { conversationOwner, unreadFor } from "./read-state";

/** Text conversations for the Messages page, with each one's unread as the viewing teammate sees it. */

const { textThreads, textMessages, people, organizations, clients, phoneNumbers } = schema;

export type TextFilter = "all" | "unread" | "mine" | "unknown";

const personName = sql<string | null>`case when ${people.id} is null then null else ${people.firstName} || coalesce(' ' || ${people.lastName}, '') end`;

/** The latest text that wasn't deleted from a record (emptied), for the list's preview. */
const latest = sql<{ body: string; direction: "inbound" | "outbound"; media: number; status: TextStatus } | null>`(
  select json_build_object('body', m.body, 'direction', m.direction, 'media', jsonb_array_length(m.media), 'status', m.status)
  from text_messages m
  where m.thread_id = "text_threads"."id" and m.campaign_id is null and (m.body <> '' or jsonb_array_length(m.media) > 0)
  order by m.created_at desc limit 1)`;

export async function listTextThreads(userId: string, opts: { q?: string; filter?: TextFilter; limit?: number } = {}) {
  const db = await getDb();
  const where: SQL[] = [isNotNull(textThreads.lastMessageAt)];
  if (opts.filter === "unread") where.push(unreadFor("text_threads", userId));
  if (opts.filter === "mine") where.push(sql`${conversationOwner("text_threads")} = ${userId}`);
  if (opts.filter === "unknown") where.push(isNull(textThreads.personId), isNull(textThreads.organizationId));
  const q = opts.q?.trim();
  if (q) {
    const term = likeTerm(q);
    const digits = digitsOf(q);
    where.push(
      or(
        sql`(${people.firstName} || coalesce(' ' || ${people.lastName}, '')) ilike ${term}`,
        sql`${organizations.name} ilike ${term}`,
        sql`${clients.name} ilike ${term}`,
        digits.length >= 3 ? sql`${textThreads.remoteKey} like ${`%${digits.slice(-10)}%`}` : undefined,
        sql`exists (select 1 from text_messages m where m.thread_id = "text_threads"."id" and m.body ilike ${term})`,
      )!,
    );
  }
  const rows = await db
    .select({
      id: textThreads.id,
      remote: textThreads.remote,
      read: textThreads.read,
      lastMessageAt: textThreads.lastMessageAt,
      personId: textThreads.personId,
      personName,
      organizationId: textThreads.organizationId,
      organizationName: organizations.name,
      clientName: clients.name,
      numberLabel: phoneNumbers.label,
      ownerId: conversationOwner("text_threads"),
      unread: unreadFor("text_threads", userId),
      latest,
    })
    .from(textThreads)
    .leftJoin(people, eq(people.id, textThreads.personId))
    .leftJoin(organizations, eq(organizations.id, textThreads.organizationId))
    .leftJoin(clients, eq(clients.id, textThreads.clientId))
    .leftJoin(phoneNumbers, eq(phoneNumbers.id, textThreads.phoneNumberId))
    .where(and(...where))
    .orderBy(desc(textThreads.lastMessageAt))
    .limit(opts.limit ?? 200);
  return rows.map((r) => ({ ...r, lastMessageAt: r.lastMessageAt?.toISOString() ?? null }));
}

export type TextThreadRow = Awaited<ReturnType<typeof listTextThreads>>[number];

/** One conversation and its texts, oldest first (the latest 500). */
export async function getTextThread(threadId: string) {
  const db = await getDb();
  const [t] = await db
    .select({
      thread: textThreads,
      personName,
      textOptOutAt: people.textOptOutAt,
      organizationName: organizations.name,
      number: { id: phoneNumbers.id, label: phoneNumbers.label, number: phoneNumbers.number, archivedAt: phoneNumbers.archivedAt },
      ownerId: conversationOwner("text_threads"),
    })
    .from(textThreads)
    .leftJoin(people, eq(people.id, textThreads.personId))
    .leftJoin(organizations, eq(organizations.id, textThreads.organizationId))
    .leftJoin(phoneNumbers, eq(phoneNumbers.id, textThreads.phoneNumberId))
    .where(eq(textThreads.id, threadId));
  if (!t) return null;
  const recent = await db
    .select({
      id: textMessages.id,
      direction: textMessages.direction,
      body: textMessages.body,
      media: textMessages.media,
      status: textMessages.status,
      error: textMessages.error,
      userId: textMessages.userId,
      campaignId: textMessages.campaignId,
      campaignName: schema.campaigns.name,
      createdAt: textMessages.createdAt,
    })
    .from(textMessages)
    .leftJoin(schema.campaigns, eq(schema.campaigns.id, textMessages.campaignId))
    .where(eq(textMessages.threadId, t.thread.id))
    .orderBy(desc(textMessages.createdAt))
    .limit(500);
  return {
    id: t.thread.id,
    remote: t.thread.remote,
    read: t.thread.read,
    ownerId: t.ownerId,
    personId: t.thread.personId,
    personName: t.personName,
    organizationId: t.thread.organizationId,
    organizationName: t.organizationName,
    clientId: t.thread.clientId,
    optedOut: !!t.textOptOutAt,
    number: t.number?.id && !t.number.archivedAt ? { id: t.number.id, label: t.number.label, number: t.number.number } : null,
    messages: recent.reverse().map((m) => ({ ...m, deleted: !m.body && !m.media.length, createdAt: m.createdAt.toISOString() })),
  };
}

export type OpenTextThread = NonNullable<Awaited<ReturnType<typeof getTextThread>>>;

/** Conversations unread for this teammate, for the sidebar badge. */
export async function unreadTextCount(userId: string) {
  const db = await getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(textThreads)
    .where(and(isNotNull(textThreads.lastMessageAt), unreadFor("text_threads", userId)));
  return row?.n ?? 0;
}
