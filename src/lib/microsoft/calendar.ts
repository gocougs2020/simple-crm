import "server-only";
import { after } from "next/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { appConfig } from "@/app.config";
import { getDb, schema } from "@/db";
import type { CalendarSharing } from "@/lib/constants";
import { siteOrigin } from "@/lib/origin";
import { calendarTypes, microsoftConfigured } from "./config";
import { graph, graphPages, GraphError, type ConnectedAccount } from "./graph";

/**
 * Teammates' Outlook calendars. Planned meetings (and calls, with
 * `microsoft.calendarTypes`) assigned to someone with a connected calendar are
 * copied onto it and kept in step as they're moved, reassigned or deleted.
 * Calendar shows each teammate's Outlook events next to their CRM ones, as
 * much as they chose to share.
 */

const { activities, connectedAccounts } = schema;

type ActivityRow = typeof activities.$inferSelect;

async function calendarAccount(userId: string | null) {
  if (!userId) return null;
  const db = await getDb();
  const [row] = await db
    .select()
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.provider, "microsoft"), eq(connectedAccounts.syncCalendar, true), eq(connectedAccounts.status, "active")));
  return row ?? null;
}

async function accountById(id: string | null) {
  if (!id) return null;
  const db = await getDb();
  const [row] = await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, id));
  return row?.status === "active" ? row : null;
}

/** Whether an activity belongs on its assignee's calendar: a planned meeting (or call) with a time. Done ones stay where they were. */
function wantsEvent(a: ActivityRow) {
  return (calendarTypes() as string[]).includes(a.type) && !!a.dueAt && a.dueHasTime;
}

async function eventBody(a: ActivityRow) {
  const db = await getDb();
  const [who] = a.personId
    ? await db.select({ firstName: schema.people.firstName, lastName: schema.people.lastName, email: schema.people.email }).from(schema.people).where(eq(schema.people.id, a.personId))
    : [];
  const [client] = a.clientId ? await db.select({ name: schema.clients.name }).from(schema.clients).where(eq(schema.clients.id, a.clientId)) : [];
  const name = who ? [who.firstName, who.lastName].filter(Boolean).join(" ") : null;
  const path = a.clientId ? `/clients/${a.clientId}` : a.personId ? `/people/${a.personId}` : a.organizationId ? `/organizations/${a.organizationId}` : "/activities";
  const link = `${await siteOrigin()}${path}`;
  const start = a.dueAt!;
  const end = new Date(start.getTime() + (a.durationMinutes || appConfig.microsoft.calendarDefaultMinutes) * 60_000);
  const title = a.subject || (a.type === "call" ? `Call${name ? ` with ${name}` : ""}` : `Meeting${name ? ` with ${name}` : client ? ` with ${client.name}` : ""}`);
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return {
    subject: title.slice(0, 255),
    start: { dateTime: start.toISOString().replace("Z", ""), timeZone: "UTC" },
    end: { dateTime: end.toISOString().replace("Z", ""), timeZone: "UTC" },
    // a.body is sanitized HTML from the CRM; the link back is built here.
    body: { contentType: "HTML", content: `${a.body ?? ""}<p><a href="${escape(link)}">Open in ${escape(appConfig.brand.name)}</a></p>` },
    ...(appConfig.microsoft.inviteContacts && who?.email ? { attendees: [{ emailAddress: { address: who.email, name: name ?? undefined }, type: "required" }] } : {}),
    // Lets Calendar recognize events it made, so they don't show twice.
    singleValueExtendedProperties: [{ id: CRM_PROPERTY, value: a.id }],
  };
}

/** A named property holding the CRM activity id on events the CRM made. */
const CRM_PROPERTY = "String {7d4b8a4e-3f0c-4f3e-9a51-2a7a3f6c1e11} Name crmActivityId";

/** Brings one activity's calendar event in line with it: creates, moves, updates or removes it. */
export async function syncActivityEvent(activityId: string) {
  if (!microsoftConfigured()) return;
  const db = await getDb();
  const [a] = await db.select().from(activities).where(eq(activities.id, activityId));
  if (!a) return;
  const target = wantsEvent(a) && !a.completedAt ? await calendarAccount(a.assigneeId) : null;
  const current = a.calendarEventId ? await accountById(a.calendarAccountId) : null;

  // Done, no longer timed, or on someone else's calendar now: the old event goes.
  if (a.calendarEventId && (!target || current?.id !== target.id)) {
    // A meeting that happened stays on the calendar it was on.
    if (!(a.completedAt && current && !target && wantsEvent(a))) {
      if (current) await deleteEvent(current, a.calendarEventId);
      await db.update(activities).set({ calendarEventId: null, calendarAccountId: null }).where(eq(activities.id, a.id));
      a.calendarEventId = null;
    }
  }
  if (!target) return;
  const body = await eventBody(a);
  if (a.calendarEventId) {
    try {
      await graph(target, `/me/events/${a.calendarEventId}`, { method: "PATCH", json: body });
      return;
    } catch (err) {
      // Deleted in Outlook: make it again.
      if (!(err instanceof GraphError && err.status === 404)) throw err;
    }
  }
  const created = await graph<{ id: string }>(target, "/me/events", { method: "POST", json: body });
  // Two quick changes can both get here: only one event is kept, the other is removed from the calendar.
  const [kept] = await db
    .update(activities)
    .set({ calendarEventId: created.id, calendarAccountId: target.id })
    .where(and(eq(activities.id, a.id), a.calendarEventId ? eq(activities.calendarEventId, a.calendarEventId) : isNull(activities.calendarEventId)))
    .returning({ id: activities.id });
  if (!kept) await deleteEvent(target, created.id);
}

