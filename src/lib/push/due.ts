import "server-only";
import { and, between, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { NotificationKind } from "@/lib/constants";
import { dayBounds } from "@/lib/crm/activities";
import { dueForReminder, GRACE_MS, isMorning, LEAD_MS } from "@/lib/notifications/schedule";
import { getWorkspace } from "@/lib/workspace";
import { deliver } from "./notify";

/**
 * Scheduled push notifications, sent by the quarter-hour cron:
 * - meetings: 15 minutes before they start (meeting_soon);
 * - tasks and planned calls with a time: 15 minutes before they're due (task_due);
 * - tasks with only a date: one summary in the morning (task_digest).
 * Each has a dedupe key, so overlapping or repeated runs send it once, and
 * the time is part of the key so rescheduling announces it again.
 */

const { activities: t, pushSubscriptions: subs } = schema;

const recordUrl = (a: { clientId: string | null; personId: string | null; organizationId: string | null }) =>
  a.clientId ? `/clients/${a.clientId}` : a.personId ? `/people/${a.personId}` : a.organizationId ? `/organizations/${a.organizationId}` : "/activities";

async function usersWanting(kind: NotificationKind) {
  const db = await getDb();
  return (
    await db
      .selectDistinct({ userId: subs.userId })
      .from(subs)
      .innerJoin(schema.users, eq(schema.users.id, subs.userId))
      .where(and(isNull(schema.users.deactivatedAt), sql`${subs.alerts} @> ${JSON.stringify([kind])}::jsonb`))
  ).map((r) => r.userId);
}

export async function sendDueNotifications(now = new Date()) {
  const db = await getDb();
  const ws = await getWorkspace();
  const tz = ws.timezone;
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  const [forMeetings, forTasks, forDigest] = await Promise.all([usersWanting("meeting_soon"), usersWanting("task_due"), usersWanting("task_digest")]);
  const counts = { meetings: 0, timed: 0, digests: 0 };

  // Meetings and timed tasks starting in the next 15 minutes (or a few minutes ago, if a run was missed).
  const timedFor = [...new Set([...forMeetings, ...forTasks])];
  if (timedFor.length) {
    const soon = await db
      .select({ id: t.id, subject: t.subject, type: t.type, dueAt: t.dueAt, assigneeId: t.assigneeId, clientId: t.clientId, personId: t.personId, organizationId: t.organizationId, clientName: schema.clients.name })
      .from(t)
      .leftJoin(schema.clients, eq(schema.clients.id, t.clientId))
      .where(and(isNull(t.completedAt), eq(t.dueHasTime, true), inArray(t.assigneeId, timedFor), between(t.dueAt, new Date(now.getTime() - GRACE_MS + 1), new Date(now.getTime() + LEAD_MS))));
    for (const a of soon) {
      if (!a.assigneeId || !a.dueAt || !dueForReminder(a.dueAt, now)) continue;
      const meeting = a.type === "meeting";
      if (!(meeting ? forMeetings : forTasks).includes(a.assigneeId)) continue;
      const what = a.subject || (meeting ? "Meeting" : a.type === "task" ? "A task" : `A ${a.type}`);
      const sent = await deliver(a.assigneeId, {
        kind: meeting ? "meeting_soon" : "task_due",
        title: meeting ? `Meeting at ${time.format(a.dueAt)}` : `Due at ${time.format(a.dueAt)}`,
        body: a.clientName && !what.includes(a.clientName) ? `${what} · ${a.clientName}` : what,
        url: recordUrl(a),
        dedupeKey: `${meeting ? "meeting" : "due"}:${a.id}:${a.dueAt.toISOString()}`,
      });
      if (sent) counts[meeting ? "meetings" : "timed"]++;
    }
  }

  // The morning summary of today's tasks with no time.
  if (forDigest.length && isMorning(now, tz)) {
    const { startOfToday, startOfTomorrow } = dayBounds(tz, now);
    const today = await db
      .select({ subject: t.subject, assigneeId: t.assigneeId })
      .from(t)
      .where(and(isNull(t.completedAt), eq(t.dueHasTime, false), ne(t.type, "meeting"), inArray(t.assigneeId, forDigest), sql`${t.dueAt} >= ${startOfToday} and ${t.dueAt} < ${startOfTomorrow}`))
      .orderBy(t.createdAt);
    const byUser = new Map<string, string[]>();
    for (const r of today) if (r.assigneeId) byUser.set(r.assigneeId, [...(byUser.get(r.assigneeId) ?? []), r.subject || "Untitled task"]);
    const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
    for (const [userId, subjects] of byUser) {
      const n = subjects.length;
      const body = subjects.slice(0, 3).join(" · ") + (n > 3 ? ` and ${n - 3} more` : "");
      if (await deliver(userId, { kind: "task_digest", title: n === 1 ? "1 task due today" : `${n} tasks due today`, body, url: "/activities", dedupeKey: `digest:${ymd}` })) counts.digests++;
    }
  }
  return counts;
}
