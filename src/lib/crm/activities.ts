import "server-only";
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNotNull, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { interactionTypes, monthlyPriceSql, type ActivityType, type EntityType } from "@/lib/constants";
import { ActionError } from "@/lib/auth";
import { zonedTime } from "@/lib/format";
import { inRecordView, onRecord } from "@/lib/crm/files";
import { privateMailCount, privateMailOn, type PrivateMail } from "@/lib/microsoft/mail";

const zonedMidnight = (ymd: string, tz: string) => zonedTime(ymd, "00:00", tz);

const { activities, events, files, people, organizations, clients } = schema;

export type ActivityRow = Awaited<ReturnType<typeof activityRows>>[number];
/** A reply under a note (note_replies), as the timeline reads it: `createdAt` is an ISO string. */
export type NoteReply = { id: string; body: string; userId: string | null; apiKeyId: string | null; createdAt: string };

/**
 * Leaves out emails and texts a campaign sent. They're on each person's
 * timeline, but they aren't contact: they don't move "last contacted" or fill the feeds.
 */
const notCampaignEmail = sql`not exists (select 1 from outbound_emails oe where oe.id = ${activities.emailId} and oe.campaign_id is not null) and not exists (select 1 from text_messages tm where tm.id = ${activities.textMessageId} and tm.campaign_id is not null)`;

/** How much of a body a list shows before "Show more" fetches the rest. */
const PREVIEW_CHARS = 400;
/** A body as plain text: tags dropped, the usual entities read, spaces collapsed. */
const plainBody = sql`trim(regexp_replace(replace(replace(replace(replace(replace(replace(regexp_replace(${activities.body}, '<[^>]*>', ' ', 'g'), '&nbsp;', ' '), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''), '&amp;', '&'), '\\s+', ' ', 'g'))`;

/**
 * Activities with the names of what they're linked to, for timelines and
 * lists. With `preview` (lists: the Activities page, the home feed) the HTML
 * body stays on the server: `activity.body` is null and `preview` holds the
 * start of it as plain text, with `more` when there's more to see (longer,
 * or formatted) for "Show more" to fetch.
 */