async function deleteEvent(account: ConnectedAccount, eventId: string) {
  try {
    await graph(account, `/me/events/${eventId}`, { method: "DELETE" });
  } catch (err) {
    if (!(err instanceof GraphError && err.status === 404)) throw err;
  }
}

/** After the response: keep the activity's calendar event in step. Errors are logged, never shown, and never undo the change. */
export function calendarChanged(activityId: string) {
  if (!microsoftConfigured()) return;
  const work = () => syncActivityEvent(activityId).catch((err) => console.error("[microsoft] calendar", err));
  try {
    after(work);
  } catch {
    void work();
  }
}

/** After an activity is deleted: remove the event it had. */
export function calendarRemoved(event: { calendarEventId: string | null; calendarAccountId: string | null }) {
  if (!microsoftConfigured() || !event.calendarEventId) return;
  const work = async () => {
    const account = await accountById(event.calendarAccountId);
    if (account) await deleteEvent(account, event.calendarEventId!);
  };
  try {
    after(() => work().catch((err) => console.error("[microsoft] calendar", err)));
  } catch {
    void work();
  }
}

// ─── Reading calendars ───────────────────────────────────────────────────

export type OutlookEvent = {
  id: string;
  userId: string;
  /** Null when only free/busy is shared. */
  subject: string | null;
  location: string | null;
  start: string;
  end: string;
  allDay: boolean;
  showAs: string;
  /** Attendee addresses, for linking to people. Empty when only free/busy is shared. */
  attendees: string[];
};

type GraphEvent = {
  id: string;
  subject?: string;
  start: { dateTime: string };
  end: { dateTime: string };
  isAllDay?: boolean;
  isCancelled?: boolean;
  showAs?: string;
  sensitivity?: string;
  location?: { displayName?: string };
  attendees?: { emailAddress?: { address?: string } }[];
  singleValueExtendedProperties?: { id: string; value: string }[];
};

/**
 * Outlook events between two instants for each teammate who shares their
 * calendar, as much as each shares (`viewerId` always sees all of their own).
 * Events the CRM put there are left out: the activity already shows.
 * Read live, never stored, so it's always current and costs the database nothing.
 * `maxPages` pages of 100 per teammate: a week needs few, a month more.
 */
export async function outlookEvents(userIds: string[], start: Date, end: Date, viewerId: string, maxPages = 3): Promise<{ events: OutlookEvent[]; errors: { userId: string; message: string }[] }> {
  if (!microsoftConfigured() || !userIds.length) return { events: [], errors: [] };
  const db = await getDb();
  const accounts = await db
    .select({ account: connectedAccounts })
    .from(connectedAccounts)
    .innerJoin(schema.users, eq(schema.users.id, connectedAccounts.userId))
    .where(and(inArray(connectedAccounts.userId, userIds), eq(connectedAccounts.syncCalendar, true), isNull(schema.users.deactivatedAt)));
  const events: OutlookEvent[] = [];
  const errors: { userId: string; message: string }[] = [];
  await Promise.all(
    accounts.map(async ({ account }) => {
      const sharing: CalendarSharing = account.userId === viewerId ? "details" : account.calendarSharing;
      if (sharing === "none") return;
      if (account.status !== "active") return void errors.push({ userId: account.userId, message: "Needs reconnecting" });
      try {
        const rows = await graphPages<GraphEvent>(
          account,
          `/me/calendarView?startDateTime=${encodeURIComponent(start.toISOString())}&endDateTime=${encodeURIComponent(end.toISOString())}&$top=100&$select=subject,start,end,isAllDay,isCancelled,showAs,sensitivity,location,attendees&$expand=${encodeURIComponent(`singleValueExtendedProperties($filter=id eq '${CRM_PROPERTY}')`)}`,
          { headers: { Prefer: 'outlook.timezone="UTC"' } },
          maxPages,
        );
        for (const e of rows) {
          if (e.isCancelled || e.singleValueExtendedProperties?.length) continue;
          if (sharing === "busy" && e.showAs === "free") continue;
          // Private events show as busy to everyone else, whatever's shared.
          const details = sharing === "details" && (account.userId === viewerId || e.sensitivity !== "private");
          events.push({
            id: `${account.userId}:${e.id}`,
            userId: account.userId,
            subject: details ? (e.subject ?? "(no title)") : null,
            location: details ? (e.location?.displayName ?? null) || null : null,
            start: `${e.start.dateTime.replace(/\.\d+$/, "")}Z`,
            end: `${e.end.dateTime.replace(/\.\d+$/, "")}Z`,
            allDay: !!e.isAllDay,
            showAs: e.showAs ?? "busy",
            attendees: details ? (e.attendees ?? []).map((x) => x.emailAddress?.address?.toLowerCase() ?? "").filter(Boolean) : [],
          });
        }
      } catch (err) {
        errors.push({ userId: account.userId, message: err instanceof GraphError ? err.message : "Couldn't read the calendar" });
      }
    }),
  );
  return { events, errors };
}
