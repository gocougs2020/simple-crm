import "server-only";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { ActivityType, EntityType } from "@/lib/constants";
import { zonedTime } from "@/lib/format";

const zonedMidnight = (ymd: string, tz: string) => zonedTime(ymd, "00:00", tz);

const { activities, events, files, people, organizations, deals } = schema;

export type ActivityRow = Awaited<ReturnType<typeof activityRows>>[number];

/** Activities with the names of what they're linked to, for timelines and lists. */
function activityRows(where: SQL | undefined, opts: { order: SQL[]; limit: number }) {
  return getDb().then((db) =>
    db
      .select({
        activity: activities,
        personName: sql<string | null>`case when ${people.id} is null then null else ${people.firstName} || coalesce(' ' || ${people.lastName}, '') end`,
        organizationName: organizations.name,
        dealTitle: deals.title,
        emailCc: schema.outboundEmails.cc,
        emailTo: schema.outboundEmails.to,
      })
      .from(activities)
      .leftJoin(people, eq(people.id, activities.personId))
      .leftJoin(organizations, eq(organizations.id, activities.organizationId))
      .leftJoin(deals, eq(deals.id, activities.dealId))
      .leftJoin(schema.outboundEmails, eq(schema.outboundEmails.id, activities.emailId))
      .where(where)
      .orderBy(...opts.order)
      .limit(opts.limit),
  );
}

const linkColumn = { person: activities.personId, organization: activities.organizationId, deal: activities.dealId };

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
      .where(and(eq(entity === "person" ? files.personId : entity === "organization" ? files.organizationId : files.dealId, id), isNull(files.deletedAt)))
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

/** Open deals with nothing planned, oldest stage change first: the ones slipping through the cracks. */
export async function dealsWithoutNextStep(limit = 6) {
  const db = await getDb();
  return db
    .select({ id: deals.id, title: deals.title, value: deals.value, ownerId: deals.ownerId, stageChangedAt: deals.stageChangedAt, organizationName: organizations.name })
    .from(deals)
    .leftJoin(organizations, eq(organizations.id, deals.organizationId))
    .where(
      and(
        eq(deals.status, "open"),
        isNull(deals.archivedAt),
        sql`not exists (select 1 from activities a where a.deal_id = ${deals.id} and a.completed_at is null and a.due_at is not null)`,
      ),
    )
    .orderBy(asc(deals.stageChangedAt))
    .limit(limit);
}

/** Won this month and open pipeline, for the home page header. */
export async function dealStats(tz: string) {
  const db = await getDb();
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" }).format(new Date());
  const monthStart = zonedMidnight(`${ymd}-01`, tz);
  const [row] = await db
    .select({
      openCount: sql<number>`count(*) filter (where ${deals.status} = 'open')::int`,
      openValue: sql<number>`coalesce(sum(${deals.value}) filter (where ${deals.status} = 'open'), 0)::bigint`,
      wonCount: sql<number>`count(*) filter (where ${deals.status} = 'won' and ${deals.closedAt} >= ${monthStart})::int`,
      wonValue: sql<number>`coalesce(sum(${deals.value}) filter (where ${deals.status} = 'won' and ${deals.closedAt} >= ${monthStart}), 0)::bigint`,
    })
    .from(deals)
    .where(isNull(deals.archivedAt));
  return { ...row, openValue: Number(row.openValue), wonValue: Number(row.wonValue) };
}