function activityRows(where: SQL | undefined, opts: { order: SQL[]; limit: number; preview?: boolean }) {
  return getDb().then((db) =>
    db
      .select({
        activity: opts.preview ? { ...getTableColumns(activities), body: sql<string | null>`null` } : activities,
        preview: opts.preview
          ? sql<{ text: string; more: boolean } | null>`case when ${activities.body} is null or ${activities.body} = '' then null else json_build_object('text', left(${plainBody}, ${PREVIEW_CHARS}), 'more', length(${plainBody}) > ${PREVIEW_CHARS} or ${activities.body} ~ '<(a|ul|ol|strong|em|b|i|h[1-6]|img|table|blockquote)[ >]') end`
          : sql<{ text: string; more: boolean } | null>`null`,
        personName: sql<string | null>`case when ${people.id} is null then null else ${people.firstName} || coalesce(' ' || ${people.lastName}, '') end`,
        organizationName: organizations.name,
        clientName: clients.name,
        emailCc: schema.outboundEmails.cc,
        emailTo: schema.outboundEmails.to,
        emailReplyTo: schema.outboundEmails.replyTo,
        emailAttachments: schema.outboundEmails.attachments,
        /** Where the email got to, from Resend's delivery reports. */
        delivery: {
          status: schema.outboundEmails.deliveryStatus,
          at: schema.outboundEmails.deliveryStatusAt,
          detail: schema.outboundEmails.deliveryDetail,
          /** Only filled in when this deployment tracks opens / clicks (`email` in app.config.ts). */
          openedAt: schema.outboundEmails.firstOpenedAt,
          opens: schema.outboundEmails.openCount,
          clickedAt: schema.outboundEmails.firstClickedAt,
          clicks: schema.outboundEmails.clickCount,
        },
        campaignId: schema.campaigns.id,
        campaignName: schema.campaigns.name,
        /** Calls through the team's numbers (Twilio): how it went. */
        call: { status: schema.phoneCalls.status, seconds: schema.phoneCalls.durationSeconds, from: schema.phoneCalls.from, to: schema.phoneCalls.to, forwardedTo: schema.phoneCalls.forwardedTo },
        /** Texts through the team's numbers: delivery and the numbers. */
        text: { status: schema.textMessages.status, error: schema.textMessages.error, from: schema.textMessages.from, to: schema.textMessages.to, media: schema.textMessages.media },
        /** Mail copied from a teammate's connected mailbox: who it's from and whose mailbox it came through. */
        synced: { from: schema.syncedEmails.from, to: schema.syncedEmails.to, mailboxUserId: schema.connectedAccounts.userId },
        /** For mail in a connected inbox: who sent it, and which inbox it's in. */
        inboxFrom: sql<string | null>`inbox_mail."from"`,
        inboxTo: sql<string[] | null>`inbox_mail."to"`,
        inboxAddress: schema.inboxThreads.inboxAddress,
        /** The agent's background run for this note or task, when it was handed one: how it's going. */
        assistantStatus: schema.agentRuns.status,
        /** Everyone else on it besides its own person: a meeting's other attendees, an email's other recipients. */
        alsoPeople: sql<{ id: string; name: string }[]>`(select coalesce(json_agg(json_build_object('id', ap_p.id, 'name', ap_p.first_name || coalesce(' ' || ap_p.last_name, '')) order by ap_p.first_name, ap_p.id), '[]'::json) from activity_people ap join people ap_p on ap_p.id = ap.person_id where ap.activity_id = ${activities.id})`,
        /** Replies under a note, oldest first. */
        replies: sql<NoteReply[]>`(select coalesce(json_agg(json_build_object('id', r.id, 'body', r.body, 'userId', r.user_id, 'apiKeyId', r.api_key_id, 'createdAt', r.created_at) order by r.created_at, r.id), '[]'::json) from note_replies r where r.activity_id = ${activities.id})`,
      })
      .from(activities)
      .leftJoin(people, eq(people.id, activities.personId))
      .leftJoin(organizations, eq(organizations.id, activities.organizationId))
      .leftJoin(clients, eq(clients.id, activities.clientId))
      .leftJoin(schema.outboundEmails, eq(schema.outboundEmails.id, activities.emailId))
      .leftJoin(schema.phoneCalls, eq(schema.phoneCalls.id, activities.callId))
      .leftJoin(schema.textMessages, eq(schema.textMessages.id, activities.textMessageId))
      .leftJoin(schema.syncedEmails, eq(schema.syncedEmails.id, activities.syncedEmailId))
      .leftJoin(schema.connectedAccounts, eq(schema.connectedAccounts.id, schema.syncedEmails.accountId))
      .leftJoin(schema.campaigns, or(eq(schema.campaigns.id, schema.outboundEmails.campaignId), eq(schema.campaigns.id, schema.textMessages.campaignId)))
      .leftJoin(schema.inboxThreads, eq(schema.inboxThreads.id, activities.inboxThreadId))
      .leftJoin(schema.agentRuns, eq(schema.agentRuns.id, activities.agentRunId))
      // One lookup for both, and only for mail that came through an inbox: other rows skip it.
      .leftJoinLateral(
        sql`(select m."from", m."to" from inbox_messages m where ${activities.inboxThreadId} is not null and m.activity_id = ${activities.id} limit 1) inbox_mail`,
        sql`true`,
      )
      .where(where)
      .orderBy(...opts.order)
      .limit(opts.limit),
  );
}

const linkColumn = { person: activities.personId, organization: activities.organizationId, client: activities.clientId };

/** A file on a record, without its storage URL (downloads go through /api/files/[id]). `activityType` is set when it's attached to a note, call or other activity. */
export type RecordFile = {
  id: string;
  name: string;
  size: number;
  contentType: string;
  uploadedBy: string;
  createdAt: Date;
  activityId: string | null;
  activityType: ActivityType | null;
  /** Set while anyone with the link can open it (/share/<token>). */
  publicToken: string | null;
  /** On a client's page, the contact, person or organization it came from when it isn't on the client itself. */
  via?: string | null;
};

/** An attachment on an email in a connected inbox. It stays in Resend, so it opens with its conversation. */
export type EmailFile = { key: string; name: string; size: number | null; threadId: string; from: string; at: Date };

const recordFile = (f: RecordFile & { own: boolean }): RecordFile => ({
  via: f.via ?? null,
  id: f.id,
  name: f.name,
  size: f.size,
  contentType: f.contentType,
  uploadedBy: f.uploadedBy,
  createdAt: f.createdAt,
  activityId: f.activityId,
  activityType: f.activityType,
  publicToken: f.publicToken,
});

