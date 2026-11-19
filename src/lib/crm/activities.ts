import "server-only";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { interactionTypes, monthlyPriceSql, type ActivityType, type EntityType } from "@/lib/constants";
import { ActionError } from "@/lib/auth";
import { zonedTime } from "@/lib/format";
import { inRecordView, onRecord } from "@/lib/crm/files";

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
        inboxFrom: sql<string | null>`(select m."from" from inbox_messages m where m.activity_id = ${activities.id} limit 1)`,
        inboxTo: sql<string[] | null>`(select m."to" from inbox_messages m where m.activity_id = ${activities.id} limit 1)`,
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
  | { kind: "file"; at: string; file: RecordFile };

/**
 * A record's whole story, newest first: logged activities (by when they
 * happened), changes, and files. Open tasks are returned separately as
 * "planned", soonest first, because they're about the future.
 * `lastContactAt` is the latest call, email, text or meeting. `files` is every
 * file on the record (added on its own or attached to an activity) and
 * `emailFiles` every attachment on its inbox mail, for the Files card.
 */
export async function timeline(entity: EntityType, id: string) {
  const db = await getDb();
  // A person's timeline also holds what they were on with others: a meeting they attended, an email they were copied on.
  const on =
    entity === "person"
      ? or(eq(activities.personId, id), sql`exists (select 1 from activity_people ap where ap.activity_id = ${activities.id} and ap.person_id = ${id})`)!
      : eq(linkColumn[entity], id);
  const [planned, done, history, attached, mail, [contact]] = await Promise.all([
    activityRows(and(on, isNull(activities.completedAt), isNotNull(activities.dueAt)), { order: [asc(activities.dueAt)], limit: 100 }),
    activityRows(and(on, or(isNotNull(activities.completedAt), isNull(activities.dueAt))), {
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
        /** Uploaded on this record, rather than attached to it later or gathered from one below it. */
        own: sql<boolean>`${entity === "person" ? files.personId : entity === "organization" ? files.organizationId : files.clientId} is not distinct from ${id}`,
        /** On a client's page, the person or organization a file came from when it isn't on the client itself. */
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
    // Its own query, so it's right however long the history is.
    db
      .select({ at: sql<Date | null>`max(coalesce(${activities.occurredAt}, ${activities.completedAt}, ${activities.createdAt}))` })
      .from(activities)
      .where(and(on, inArray(activities.type, interactionTypes), or(isNotNull(activities.completedAt), isNull(activities.dueAt)), notCampaignEmail)),
  ]);
  const past: TimelineItem[] = [
    ...done.map((row): TimelineItem => ({ kind: "activity", at: (row.activity.occurredAt ?? row.activity.completedAt ?? row.activity.createdAt).toISOString(), row })),
    ...history.map((event): TimelineItem => ({ kind: "event", at: event.createdAt.toISOString(), event })),
    // A file attached to an activity shows on that activity, not as its own line.
    // One attached to the record later shows on its own, whatever activity it came from.
    ...attached.filter((f) => !f.activityId || !f.own).map((f): TimelineItem => ({ kind: "file", at: f.createdAt.toISOString(), file: recordFile(f) })),
  ];
  const pinned = past.filter((i) => i.kind === "activity" && i.row.activity.pinned);
  const rest = past.filter((i) => !(i.kind === "activity" && i.row.activity.pinned)).sort((a, b) => b.at.localeCompare(a.at));
  const lastContactAt = contact?.at ? new Date(contact.at).toISOString() : null;
  const emailFiles: EmailFile[] = mail.flatMap((m) => m.attachments.map((a) => ({ key: `${m.id}:${a.id}`, name: a.filename ?? "Attachment", size: a.size, threadId: m.threadId, from: m.from, at: m.sentAt })));
  return { planned, pinned, past: rest, lastContactAt, files: attached.map(recordFile), emailFiles };
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
    return activityRows(and(...where), { order: [asc(activities.dueAt)], limit: 500 });
  }
  where.push(or(isNotNull(activities.completedAt), isNull(activities.dueAt))!, notCampaignEmail);
  return activityRows(and(...where), { order: [desc(sql`coalesce(${activities.completedAt}, ${activities.occurredAt}, ${activities.createdAt})`)], limit: 200 });
}

/** Recent interactions and notes from everyone, for the home page feed. */
export async function teamFeed(limit = 25) {
  return activityRows(and(or(isNotNull(activities.completedAt), isNull(activities.dueAt)), notCampaignEmail), {
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
        select coalesce(round(sum(${sql.raw(monthlyPriceSql)})), 0)::bigint
        from client_services cs join clients c on c.id = cs.client_id
        where c.category = 'current' and c.archived_at is null and (cs.ended_on is null or cs.ended_on > current_date)
      )`,
    })
    .from(clients)
    .where(isNull(clients.archivedAt));
  return { ...row, prospectValue: Number(row.prospectValue), mrr: Number(row.mrr) };
}
