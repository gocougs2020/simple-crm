import "server-only";
import { sql } from "drizzle-orm";
import { cache } from "react";
import { getDb } from "@/db";
import type { User } from "@/lib/auth";
import { unreadFor } from "@/lib/conversations/read-state";
import { dayBounds } from "@/lib/crm/activities";
import { emailConfigured } from "@/lib/email";
import { phoneConfigured } from "@/lib/twilio/config";

/** The sidebar's badges: what's due, unread email and texts, and team chat since the teammate last had it open. */
export type SidebarCounts = {
  due: { overdue: number; today: number };
  unread: number;
  unreadTexts: number;
  chat: { unread: number; mentions: number };
};

export const noCounts: SidebarCounts = { due: { overdue: 0, today: 0 }, unread: 0, unreadTexts: 0, chat: { unread: 0, mentions: 0 } };

const rowsOf = <T>(r: unknown) => ((r as { rows?: T[] }).rows ?? (r as T[]));

/**
 * Every badge in one statement, so the sidebar costs one round trip. Each
 * count is the same query it was on its own (myDueCounts, unreadCount,
 * unreadTextCount, the chat count) as a scalar subquery. Cached per request
 * on primitives, so the layout and a page asking for the same counts share it.
 */
const countsFor = cache(async (userId: string, tz: string, chatSince: string, email: boolean, phone: boolean): Promise<SidebarCounts> => {
  const db = await getDb();
  const { startOfToday, startOfTomorrow } = dayBounds(tz);
  const planned = sql`a.assignee_id = ${userId} and a.completed_at is null and a.due_at is not null`;
  const result = await db.execute(sql`select
    (select count(*) from activities a where ${planned} and a.due_at < ${startOfToday})::int as overdue,
    (select count(*) from activities a where ${planned} and a.due_at >= ${startOfToday} and a.due_at < ${startOfTomorrow})::int as today,
    ${email ? sql`(select count(*) from inbox_threads where inbox_threads.folder = 'inbox' and ${unreadFor("inbox_threads", userId)} and inbox_threads.last_message_at >= ${new Date(Date.now() - 90 * 86400_000)})::int` : sql`0`} as unread,
    ${phone ? sql`(select count(*) from text_threads where text_threads.last_message_at is not null and ${unreadFor("text_threads", userId)})::int` : sql`0`} as unread_texts,
    (select count(*) from chat_messages c where c.deleted_at is null and c.user_id <> ${userId} and c.created_at > ${chatSince}::timestamptz)::int as chat_unread,
    (select count(*) from chat_messages c where c.deleted_at is null and c.user_id <> ${userId} and c.created_at > ${chatSince}::timestamptz and ${userId}::uuid = any(c.mentions))::int as chat_mentions`);
  const [r] = rowsOf<Record<"overdue" | "today" | "unread" | "unread_texts" | "chat_unread" | "chat_mentions", number | string>>(result);
  const n = (v: number | string | undefined) => Number(v ?? 0);
  return {
    due: { overdue: n(r?.overdue), today: n(r?.today) },
    unread: n(r?.unread),
    unreadTexts: n(r?.unread_texts),
    chat: { unread: n(r?.chat_unread), mentions: n(r?.chat_mentions) },
  };
});

/**
 * The signed-in teammate's badges, in the viewer's time zone. Takes the user
 * row already loaded for the request: the chat count starts from its
 * `chat_read_at` (or when they joined) without reading it again.
 */
export function sidebarCounts(user: Pick<User, "id" | "chatReadAt" | "createdAt">, tz: string) {
  return countsFor(user.id, tz, (user.chatReadAt ?? user.createdAt).toISOString(), emailConfigured(), phoneConfigured());
}