/** One entry on a record's timeline: something someone logged, something that changed, or a file added on its own. */
export type TimelineItem =
  | { kind: "activity"; at: string; row: ActivityRow }
  | { kind: "event"; at: string; event: typeof events.$inferSelect }
  | { kind: "file"; at: string; file: RecordFile }
  /** An email kept private to the viewer: synced from their own mailbox, not on the record. Only ever in their own timeline. */
  | { kind: "privateMail"; at: string; mail: Omit<PrivateMail, "sentAt"> };

/** One activity's whole body (a list sends only its preview). */
export async function activityBody(id: string) {
  const db = await getDb();
  const [row] = await db.select({ body: activities.body }).from(activities).where(eq(activities.id, id));
  if (!row) throw new ActionError("This activity was deleted.");
  return row.body;
}

/** Which past entries a timeline shows: everything, conversations (calls, emails, texts, meetings, notes, private mail) or tasks. */
export type TimelineFilter = "all" | "conversations" | "tasks";
/** How many past entries a record page sends at first, and loads at a time as it's scrolled. */
export const timelinePageSize = 50;

const conversationTypes: ActivityType[] = [...interactionTypes, "note"];
/** What's on a record's timeline. A person's also holds what they were on with others: a meeting they attended, an email they were copied on. */
const recordOn = (entity: EntityType, id: string) =>
  entity === "person" ? or(eq(activities.personId, id), sql`exists (select 1 from activity_people ap where ap.activity_id = ${activities.id} and ap.person_id = ${id})`)! : eq(linkColumn[entity], id);
const isPast = or(isNotNull(activities.completedAt), isNull(activities.dueAt))!;
const activityAt = sql`coalesce(${activities.occurredAt}, ${activities.completedAt}, ${activities.createdAt})`;

const itemKey = (i: TimelineItem) => (i.kind === "activity" ? `a:${i.row.activity.id}` : i.kind === "event" ? `e:${i.event.id}` : i.kind === "file" ? `f:${i.file.id}` : `m:${i.mail.id}`);
export { itemKey as timelineItemKey };

/**
 * One page of a record's past, newest first: activities (not pinned; those
 * come separately), history, files added on their own and the viewer's
 * private mail, merged by when they happened. `before` (an ISO time) pages
 * back from the last entry shown; entries at exactly that time come again
 * (`skip` is how many the page already has), so nothing is skipped and the
 * page drops what it already shows by key. Each source reads at most one page.
 */
