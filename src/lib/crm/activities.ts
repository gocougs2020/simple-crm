import "server-only";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { ActivityType, EntityType } from "@/lib/constants";
import { zonedTime } from "@/lib/format";

const zonedMidnight = (ymd: string, tz: string) => zonedTime(ymd, "00:00", tz);

const { activities, events, files, people, organizations, clients } = schema;

export type ActivityRow = Awaited<ReturnType<typeof activityRows>>[number];

/** Activities with the names of what they're linked to, for timelines and lists. */
function activityRows(where: SQL | undefined, opts: { order: SQL[]; limit: number }) {
  return getDb().then((db) =>
    db
      .select({
        activity: activities,
        personName: sql<string | null>`case when ${people.id} is null then null else ${people.firstName} || coalesce(' ' || ${people.lastName}, '') end`,
        organizationName: organizations.name,
        clientName: clients.name,
        emailCc: schema.outboundEmails.cc,
        emailTo: schema.outboundEmails.to,
        /** For mail in a connected inbox: who sent it, and which inbox it's in. */
        inboxFrom: sql<string | null>`(select m."from" from inbox_messages m where m.activity_id = ${activities.id} limit 1)`,
        inboxTo: sql<string[] | null>`(select m."to" from inbox_messages m where m.activity_id = ${activities.id} limit 1)`,
        inboxAddress: schema.inboxThreads.inboxAddress,
      })
      .from(activities)
      .leftJoin(people, eq(people.id, activities.personId))
      .leftJoin(organizations, eq(organizations.id, activities.organizationId))
      .leftJoin(clients, eq(clients.id, activities.clientId))
      .leftJoin(schema.outboundEmails, eq(schema.outboundEmails.id, activities.emailId))
      .leftJoin(schema.inboxThreads, eq(schema.inboxThreads.id, activities.inboxThreadId))
      .where(where)
      .orderBy(...opts.order)
      .limit(opts.limit),
  );
}

const linkColumn = { person: activities.personId, organization: activities.organizationId, client: activities.clientId };

/** One entry on a record's timeline: something someone logged, something that changed, or a file. */
export type TimelineItem =
  | { kind: "activity"; at: string; row: ActivityRow }
  | { kind: "event"; at: string; event: typeof events.$inferSelect }
  | { kind: "file"; at: string; file: typeof files.$inferSelect };

/**
 * A record's whole story, newest first: logged activities (by when they
 * happened), changes, and files. Open tasks are returned separately as
 * "planned", soonest first, because they're about the future.
 */
export async function timeline(entity: EntityType, id: string) {
  const db = await getDb();
  const link = linkColumn[entity];
  const [planned, done, history, attached] = await Promise.all([
    activityRows(and(eq(link, id), isNull(activities.completedAt), isNotNull(activities.dueAt)), { order: [asc(activities.dueAt)], limit: 100 }),
    activityRows(and(eq(link, id), or(isNotNull(activities.completedAt), isNull(activities.dueAt))), {
      order: [desc(activities.pinned), desc(sql`coalesce(${activities.occurredAt}, ${activities.completedAt}, ${activities.createdAt})`)],
      limit: 300,
    }),
    db
      .select()
      .from(events)
      .where(and(eq(events.entityType, entity), eq(events.entityId, id)))
      .orderBy(desc(events.createdAt))
      .limit(200),
    db
      .select()
      .from(files)
      .where(and(eq(entity === "person" ? files.personId : entity === "organization" ? files.organizationId : files.clientId, id), isNull(files.deletedAt)))
      .orderBy(desc(files.createdAt)),
  ]);
  const past: TimelineItem[] = [
    ...done.map((row): TimelineItem => ({ kind: "activity", at: (row.activity.occurredAt ?? row.activity.completedAt ?? row.activity.createdAt).toISOString(), row })),
    ...history.map((event): TimelineItem => ({ kind: "event", at: event.createdAt.toISOString(), event })),
    ...attached.map((file): TimelineItem => ({ kind: "file", at: file.createdAt.toISOString(), file })),
  ];
  const pinned = past.filter((i) => i.kind === "activity" && i.row.activity.pinned);
  const rest = past.filter((i) => !(i.kind === "activity" && i.row.activity.pinned)).sort((a, b) => b.at.localeCompare(a.at));
  return { planned, pinned, past: rest, files: attached };
}

export type ActivityFilter = {
  assigneeId?: string;
  status: "todo" | "done";
  types?: ActivityType[];
  /** "overdue" | "today" | "week" — only for open items. */
  range?: string;
};

