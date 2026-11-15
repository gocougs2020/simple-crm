import "server-only";
import { and, between, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { dayBounds } from "@/lib/crm/activities";
import { getWorkspace } from "@/lib/workspace";
import { deliver } from "./notify";

/**
 * "Tasks coming due" notifications, sent by the quarter-hour cron:
 * - a task with a time: once, in the quarter hour before it's due (or just after, if a run was missed);
 * - tasks with only a date: one morning summary, from 8 AM in the workspace's time zone.
 * Each notification has a dedupe key, so overlapping or repeated runs send it once.
 */

const BEFORE_MS = 15 * 60_000;
const LATE_MS = 20 * 60_000;
const MORNING_HOUR = 8;

const { activities: t, pushSubscriptions: subs } = schema;

export async function sendDueNotifications(now = new Date()) {
  const db = await getDb();
  const wanting = (await db.selectDistinct({ userId: subs.userId }).from(subs).where(sql`${subs.alerts} @> '["task_due"]'::jsonb`)).map((r) => r.userId);
  if (!wanting.length) return { timed: 0, digests: 0 };
  const ws = await getWorkspace();
  const tz = ws.timezone;
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  const open = and(isNull(t.completedAt), inArray(t.assigneeId, wanting));

  const timed = await db
    .select({ id: t.id, subject: t.subject, type: t.type, dueAt: t.dueAt, assigneeId: t.assigneeId, clientId: t.clientId, personId: t.personId, organizationId: t.organizationId })
    .from(t)
    .where(and(open, eq(t.dueHasTime, true), between(t.dueAt, new Date(now.getTime() - LATE_MS), new Date(now.getTime() + BEFORE_MS))));
  let sent = 0;
  for (const task of timed) {
    if (!task.assigneeId || !task.dueAt) continue;
    const url = task.clientId ? `/clients/${task.clientId}` : task.personId ? `/people/${task.personId}` : task.organizationId ? `/organizations/${task.organizationId}` : "/activities";
    const what = task.subject || (task.type === "task" ? "A task" : `A ${task.type}`);
    // The due time is in the key: rescheduling a task notifies again at its new time.
    sent += (await deliver(task.assigneeId, { kind: "task_due", title: `Due at ${time.format(task.dueAt)}`, body: what, url, dedupeKey: `due:${task.id}:${task.dueAt.toISOString()}` })) ? 1 : 0;
  }

  let digests = 0;
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(now));
  if (hour >= MORNING_HOUR && hour < 12) {
    const { startOfToday, startOfTomorrow } = dayBounds(tz, now);
    const today = await db
      .select({ subject: t.subject, assigneeId: t.assigneeId })
      .from(t)
      .where(and(open, eq(t.dueHasTime, false), sql`${t.dueAt} >= ${startOfToday} and ${t.dueAt} < ${startOfTomorrow}`))
      .orderBy(t.createdAt);
    const byUser = new Map<string, string[]>();
    for (const r of today) if (r.assigneeId) byUser.set(r.assigneeId, [...(byUser.get(r.assigneeId) ?? []), r.subject || "Untitled task"]);
    const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
    for (const [userId, subjects] of byUser) {
      const n = subjects.length;
      const body = subjects.slice(0, 3).join(" · ") + (n > 3 ? ` and ${n - 3} more` : "");
      digests += (await deliver(userId, { kind: "task_due", title: n === 1 ? "1 task due today" : `${n} tasks due today`, body, url: "/activities", dedupeKey: `digest:${ymd}` })) ? 1 : 0;
    }
  }
  return { timed: sent, digests };
}
