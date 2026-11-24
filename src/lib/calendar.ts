import "server-only";
import { and, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { activityLive } from "@/lib/crm/activity-archive";
import { zonedTime } from "@/lib/format";
import { outlookEvents, type OutlookEvent } from "@/lib/microsoft/calendar";
import { addDays } from "./calendar-week";

/**
 * Calendar: a week or a month of the team's meetings and calls. CRM meetings and
 * planned calls come from activities (everyone sees them: they're records);
 * Outlook events come live from each teammate's connected calendar, as much
 * as they share.
 */

const { activities, people, organizations, clients } = schema;

export type CrmEvent = {
  id: string;
  userId: string | null;
  type: "meeting" | "call";
  subject: string | null;
  at: string;
  minutes: number | null;
  hasTime: boolean;
  done: boolean;
  href: string | null;
  who: string | null;
};

/** The days from `from` (YYYY-MM-DD), `days` of them: a week, or the whole weeks a month grid shows. */
export async function calendarRange(input: { from: string; days: number; userIds: string[]; viewerId: string; timezone: string }) {
  const start = zonedTime(input.from, "00:00", input.timezone);
  const end = zonedTime(addDays(input.from, input.days), "00:00", input.timezone);
  const db = await getDb();
  const when = sql`coalesce(${activities.dueAt}, ${activities.occurredAt})`;
  const crmRows = input.userIds.length
    ? db
        .select({
          a: activities,
          personName: sql<string | null>`case when ${people.id} is null then null else ${people.firstName} || coalesce(' ' || ${people.lastName}, '') end`,
          organizationName: organizations.name,
          clientName: clients.name,
        })
        .from(activities)
        .leftJoin(people, eq(people.id, activities.personId))
        .leftJoin(organizations, eq(organizations.id, activities.organizationId))
        .leftJoin(clients, eq(clients.id, activities.clientId))
        .where(
          and(
            inArray(activities.assigneeId, input.userIds),
            activityLive(),
            // Meetings, logged or planned; calls only when planned (logged calls are history, not calendar).
            or(eq(activities.type, "meeting"), and(eq(activities.type, "call"), isNotNull(activities.dueAt), isNull(activities.callId))),
            gte(when, start),
            lt(when, end),
          ),
        )
        .limit(input.days > 7 ? 1500 : 500)
    : Promise.resolve([]);
  // Outlook is read at the same time as the CRM's own meetings.
  const [rows, outlook] = await Promise.all([crmRows, outlookEvents(input.userIds, start, end, input.viewerId, input.days > 7 ? 8 : 3)]);
  const crm: CrmEvent[] = rows.map(({ a, personName, organizationName, clientName }) => ({
    id: a.id,
    userId: a.assigneeId,
    type: a.type as "meeting" | "call",
    subject: a.subject,
    at: (a.dueAt ?? a.occurredAt ?? a.createdAt).toISOString(),
    minutes: a.durationMinutes,
    hasTime: a.dueAt ? a.dueHasTime : true,
    done: !!a.completedAt || !a.dueAt,
    href: a.clientId ? `/clients/${a.clientId}` : a.personId ? `/people/${a.personId}` : a.organizationId ? `/organizations/${a.organizationId}` : null,
    who: clientName ?? personName ?? organizationName,
  }));
  return { crm, outlook: await linkAttendees(outlook.events), errors: outlook.errors };
}

/** Outlook events with someone from the CRM on them link to that person. */
async function linkAttendees(events: OutlookEvent[]) {
  const emails = [...new Set(events.flatMap((e) => e.attendees))];
  if (!emails.length) return events.map((e) => ({ ...e, href: null as string | null, who: null as string | null }));
  const db = await getDb();
  const found = await db
    .select({ id: people.id, email: people.email, firstName: people.firstName, lastName: people.lastName })
    .from(people)
    .where(and(isNull(people.archivedAt), inArray(sql`lower(${people.email})`, emails)));
  const byEmail = new Map(found.map((p) => [p.email!.toLowerCase(), p]));
  return events.map((e) => {
    const p = e.attendees.map((x) => byEmail.get(x)).find(Boolean);
    return { ...e, href: p ? `/people/${p.id}` : null, who: p ? [p.firstName, p.lastName].filter(Boolean).join(" ") : null };
  });
}

export type CalendarData = Awaited<ReturnType<typeof calendarRange>>;