/** The Activities page: open tasks and planned calls and meetings, or finished ones. */
export async function listActivities(f: ActivityFilter, tz: string) {
  const where: SQL[] = [];
  if (f.assigneeId) where.push(eq(activities.assigneeId, f.assigneeId));
  if (f.types?.length) where.push(inArray(activities.type, f.types));
  if (f.status === "todo") {
    where.push(isNull(activities.completedAt), isNotNull(activities.dueAt));
    const { startOfToday, startOfTomorrow, endOfWeek } = dayBounds(tz);
    if (f.range === "overdue") where.push(lt(activities.dueAt, startOfToday));
    if (f.range === "today") where.push(and(gte(activities.dueAt, startOfToday), lt(activities.dueAt, startOfTomorrow))!);
    if (f.range === "week") where.push(lt(activities.dueAt, endOfWeek));
    return activityRows(and(...where), { order: [asc(activities.dueAt)], limit: 500 });
  }
  where.push(or(isNotNull(activities.completedAt), isNull(activities.dueAt))!);
  return activityRows(and(...where), { order: [desc(sql`coalesce(${activities.completedAt}, ${activities.occurredAt}, ${activities.createdAt})`)], limit: 200 });
}

/** Recent interactions and notes from everyone, for the home page feed. */
export async function teamFeed(limit = 25) {
  return activityRows(or(isNotNull(activities.completedAt), isNull(activities.dueAt)), {
    order: [desc(sql`coalesce(${activities.occurredAt}, ${activities.completedAt}, ${activities.createdAt})`)],
    limit,
  });
}

/** Counts for the sidebar badge: the viewer's overdue and due-today items. */
export async function myDueCounts(userId: string, tz: string) {
  const db = await getDb();
  const { startOfToday, startOfTomorrow } = dayBounds(tz);
  const [row] = await db
    .select({
      overdue: sql<number>`count(*) filter (where ${activities.dueAt} < ${startOfToday})::int`,
      today: sql<number>`count(*) filter (where ${activities.dueAt} >= ${startOfToday} and ${activities.dueAt} < ${startOfTomorrow})::int`,
    })
    .from(activities)
    .where(and(eq(activities.assigneeId, userId), isNull(activities.completedAt), isNotNull(activities.dueAt)));
  return row;
}

/** Midnight today, tomorrow, and the end of the 7th day, in the workspace's time zone, as UTC instants. */
export function dayBounds(tz: string, now = new Date()) {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const startOfToday = zonedMidnight(ymd, tz);
  const plusDays = (n: number) => {
    const d = new Date(`${ymd}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return zonedMidnight(d.toISOString().slice(0, 10), tz);
  };
  return { startOfToday, startOfTomorrow: plusDays(1), endOfWeek: plusDays(7) };
}

/** Prospects and current clients with nothing planned, longest-waiting first: the ones slipping through the cracks. */
export async function clientsWithoutNextStep(limit = 6) {
  const db = await getDb();
  return db
    .select({ id: clients.id, name: clients.name, category: clients.category, value: clients.value, ownerId: clients.ownerId, stageChangedAt: clients.stageChangedAt, organizationName: organizations.name })
    .from(clients)
    .leftJoin(organizations, eq(organizations.id, clients.organizationId))
    .where(
      and(
        inArray(clients.category, ["prospective", "current"]),
        isNull(clients.archivedAt),
        sql`not exists (select 1 from activities a where a.client_id = ${clients.id} and a.completed_at is null and a.due_at is not null)`,
      ),
    )
    .orderBy(asc(clients.stageChangedAt))
    .limit(limit);
}

/** The home page header: prospects and their value, current clients and their monthly revenue, and who signed or left this month. */
export async function clientStats(tz: string) {
  const db = await getDb();
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" }).format(new Date());
  const monthStart = `${ymd}-01`;
  const [row] = await db
    .select({
      prospectCount: sql<number>`count(*) filter (where ${clients.category} = 'prospective')::int`,
      prospectValue: sql<number>`coalesce(sum(${clients.value}) filter (where ${clients.category} = 'prospective'), 0)::bigint`,
      currentCount: sql<number>`count(*) filter (where ${clients.category} = 'current')::int`,
      signedThisMonth: sql<number>`count(*) filter (where ${clients.category} = 'current' and ${clients.startedOn} >= ${monthStart})::int`,
      leftThisMonth: sql<number>`count(*) filter (where ${clients.category} = 'past' and ${clients.endedOn} >= ${monthStart})::int`,
      mrr: sql<number>`(
        select coalesce(round(sum(case cs.interval when 'month' then cs.price when 'quarter' then cs.price / 3.0 when 'year' then cs.price / 12.0 else 0 end)), 0)::bigint
        from client_services cs join clients c on c.id = cs.client_id
        where c.category = 'current' and c.archived_at is null and (cs.ended_on is null or cs.ended_on > current_date)
      )`,
    })
    .from(clients)
    .where(isNull(clients.archivedAt));
  return { ...row, prospectValue: Number(row.prospectValue), mrr: Number(row.mrr) };
}