export async function timelinePage(entity: EntityType, id: string, viewerId: string | undefined, o: { before?: string; skip?: number; filter?: TimelineFilter; limit?: number } = {}) {
  const db = await getDb();
  const filter = o.filter ?? "all";
  const want = (o.limit ?? timelinePageSize) + (o.skip ?? 0);
  const n = want + 1;
  const before = o.before ? new Date(o.before) : null;
  const own = entity === "person" ? files.personId : entity === "organization" ? files.organizationId : files.clientId;
  const types = filter === "tasks" ? eq(activities.type, "task") : filter === "conversations" ? inArray(activities.type, conversationTypes) : undefined;
  const [done, history, attached, privateMail] = await Promise.all([
    activityRows(and(recordOn(entity, id), isPast, eq(activities.pinned, false), types, before ? lte(activityAt, before) : undefined), { order: [desc(activityAt), desc(activities.id)], limit: n }),
    filter === "all"
      ? db
          .select()
          .from(events)
          .where(and(eq(events.entityType, entity), eq(events.entityId, id), before ? lte(events.createdAt, before) : undefined))
          .orderBy(desc(events.createdAt))
          .limit(n)
      : [],
    // A file attached to an activity shows on that activity, not as its own line. One attached to the record later shows on its own, whatever activity it came from.
    filter === "all"
      ? db
          .select({ id: files.id, name: files.name, size: files.size, contentType: files.contentType, uploadedBy: files.uploadedBy, createdAt: files.createdAt, activityId: files.activityId, activityType: activities.type, publicToken: files.publicToken })
          .from(files)
          .leftJoin(activities, eq(activities.id, files.activityId))
          .where(and(inRecordView(entity, id), isNull(files.deletedAt), sql`(${files.activityId} is null or ${own} is distinct from ${id})`, before ? lte(files.createdAt, before) : undefined))
          .orderBy(desc(files.createdAt))
          .limit(n)
      : [],
    filter !== "tasks" && viewerId ? privateMailOn(entity, id, viewerId, { before, limit: n }) : [],
  ]);
  const merged: TimelineItem[] = [
    ...done.map((row): TimelineItem => ({ kind: "activity", at: (row.activity.occurredAt ?? row.activity.completedAt ?? row.activity.createdAt).toISOString(), row })),
    ...history.map((event): TimelineItem => ({ kind: "event", at: event.createdAt.toISOString(), event })),
    ...attached.map((f): TimelineItem => ({ kind: "file", at: f.createdAt.toISOString(), file: recordFile({ ...f, own: false }) })),
    ...privateMail.map(({ sentAt, ...m }): TimelineItem => ({ kind: "privateMail", at: sentAt.toISOString(), mail: m })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return { items: merged.slice(0, want), hasMore: merged.length > want };
}

/** A record's planned work (open, with a due date), soonest first. */
export function plannedOn(entity: EntityType, id: string, limit = 100) {
  return activityRows(and(recordOn(entity, id), isNull(activities.completedAt), isNotNull(activities.dueAt)), { order: [asc(activities.dueAt)], limit });
}

/** A record's pinned entries, newest first. */
export function pinnedOn(entity: EntityType, id: string, limit = 100) {
  return activityRows(and(recordOn(entity, id), isPast, eq(activities.pinned, true)), { order: [desc(activityAt)], limit });
}

/** When the record was last contacted: the latest call, email, text or meeting (not a campaign). Its own query, so it's right however long the history is. */
export async function lastContactOn(entity: EntityType, id: string) {
  const db = await getDb();
  const [contact] = await db
    .select({ at: sql<Date | null>`max(${activityAt})` })
    .from(activities)
    .where(and(recordOn(entity, id), inArray(activities.type, interactionTypes), isPast, notCampaignEmail));
  return contact?.at ? new Date(contact.at).toISOString() : null;
}

export const asTimelineItem = (row: ActivityRow): TimelineItem => ({ kind: "activity", at: (row.activity.occurredAt ?? row.activity.completedAt ?? row.activity.createdAt).toISOString(), row });

/**
 * A record's page: planned work in full (soonest first: it's about the
 * future, and there's little of it), pinned entries, the first page of the
 * past, how many conversations and tasks the past holds in all (for the
 * filters), when they were last contacted, and every file on the record
 * (the Files card, and what's attached to each activity). Older entries load
 * as the timeline is scrolled (`timelinePage`).
 */
export async function recordTimeline(entity: EntityType, id: string, viewerId?: string) {
  const db = await getDb();
  const on = recordOn(entity, id);
  const [planned, pinned, first, attached, mail, lastContactAt, [counts], privateCount] = await Promise.all([
    plannedOn(entity, id),
    pinnedOn(entity, id),
    timelinePage(entity, id, viewerId),
    db
      .select({
        id: files.id,
        name: files.name,
        size: files.size,
        contentType: files.contentType,
        uploadedBy: files.uploadedBy,
        createdAt: files.createdAt,
        activityId: files.activityId,
        activityType: activities.type,
        publicToken: files.publicToken,
        own: sql<boolean>`${entity === "person" ? files.personId : entity === "organization" ? files.organizationId : files.clientId} is not distinct from ${id}`,
        via: entity === "client" ? sql<string | null>`case when ${onRecord("client", id)} then null else coalesce((select p.first_name || coalesce(' ' || p.last_name, '') from people p where p.id = ${files.personId}), (select o.name from organizations o where o.id = ${files.organizationId})) end` : sql<string | null>`null`,
      })
      .from(files)
      .leftJoin(activities, eq(activities.id, files.activityId))
      .where(and(inRecordView(entity, id), isNull(files.deletedAt)))
      .orderBy(desc(files.createdAt))
      .limit(500),
    db
      .select({ id: schema.inboxMessages.id, threadId: schema.inboxMessages.threadId, from: schema.inboxMessages.from, sentAt: schema.inboxMessages.sentAt, attachments: schema.inboxMessages.attachments })
      .from(schema.inboxMessages)
      .innerJoin(activities, eq(activities.id, schema.inboxMessages.activityId))
      .where(and(on, sql`jsonb_array_length(${schema.inboxMessages.attachments}) > 0`))
      .orderBy(desc(schema.inboxMessages.sentAt))
      .limit(200),
    lastContactOn(entity, id),
    // The filters' counts, over the whole past (pinned included), in one grouped query.
    db
      .select({
        conversations: sql<number>`count(*) filter (where ${inArray(activities.type, conversationTypes)})::int`,
        tasks: sql<number>`count(*) filter (where ${activities.type} = 'task')::int`,
      })
      .from(activities)
      .where(and(on, isPast)),
    viewerId ? privateMailCount(entity, id, viewerId) : 0,
  ]);
  const emailFiles: EmailFile[] = mail.flatMap((m) => m.attachments.map((a) => ({ key: `${m.id}:${a.id}`, name: a.filename ?? "Attachment", size: a.size, threadId: m.threadId, from: m.from, at: m.sentAt })));
  return {
    planned,
    pinned: pinned.map(asTimelineItem),
    past: first.items,
    hasMore: first.hasMore,
    counts: { conversations: (counts?.conversations ?? 0) + privateCount, tasks: counts?.tasks ?? 0 } satisfies Record<Exclude<TimelineFilter, "all">, number>,
    lastContactAt,
    files: attached.map(recordFile),
    emailFiles,
  };
}

/**
 * Fills in the links an activity implies: logged on a client, it also shows on
 * the client's contact and organization; logged on a person, on their
 * organization. That's what makes the organization page the whole story.
 */
export async function resolveLinks(l: { personId?: string | null; organizationId?: string | null; clientId?: string | null }) {
  const db = await getDb();
  let { personId = null, organizationId = null } = l;
  const clientId = l.clientId ?? null;
  if (clientId) {
    const [d] = await db.select({ personId: clients.personId, organizationId: clients.organizationId }).from(clients).where(eq(clients.id, clientId));
    if (!d) throw new ActionError("That client was deleted.");
    personId ??= d.personId;
    organizationId ??= d.organizationId;
  }
  if (personId && !organizationId) {
    const [p] = await db.select({ organizationId: people.organizationId }).from(people).where(eq(people.id, personId));
    organizationId = p?.organizationId ?? null;
  }
  return { personId, organizationId, clientId };
}

/**
 * Where an uploaded file goes: the one record it was added on, without
 * rolling down. Added on a client (its page, or a note or email on it), it's
 * on that client only, not its contact or organization; added on a person or
 * an organization, on them only. A client still shows the files of its
 * contact, its people and its organization (`inRecordView`), so
 * files reach a client from below but never spread down from it.
 */
export async function uploadLinks(input: { personId?: string | null; organizationId?: string | null; clientId?: string | null; activityId?: string | null }) {
  const db = await getDb();
  let l: { personId?: string | null; organizationId?: string | null; clientId?: string | null } = input;
  if (input.activityId) {
    const [a] = await db
      .select({ personId: activities.personId, organizationId: activities.organizationId, clientId: activities.clientId })
      .from(activities)
      .where(eq(activities.id, input.activityId));
    if (!a) throw new ActionError("That activity was deleted. Attach the file to the record instead.");
    l = a;
  }
  const none = { personId: null, organizationId: null, clientId: null, activityId: input.activityId ?? null };
  if (l.clientId) {
    const [c] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, l.clientId));
    if (!c) throw new ActionError("That client was deleted.");
    return { ...none, clientId: c.id };
  }
  if (l.personId) {
    const [p] = await db.select({ id: people.id }).from(people).where(eq(people.id, l.personId));
    if (!p) throw new ActionError("That person was deleted.");
    return { ...none, personId: p.id };
  }
  if (l.organizationId) {
    const [o] = await db.select({ id: schema.organizations.id }).from(schema.organizations).where(eq(schema.organizations.id, l.organizationId));
    if (!o) throw new ActionError("That organization was deleted.");
    return { ...none, organizationId: o.id };
  }
  return none;
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
    return activityRows(and(...where), { order: [asc(activities.dueAt)], limit: 500, preview: true });
  }
  where.push(or(isNotNull(activities.completedAt), isNull(activities.dueAt))!, notCampaignEmail);
  return activityRows(and(...where), { order: [desc(sql`coalesce(${activities.completedAt}, ${activities.occurredAt}, ${activities.createdAt})`)], limit: 200, preview: true });
}

/** Recent interactions and notes from everyone, for the home page feed. */
export async function teamFeed(limit = 25) {
  return activityRows(and(or(isNotNull(activities.completedAt), isNull(activities.dueAt)), notCampaignEmail), {
    order: [desc(sql`coalesce(${activities.occurredAt}, ${activities.completedAt}, ${activities.createdAt})`)],
    limit,
    preview: true,
  });
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
        select coalesce(round(sum(${sql.raw(monthlyPriceSql)})), 0)::bigint
        from client_services cs join clients c on c.id = cs.client_id
        where c.category = 'current' and c.archived_at is null and (cs.ended_on is null or cs.ended_on > current_date)
      )`,
    })
    .from(clients)
    .where(isNull(clients.archivedAt));
  return { ...row, prospectValue: Number(row.prospectValue), mrr: Number(row.mrr) };
}
