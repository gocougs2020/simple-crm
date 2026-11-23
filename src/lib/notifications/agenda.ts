import "server-only";
import { and, asc, eq, gte, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import AgendaEmail, {
  type AgendaItem,
  type AgendaSection,
} from "@/emails/agenda";
import type { User } from "@/lib/auth";
import { emailBrand } from "@/lib/brand";
import type { EmailDigestKind } from "@/lib/constants";
import { dayBounds } from "@/lib/crm/activities";
import { activityLive } from "@/lib/crm/activity-archive";
import { sendEmail } from "@/lib/email";
import { formatDay, formatTime, personName } from "@/lib/format";
import { siteOrigin } from "@/lib/origin";
import { getWorkspace } from "@/lib/workspace";
import { agendaFor } from "./schedule";

/**
 * Agenda emails: a teammate's meetings and tasks, every weekday morning
 * (daily) and/or every Monday morning (weekly). Sent by the quarter-hour cron
 * in the workspace's time zone, once per day per teammate (a dedupe key in
 * `notifications`), and skipped when there's nothing on the agenda.
 */

const { activities: t, notifications } = schema;
/** Items per section; the rest are counted ("and 12 more"). */
const MAX_ITEMS = 25;

type Row = {
  id: string;
  subject: string | null;
  type: string;
  dueAt: Date | null;
  dueHasTime: boolean;
  clientId: string | null;
  clientName: string | null;
  personId: string | null;
  firstName: string | null;
  lastName: string | null;
  organizationId: string | null;
  orgName: string | null;
};

export type Agenda = {
  kind: EmailDigestKind;
  meetings: AgendaItem[];
  overdue: AgendaItem[];
  today: AgendaItem[];
  later: AgendaItem[];
  total: number;
};

/** What's on a teammate's plate: today's (or this week's) meetings, overdue and due-today tasks, and for the week, what's coming up. */
export async function loadAgenda(
  userId: string,
  kind: EmailDigestKind,
  now: Date,
  tz: string,
  origin: string,
): Promise<Agenda> {
  const db = await getDb();
  const { startOfToday, startOfTomorrow, endOfWeek } = dayBounds(tz, now);
  const until = kind === "weekly" ? endOfWeek : startOfTomorrow;
  // A fresh builder per query: dynamic builders change in place, so one shared builder would make every query the last one.
  const base = () =>
    db
      .select({
        id: t.id,
        subject: t.subject,
        type: t.type,
        dueAt: t.dueAt,
        dueHasTime: t.dueHasTime,
        clientId: t.clientId,
        clientName: schema.clients.name,
        personId: t.personId,
        firstName: schema.people.firstName,
        lastName: schema.people.lastName,
        organizationId: t.organizationId,
        orgName: schema.organizations.name,
      })
      .from(t)
      .leftJoin(schema.clients, eq(schema.clients.id, t.clientId))
      .leftJoin(schema.people, eq(schema.people.id, t.personId))
      .leftJoin(
        schema.organizations,
        eq(schema.organizations.id, t.organizationId),
      )
      .$dynamic();
  const mine = and(
    eq(t.assigneeId, userId),
    isNull(t.completedAt),
    isNotNull(t.dueAt),
    activityLive(),
  );
  const notMeeting = ne(t.type, "meeting");
  const [meetings, overdue, today, later] = await Promise.all([
    base()
      .where(
        and(
          mine,
          eq(t.type, "meeting"),
          gte(t.dueAt, startOfToday),
          lt(t.dueAt, until),
        ),
      )
      .orderBy(asc(t.dueAt))
      .limit(MAX_ITEMS + 1),
    base()
      .where(and(mine, notMeeting, lt(t.dueAt, startOfToday)))
      .orderBy(asc(t.dueAt))
      .limit(MAX_ITEMS + 1),
    base()
      .where(
        and(
          mine,
          notMeeting,
          gte(t.dueAt, startOfToday),
          lt(t.dueAt, startOfTomorrow),
        ),
      )
      .orderBy(sql`${t.dueHasTime} desc`, asc(t.dueAt))
      .limit(MAX_ITEMS + 1),
    kind === "weekly"
      ? base()
          .where(
            and(
              mine,
              notMeeting,
              gte(t.dueAt, startOfTomorrow),
              lt(t.dueAt, endOfWeek),
            ),
          )
          .orderBy(asc(t.dueAt))
          .limit(MAX_ITEMS + 1)
      : Promise.resolve([] as Row[]),
  ]);
  const item = (r: Row, show: "time" | "day" | "dayTime"): AgendaItem => {
    const record =
      r.clientName ??
      (r.firstName
        ? personName({ firstName: r.firstName, lastName: r.lastName })
        : null) ??
      r.orgName;
    const path = r.clientId
      ? `/clients/${r.clientId}`
      : r.personId
        ? `/people/${r.personId}`
        : r.organizationId
          ? `/organizations/${r.organizationId}`
          : "/activities";
    const due = r.dueAt!;
    const when =
      show === "time"
        ? r.dueHasTime
          ? formatTime(due, tz)
          : "Any time"
        : show === "day"
          ? formatDay(due, tz, now)
          : `${formatDay(due, tz, now)}${r.dueHasTime ? `, ${formatTime(due, tz)}` : ""}`;
    return {
      id: r.id,
      when,
      title:
        r.subject ||
        (r.type === "meeting"
          ? "Meeting"
          : r.type === "task"
            ? "Untitled task"
            : `${r.type[0].toUpperCase()}${r.type.slice(1)}`),
      record,
      url: `${origin}${path}`,
    };
  };
  const result = {
    kind,
    meetings: meetings.map((r) =>
      item(r, kind === "weekly" ? "dayTime" : "time"),
    ),
    overdue: overdue.map((r) => item(r, "day")),
    today: today.map((r) => item(r, "time")),
    later: later.map((r) => item(r, "dayTime")),
  };
  return {
    ...result,
    total:
      result.meetings.length +
      result.overdue.length +
      result.today.length +
      result.later.length,
  };
}

const count = (n: number, one: string, many: string) =>
  `${n > MAX_ITEMS ? `${MAX_ITEMS}+` : n} ${n === 1 ? one : many}`;

/** "Today: 2 meetings, 5 tasks". */
export function agendaSubject(a: Agenda) {
  const tasks = a.overdue.length + a.today.length + a.later.length;
  const parts = [
    a.meetings.length ? count(a.meetings.length, "meeting", "meetings") : null,
    tasks ? count(tasks, "task", "tasks") : null,
  ].filter(Boolean);
  return `${a.kind === "weekly" ? "Your week" : "Today"}: ${parts.join(", ") || "nothing scheduled"}`;
}

function sections(a: Agenda): AgendaSection[] {
  const cut = (items: AgendaItem[]) => ({
    items: items.slice(0, MAX_ITEMS),
    more: Math.max(0, items.length - MAX_ITEMS),
  });
  return [
    {
      title: a.kind === "weekly" ? "Meetings this week" : "Meetings today",
      ...cut(a.meetings),
    },
    { title: "Overdue", tone: "error" as const, ...cut(a.overdue) },
    { title: "Due today", ...cut(a.today) },
    ...(a.kind === "weekly"
      ? [{ title: "Later this week", ...cut(a.later) }]
      : []),
  ].filter((s) => s.items.length);
}

/** Emails one teammate their agenda. A preview goes out even when the agenda is empty, so people can see what it looks like. */
export async function sendAgenda(
  user: Pick<User, "id" | "name" | "email">,
  kind: EmailDigestKind,
  now = new Date(),
  opts: { preview?: boolean } = {},
) {
  const [ws, origin, brand] = await Promise.all([
    getWorkspace(),
    siteOrigin(),
    emailBrand(),
  ]);
  const agenda = await loadAgenda(user.id, kind, now, ws.timezone, origin);
  if (!agenda.total && !opts.preview) return { sent: false, agenda };
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: ws.timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(now);
  await sendEmail({
    to: user.email,
    subject: agendaSubject(agenda),
    react: AgendaEmail({
      brand,
      kind,
      firstName: user.name.split(" ")[0],
      date,
      sections: sections(agenda),
      appUrl: `${origin}/activities`,
      settingsUrl: `${origin}/settings/notifications`,
    }),
    tags: [{ name: "type", value: `agenda_${kind}` }],
  });
  return { sent: true, agenda };
}

/** The cron's part: everyone who wants an agenda this morning gets it, once. */
export async function sendAgendaEmails(now = new Date()) {
  const db = await getDb();
  const ws = await getWorkspace();
  const users = await db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
      prefs: schema.users.prefs,
    })
    .from(schema.users)
    .where(
      and(
        isNull(schema.users.deactivatedAt),
        isNotNull(schema.users.passwordHash),
        sql`${schema.users.prefs}->'emailDigests' is not null`,
      ),
    );
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: ws.timezone,
  }).format(now);
  let sent = 0;
  for (const user of users) {
    const kind = agendaFor(now, ws.timezone, user.prefs.emailDigests);
    if (!kind) continue;
    // Claim today's slot first, so an overlapping run can't send it twice.
    const [claim] = await db
      .insert(notifications)
      .values({
        userId: user.id,
        kind: `${kind}_email`,
        title: `${kind === "weekly" ? "Weekly" : "Daily"} agenda`,
        url: "/activities",
        dedupeKey: `agenda:${ymd}`,
      })
      .onConflictDoNothing()
      .returning({ id: notifications.id });
    if (!claim) continue;
    try {
      const r = await sendAgenda(user, kind, now);
      if (r.sent) {
        sent++;
        await db
          .update(notifications)
          .set({ title: agendaSubject(r.agenda), delivered: 1 })
          .where(eq(notifications.id, claim.id));
      }
    } catch (err) {
      // Give the slot back so the next run tries again.
      console.error("[agenda] send", err);
      await db.delete(notifications).where(eq(notifications.id, claim.id));
    }
  }
  return { agendas: sent };
}
