import "server-only";
import { folderLabel } from "@/lib/folder-tree";
import { cadenceLabel } from "@/lib/agent/schedule-rules";
import type { JobRow } from "@/lib/agent/schedules";
import type { SkillRow } from "@/lib/agent/skills";
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/db";
import type { ActivityType, EntityType } from "@/lib/constants";
import { listProductDescriptions, stripeProductUsage } from "@/lib/crm/product-descriptions";
import { productDescriber, productKey } from "@/lib/product-rules";
import { actorUserId, type Actor } from "@/lib/crm/actor";
import { clientAtOrganization } from "@/lib/crm/client-organizations";
import { asTimelineItem, lastContactOn, pinnedOn, plannedOn, timelinePage, type NoteReply } from "@/lib/crm/activities";
import { activityArchived, activityLive } from "@/lib/crm/activity-archive";
import { effectiveTags, listLabels } from "@/lib/crm/labels";
import { clientPeople as peopleOnClient, inOrganizations, likeTerm } from "@/lib/crm/records";
import { resolveFilter } from "@/lib/crm/saved-filters";
import { ActionError, NotFoundError } from "@/lib/errors";
import { htmlToText } from "@/lib/safe-html";
import type { ChatMessage } from "@/lib/chat/service";

/**
 * Reads for the API: filtered, cursor-paged lists and single records, shaped
 * as the models in models.ts. Lists are keyset-paged (newest first, or
 * soonest due for open tasks), so pages stay stable while records are added.
 */

const { people, organizations, clients, stages, pipelines, activities, users } = schema;

export type Page<T> = { data: T[]; nextCursor: string | null };
type Ctx = { origin: string };

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const fullName = (first: string, last: string | null) => [first, last].filter(Boolean).join(" ");

// ─── Paging ──────────────────────────────────────────────────────────────

/** An exact, sortable text form of a timestamp column (microseconds, which a JS Date would lose). */
const exact = (col: AnyPgColumn) => sql<string>`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function encodeCursor(value: string, id: string) {
  return Buffer.from(JSON.stringify([value, id])).toString("base64url");
}

function decodeCursor(cursor: string | undefined): { value: string; id: string } | null {
  if (!cursor) return null;
  try {
    const [value, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof value === "string" && typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id) && !Number.isNaN(Date.parse(value))) return { value, id };
  } catch {
    // Falls through to the error below.
  }
  throw new ActionError("That cursor isn't valid. Start again from the first page.");
}

/** Rows after the cursor, for a list ordered by (col, id) in `dir`. */
function after(cursor: string | undefined, col: AnyPgColumn, idCol: AnyPgColumn, dir: "asc" | "desc") {
  const c = decodeCursor(cursor);
  if (!c) return undefined;
  return dir === "desc" ? sql`(${col}, ${idCol}) < (${c.value}::timestamptz, ${c.id}::uuid)` : sql`(${col}, ${idCol}) > (${c.value}::timestamptz, ${c.id}::uuid)`;
}

function page<R extends { key: string }, T>(rows: R[], limit: number, idOf: (r: R) => string, map: (r: R) => T): Page<T> {
  const more = rows.length > limit;
  const shown = more ? rows.slice(0, limit) : rows;
  const last = shown.at(-1);
  return { data: shown.map(map), nextCursor: more && last ? encodeCursor(last.key, idOf(last)) : null };
}

/** "me", "none" or an id, for owner and assignee filters. */
function whoFilter(a: Actor, col: AnyPgColumn, value: string | undefined) {
  if (!value) return undefined;
  if (value === "none") return isNull(col);
  if (value === "me") {
    const me = actorUserId(a);
    if (!me) throw new ActionError('"me" only works with a personal key. Pass a teammate id from GET /users.');
    return eq(col, me);
  }
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new ActionError('Pass a teammate id, "me" or "none".');
  return eq(col, value);
}

type RecordFilter = { q?: string; ownerId?: string; updatedSince?: string; includeArchived?: boolean; limit?: number; cursor?: string; filterId?: string };

/** A saved filter asked for by id, as SQL. One this key can't use is an error rather than an unfiltered list. */
async function savedFilterWhere(a: Actor, entity: EntityType, filterId: string | undefined) {
  const { where, missing } = await resolveFilter(actorUserId(a), entity, filterId);
  if (missing) throw new NotFoundError(`There's no saved ${entity === "person" ? "people" : entity === "organization" ? "organizations" : "clients"} filter with that id that this key can use. GET /filters lists them.`);
  return where;
}

function common(a: Actor, t: typeof people | typeof organizations | typeof clients, f: RecordFilter) {
  const where: (SQL | undefined)[] = [];
  if (!f.includeArchived) where.push(isNull(t.archivedAt));
  where.push(whoFilter(a, t.ownerId, f.ownerId));
  if (f.updatedSince) where.push(gte(t.updatedAt, new Date(f.updatedSince)));
  where.push(after(f.cursor, t.createdAt, t.id, "desc"));
  return where;
}

// ─── People ──────────────────────────────────────────────────────────────

const personSelect = { person: people, organizationName: organizations.name, organizationTags: organizations.tags, key: exact(people.createdAt) };
type PersonRow = { person: typeof people.$inferSelect; organizationName: string | null; organizationTags: string[] | null };

function toPerson(ctx: Ctx, r: PersonRow) {
  const p = r.person;
  return {
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    name: fullName(p.firstName, p.lastName),
    email: p.email,
    phone: p.phone,
    otherEmails: p.otherEmails,
    otherPhones: p.otherPhones,
    title: p.title,
    organizationId: p.organizationId,
    organization: p.organizationId && r.organizationName ? { id: p.organizationId, name: r.organizationName } : null,
    ownerId: p.ownerId,
    tags: p.tags,
    organizationTags: (r.organizationTags ?? []).filter((t) => !p.tags.includes(t)),
    marketingOptIn: p.marketingOptIn,
    unsubscribedAt: iso(p.unsubscribedAt),
    emailBouncedAt: iso(p.emailBouncedAt),
    lastCampaignAt: iso(p.lastCampaignAt),
    decisionMaker: p.decisionMaker,
    textConsentAt: iso(p.textConsentAt),
    textOptOutAt: iso(p.textOptOutAt),
    custom: p.custom,
    lastActivityAt: iso(p.lastActivityAt),
    createdAt: iso(p.createdAt)!,
    updatedAt: iso(p.updatedAt)!,
    archivedAt: iso(p.archivedAt),
    url: `${ctx.origin}/people/${p.id}`,
  };
}

export async function listPeople(a: Actor, ctx: Ctx, f: RecordFilter & { organizationId?: string; email?: string; tag?: string }) {
  const db = await getDb();
  const limit = f.limit ?? 50;
  const where = common(a, people, f);
  if (f.q) {
    const t = likeTerm(f.q);
    where.push(or(ilike(sql`${people.firstName} || ' ' || coalesce(${people.lastName}, '')`, t), ilike(people.email, t), ilike(people.phone, t), ilike(sql`${people.otherEmails}::text`, t), ilike(sql`${people.otherPhones}::text`, t), ilike(organizations.name, t)));
  }
  if (f.organizationId) where.push(inOrganizations(people.organizationId, [f.organizationId]));
  if (f.email) where.push(or(eq(people.email, f.email), sql`${people.otherEmails} ? ${f.email.toLowerCase()}`)!);
  if (f.tag) where.push(sql`${effectiveTags} ? ${f.tag}`);
  where.push(await savedFilterWhere(a, "person", f.filterId));
  const rows = await db
    .select(personSelect)
    .from(people)
    .leftJoin(organizations, eq(organizations.id, people.organizationId))
    .where(and(...where))
    .orderBy(desc(people.createdAt), desc(people.id))
    .limit(limit + 1);
  return page(rows, limit, (r) => r.person.id, (r) => toPerson(ctx, r));
}

export async function getPerson(ctx: Ctx, id: string) {
  const db = await getDb();
  const [row] = await db.select(personSelect).from(people).leftJoin(organizations, eq(organizations.id, people.organizationId)).where(eq(people.id, id));
  if (!row) throw new NotFoundError("There's no person with that id.");
  return toPerson(ctx, row);
}

// ─── Organizations ───────────────────────────────────────────────────────

// Qualified by hand: in a select with no joins Drizzle renders a column as a bare "id", which the subquery would read as its own.
const peopleCount = sql<number>`(select count(*)::int from people p where p.organization_id = "organizations"."id" and p.archived_at is null)`;
const orgSelect = {
  organization: organizations,
  peopleCount,
  parentName: sql<string | null>`(select parent.name from organizations parent where parent.id = "organizations"."parent_id")`,
  childCount: sql<number>`(select count(*)::int from organizations child where child.parent_id = "organizations"."id" and child.archived_at is null)`,
  key: exact(organizations.createdAt),
};

function toOrganization(ctx: Ctx, r: { organization: typeof organizations.$inferSelect; peopleCount: number; parentName: string | null; childCount: number }) {
  const o = r.organization;
  return {
    id: o.id,
    name: o.name,
    domain: o.domain,
    phone: o.phone,
    address: o.address,
    industry: o.industry,
    tags: o.tags,
    isParent: o.isParent,
    parentId: o.parentId,
    parent: o.parentId && r.parentName ? { id: o.parentId, name: r.parentName } : null,
    childCount: Number(r.childCount),
    ownerId: o.ownerId,
    peopleCount: Number(r.peopleCount),
    custom: o.custom,
    lastActivityAt: iso(o.lastActivityAt),
    createdAt: iso(o.createdAt)!,
    updatedAt: iso(o.updatedAt)!,
    archivedAt: iso(o.archivedAt),
    url: `${ctx.origin}/organizations/${o.id}`,
  };
}

export async function listOrganizations(a: Actor, ctx: Ctx, f: RecordFilter & { domain?: string; parentId?: string; isParent?: boolean; tag?: string }) {
  const db = await getDb();
  const limit = f.limit ?? 50;
  const where = common(a, organizations, f);
  if (f.q) {
    const t = likeTerm(f.q);
    where.push(or(ilike(organizations.name, t), ilike(organizations.domain, t), ilike(organizations.industry, t)));
  }
  if (f.domain) where.push(eq(organizations.domain, f.domain.replace(/^https?:\/\//, "").replace(/\/$/, "")));
  if (f.tag) where.push(sql`${organizations.tags} ? ${f.tag}`);
  if (f.parentId) where.push(eq(organizations.parentId, f.parentId));
  if (f.isParent !== undefined) where.push(eq(organizations.isParent, f.isParent));
  where.push(await savedFilterWhere(a, "organization", f.filterId));
  const rows = await db
    .select(orgSelect)
    .from(organizations)
    .where(and(...where))
    .orderBy(desc(organizations.createdAt), desc(organizations.id))
    .limit(limit + 1);
  return page(rows, limit, (r) => r.organization.id, (r) => toOrganization(ctx, r));
}

export async function getOrganization(ctx: Ctx, id: string) {
  const db = await getDb();
  const [row] = await db.select(orgSelect).from(organizations).where(eq(organizations.id, id));
  if (!row) throw new NotFoundError("There's no organization with that id.");
  return toOrganization(ctx, row);
}

// ─── Clients ─────────────────────────────────────────────────────────────

/** What Stripe bills them a month, after discounts (the same as billing.mrr). */
const mrr = sql<number>`${clients.stripeMrr}`;
const clientSelect = {
  client: clients,
  stageName: stages.name,
  stageProbability: stages.probability,
  pipelineName: pipelines.name,
  personFirstName: people.firstName,
  personLastName: people.lastName,
  organizationName: organizations.name,
  mrr,
  key: exact(clients.createdAt),
};

/** Clients with their stage, pipeline, contact and organization names. (Takes the where clause: a query builder can't be returned from a promise without running it.) */
async function selectClients(where: SQL | undefined, limit: number) {
  const db = await getDb();
  return db
    .select(clientSelect)
    .from(clients)
    .innerJoin(stages, eq(stages.id, clients.stageId))
    .innerJoin(pipelines, eq(pipelines.id, clients.pipelineId))
    .leftJoin(people, eq(people.id, clients.personId))
    .leftJoin(organizations, eq(organizations.id, clients.organizationId))
    .where(where)
    .orderBy(desc(clients.createdAt), desc(clients.id))
    .limit(limit);
}

type ClientRow = Awaited<ReturnType<typeof selectClients>>[number];

function toClient(ctx: Ctx, r: ClientRow) {
  const c = r.client;
  return {
    id: c.id,
    name: c.name,
    category: c.category,
    value: Number(c.value),
    currency: c.currency,
    mrr: Number(r.mrr),
    pipeline: { id: c.pipelineId, name: r.pipelineName },
    stage: { id: c.stageId, name: r.stageName, probability: r.stageProbability },
    stageChangedAt: iso(c.stageChangedAt)!,
    expectedCloseDate: c.expectedCloseDate,
    startedOn: c.startedOn,
    endedOn: c.endedOn,
    churnReason: c.churnReason,
    openToReturn: c.openToReturn,
    health: c.health,
    billing: { status: c.stripeStatus, mrr: Number(c.stripeMrr), discount: Number(c.stripeDiscount), collectedLastYear: Number(c.stripeCollected), owed: Number(c.stripeOwed), credit: Number(c.stripeCredit), products: c.stripeProducts, syncedAt: iso(c.stripeSyncedAt) },
    tags: c.tags,
    productLines: c.productLines,
    personId: c.personId,
    person: c.personId && r.personFirstName ? { id: c.personId, name: fullName(r.personFirstName, r.personLastName) } : null,
    organizationId: c.organizationId,
    organization: c.organizationId && r.organizationName ? { id: c.organizationId, name: r.organizationName } : null,
    ownerId: c.ownerId,
    custom: c.custom,
    lastActivityAt: iso(c.lastActivityAt),
    createdAt: iso(c.createdAt)!,
    updatedAt: iso(c.updatedAt)!,
    archivedAt: iso(c.archivedAt),
    url: `${ctx.origin}/clients/${c.id}`,
  };
}

export async function listClients(
  a: Actor,
  ctx: Ctx,
  f: RecordFilter & { category?: string; pipelineId?: string; stageId?: string; personId?: string; organizationId?: string; health?: string; tag?: string; productLine?: string },
) {
  const limit = f.limit ?? 50;
  const where = common(a, clients, f);
  if (f.q) {
    const t = likeTerm(f.q);
    where.push(or(ilike(clients.name, t), ilike(organizations.name, t), ilike(sql`${people.firstName} || ' ' || coalesce(${people.lastName}, '')`, t)));
  }
  if (f.category) where.push(eq(clients.category, f.category as never));
  if (f.pipelineId) where.push(eq(clients.pipelineId, f.pipelineId));
  if (f.stageId) where.push(eq(clients.stageId, f.stageId));
  if (f.personId) where.push(eq(clients.personId, f.personId));
  if (f.organizationId) where.push(clientAtOrganization(f.organizationId));
  if (f.health) where.push(eq(clients.health, f.health as never));
  if (f.tag) where.push(sql`${clients.tags} ? ${f.tag}`);
  if (f.productLine) where.push(sql`${clients.productLines} ? ${f.productLine}`);
  where.push(await savedFilterWhere(a, "client", f.filterId));
  const rows = await selectClients(and(...where), limit + 1);
  return page(rows, limit, (r) => r.client.id, (r) => toClient(ctx, r));
}

export async function getClient(ctx: Ctx, id: string) {
  const [row] = await selectClients(eq(clients.id, id), 1);
  if (!row) throw new NotFoundError("There's no client with that id.");
  return toClient(ctx, row);
}

/** Everyone associated with a client, with how each comes to be on it. */
export async function clientPeople(ctx: Ctx, clientId: string) {
  const db = await getDb();
  const [client] = await db.select({ id: clients.id, personId: clients.personId, organizationId: clients.organizationId }).from(clients).where(eq(clients.id, clientId));
  if (!client) throw new NotFoundError("There's no client with that id.");
  const rows = await peopleOnClient(client);
  if (!rows.length) return [];
  const orgIds = [...new Set(rows.map((r) => r.person.organizationId).filter((x): x is string => !!x))];
  const orgs = orgIds.length ? await db.select({ id: organizations.id, name: organizations.name, tags: organizations.tags }).from(organizations).where(inArray(organizations.id, orgIds)) : [];
  return rows.map((r) => {
    const org = orgs.find((o) => o.id === r.person.organizationId);
    return { ...toPerson(ctx, { person: r.person, organizationName: org?.name ?? null, organizationTags: org?.tags ?? null }), source: r.source };
  });
}

export async function clientMetrics(clientId: string, label?: string) {
  const db = await getDb();
  await assertExists("client", clientId);
  const m = schema.clientMetrics;
  const rows = await db
    .select()
    .from(m)
    .where(and(eq(m.clientId, clientId), label ? sql`lower(${m.label}) = lower(${label})` : undefined))
    .orderBy(desc(m.period), desc(m.createdAt))
    .limit(1000);
  return rows.map((r) => ({ id: r.id, label: r.label, value: r.value, period: r.period, note: r.note, userId: r.userId, createdAt: iso(r.createdAt)! }));
}

// ─── Activities ──────────────────────────────────────────────────────────

const activitySelect = {
  activity: activities,
  personName: sql<string | null>`case when ${people.id} is null then null else ${people.firstName} || coalesce(' ' || ${people.lastName}, '') end`,
  organizationName: organizations.name,
  clientName: clients.name,
  archived: activityArchived(),
  alsoPeople: sql<{ id: string; name: string }[]>`(select coalesce(json_agg(json_build_object('id', ap_p.id, 'name', ap_p.first_name || coalesce(' ' || ap_p.last_name, '')) order by ap_p.first_name, ap_p.id), '[]'::json) from activity_people ap join people ap_p on ap_p.id = ap.person_id where ap.activity_id = ${activities.id})`,
  replies: sql<NoteReply[]>`(select coalesce(json_agg(json_build_object('id', r.id, 'body', r.body, 'userId', r.user_id, 'apiKeyId', r.api_key_id, 'createdAt', r.created_at) order by r.created_at, r.id), '[]'::json) from note_replies r where r.activity_id = ${activities.id})`,
};
type ActivityRowLike = { activity: typeof activities.$inferSelect; personName: string | null; organizationName: string | null; clientName: string | null; archived: boolean; alsoPeople?: { id: string; name: string }[]; replies?: NoteReply[] };

export function toActivity(r: ActivityRowLike) {
  const x = r.activity;
  const ref = (id: string | null, name: string | null) => (id && name ? { id, name } : null);
  return {
    id: x.id,
    type: x.type,
    status: (!x.completedAt && x.dueAt ? "planned" : "done") as "planned" | "done",
    subject: x.subject,
    body: x.body,
    bodyText: x.body ? htmlToText(x.body) : null,
    direction: x.direction,
    outcome: x.outcome,
    durationMinutes: x.durationMinutes,
    occurredAt: iso(x.occurredAt),
    dueAt: iso(x.dueAt),
    dueHasTime: x.dueHasTime,
    completedAt: iso(x.completedAt),
    pinned: x.pinned,
    archived: r.archived,
    personId: x.personId,
    person: ref(x.personId, r.personName),
    people: [...(x.personId && r.personName ? [{ id: x.personId, name: r.personName }] : []), ...(r.alsoPeople ?? [])],
    organizationId: x.organizationId,
    organization: ref(x.organizationId, r.organizationName),
    clientId: x.clientId,
    client: ref(x.clientId, r.clientName),
    userId: x.userId,
    assigneeId: x.assigneeId,
    apiKeyId: x.apiKeyId,
    replies: (r.replies ?? []).map((y) => ({ id: y.id, body: y.body, bodyText: htmlToText(y.body), userId: y.userId, apiKeyId: y.apiKeyId, createdAt: iso(new Date(y.createdAt))! })),
    createdAt: iso(x.createdAt)!,
    updatedAt: iso(x.updatedAt)!,
  };
}

async function selectActivities(where: SQL | undefined, order: SQL[], limit: number, key: SQL<string> = sql<string>`''`) {
  const db = await getDb();
  return db
    .select({ ...activitySelect, key })
    .from(activities)
    .leftJoin(people, eq(people.id, activities.personId))
    .leftJoin(organizations, eq(organizations.id, activities.organizationId))
    .leftJoin(clients, eq(clients.id, activities.clientId))
    .where(where)
    .orderBy(...order)
    .limit(limit);
}

export async function getActivity(id: string, type?: ActivityType) {
  const [row] = await selectActivities(eq(activities.id, id), [], 1);
  if (!row || (type && row.activity.type !== type)) throw new NotFoundError(`There's no ${type ?? "activity"} with that id.`);
  return toActivity(row);
}

export type ActivityListFilter = {
  types?: ActivityType[];
  /** planned: open with a due date (soonest first). done: completed or logged. all: everything, newest first. */
  status?: "planned" | "done" | "all";
  assigneeId?: string;
  personId?: string;
  organizationId?: string;
  clientId?: string;
  unlinked?: boolean;
  dueBefore?: string;
  dueAfter?: string;
  since?: string;
  includeArchived?: boolean;
  limit?: number;
  cursor?: string;
};

export async function listActivities(a: Actor, f: ActivityListFilter) {
  const limit = f.limit ?? 50;
  const where: (SQL | undefined)[] = [];
  if (!f.includeArchived) where.push(activityLive());
  if (f.types?.length) where.push(inArray(activities.type, f.types));
  if (f.status === "planned") where.push(isNull(activities.completedAt), isNotNull(activities.dueAt));
  if (f.status === "done") where.push(or(isNotNull(activities.completedAt), isNull(activities.dueAt)));
  where.push(whoFilter(a, activities.assigneeId, f.assigneeId));
  if (f.personId) where.push(or(eq(activities.personId, f.personId), sql`exists (select 1 from activity_people ap where ap.activity_id = ${activities.id} and ap.person_id = ${f.personId})`));
  if (f.organizationId) where.push(eq(activities.organizationId, f.organizationId));
  if (f.clientId) where.push(eq(activities.clientId, f.clientId));
  if (f.unlinked) where.push(isNull(activities.personId), isNull(activities.organizationId), isNull(activities.clientId));
  if (f.dueBefore) where.push(lte(activities.dueAt, new Date(f.dueBefore)));
  if (f.dueAfter) where.push(gte(activities.dueAt, new Date(f.dueAfter)));
  if (f.since) where.push(gte(sql`coalesce(${activities.occurredAt}, ${activities.createdAt})`, new Date(f.since)));

  // Planned work reads soonest first; everything else newest first.
  const soonest = f.status === "planned";
  const col = soonest ? activities.dueAt : activities.createdAt;
  where.push(after(f.cursor, col, activities.id, soonest ? "asc" : "desc"));
  const order = soonest ? [asc(activities.dueAt), asc(activities.id)] : [desc(activities.createdAt), desc(activities.id)];
  const rows = await selectActivities(and(...where), order, limit + 1, exact(col));
  return page(rows, limit, (r) => r.activity.id, toActivity);
}

// ─── Timeline ────────────────────────────────────────────────────────────

const tables = { person: people, organization: organizations, client: clients } as const;

export async function assertExists(entity: EntityType, id: string) {
  const db = await getDb();
  const t = tables[entity];
  const [row] = await db.select({ id: t.id }).from(t).where(eq(t.id, id));
  if (!row) throw new NotFoundError(`There's no ${entity} with that id.`);
}

/**
 * A record's planned work and its newest history (pinned entries first), each
 * read with `limit` in SQL rather than loaded whole and cut down.
 */
export async function recordTimeline(entity: EntityType, id: string, limit = 50) {
  await assertExists(entity, id);
  // No viewer is passed, so a teammate's private mail is never read here. The filter makes that true for the types too.
  const [planned, pinned, past, lastContactAt] = await Promise.all([plannedOn(entity, id, limit), pinnedOn(entity, id, limit), timelinePage(entity, id, undefined, { limit }), lastContactOn(entity, id)]);
  const event = (e: typeof schema.events.$inferSelect) => ({ id: e.id, action: e.action, data: e.data, userId: e.userId, apiKeyId: e.apiKeyId, createdAt: iso(e.createdAt)! });
  const history = [...pinned.map(asTimelineItem), ...past.items].filter((i) => i.kind !== "privateMail").slice(0, limit).map((i) => {
    if (i.kind === "activity") return { kind: "activity" as const, at: i.at, activity: toActivity(i.row) };
    if (i.kind === "event") return { kind: "event" as const, at: i.at, event: event(i.event) };
    return { kind: "file" as const, at: i.at, file: { id: i.file.id, name: i.file.name, size: i.file.size, contentType: i.file.contentType } };
  });
  return { planned: planned.map(toActivity), history, lastContactAt };
}

// ─── Workspace ───────────────────────────────────────────────────────────

export async function listPipelines() {
  const db = await getDb();
  const [ps, ss] = await Promise.all([
    db.select().from(pipelines).orderBy(asc(pipelines.category), asc(pipelines.position), asc(pipelines.createdAt)),
    db.select().from(stages).orderBy(asc(stages.position)),
  ]);
  return ps.map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    position: p.position,
    stages: ss.filter((s) => s.pipelineId === p.id).map((s) => ({ id: s.id, name: s.name, position: s.position, probability: s.probability, rottingDays: s.rottingDays })),
  }));
}

/** What each label means. Hidden ones are included, marked, so a reader knows what a label on a record stands for. */
export async function listLabelDefinitions() {
  return (await listLabels()).map((l) => ({ name: l.name, description: l.description, hidden: l.hidden }));
}

/**
 * What the workspace sells: each product in the connected Stripe accounts'
 * subscriptions, with what the team says it delivers and how many clients
 * are on it now, plus products described before Stripe has them.
 */
export async function listServices() {
  const [described, usage] = await Promise.all([listProductDescriptions(), stripeProductUsage()]);
  const describe = productDescriber(described);
  const names = new Map<string, string>();
  for (const u of usage) names.set(productKey(u.name), u.name);
  for (const d of described) if (!names.has(productKey(d.name))) names.set(productKey(d.name), d.name);
  return [...names.values()]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, description: describe(name), clients: usage.find((u) => productKey(u.name) === productKey(name))?.clients ?? 0 }));
}

export const toUser = (u: typeof users.$inferSelect) => ({ id: u.id, name: u.name, email: u.email, role: u.role, title: u.title, active: !u.deactivatedAt && !!u.passwordHash });

/** A background run of the agent, in its API shape. */
export const toAgentTask = (r: typeof schema.agentRuns.$inferSelect) => ({
  id: r.id,
  title: r.title,
  request: r.prompt,
  source: r.source,
  status: r.status,
  result: r.result,
  error: r.error,
  costUsd: r.costMicroUsd / 1_000_000,
  personId: r.personId,
  organizationId: r.organizationId,
  clientId: r.clientId,
  batchId: r.batchId,
  createdAt: r.createdAt.toISOString(),
  startedAt: r.startedAt?.toISOString() ?? null,
  finishedAt: r.finishedAt?.toISOString() ?? null,
});

/** A skill in its API shape. Lists leave the instructions out: an agent reads the one it needs. */
export const toSkill = (s: SkillRow, opts: { brief?: boolean } = {}) => ({
  id: s.id,
  name: s.name,
  description: s.description,
  instructions: opts.brief ? null : s.instructions,
  mode: s.mode,
  scope: s.scope,
  enabled: s.enabled,
  ownerId: s.userId,
  ownerName: s.ownerName,
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt.toISOString(),
});

export const toScheduledJob = (j: JobRow) => ({
  id: j.id,
  name: j.name,
  request: j.prompt,
  every: j.every,
  time: j.time,
  weekday: j.weekday,
  monthDay: j.monthDay,
  onDate: j.onDate,
  schedule: cadenceLabel(j),
  scope: j.scope,
  enabled: j.enabled,
  nextRunAt: j.nextRunAt?.toISOString() ?? null,
  lastRunAt: j.lastRunAt?.toISOString() ?? null,
  lastTaskId: j.lastRunId,
  lastError: j.lastError,
  ownerId: j.userId,
  ownerName: j.ownerName,
  fromId: j.fromId,
  createdAt: j.createdAt.toISOString(),
});

/** A draft the agent wrote, in its API shape. */
export const toDraft = (d: typeof schema.agentDrafts.$inferSelect & { personName: string }, ctx: { origin: string }) => ({
  id: d.id,
  kind: d.kind,
  personId: d.personId,
  personName: d.personName,
  clientId: d.clientId,
  subject: d.subject,
  body: d.body,
  attachments: d.attachments ?? [],
  status: d.status,
  url: `${ctx.origin}/people/${d.personId}?draft=${d.id}`,
  createdAt: d.createdAt.toISOString(),
});

export async function listUsers() {
  const db = await getDb();
  return (await db.select().from(users).orderBy(asc(users.name))).map(toUser);
}

export async function listCustomFields(entityType?: EntityType) {
  const db = await getDb();
  const f = schema.customFields;
  const rows = await db
    .select()
    .from(f)
    .where(and(isNull(f.archivedAt), entityType ? eq(f.entityType, entityType) : undefined))
    .orderBy(asc(f.entityType), asc(f.position), asc(f.createdAt));
  return rows.map((r) => ({ id: r.id, entityType: r.entityType, key: r.key, label: r.label, type: r.type, options: r.options }));
}

// ─── Files ─────────────────────────────────────────────────────────────

type ApiFileRow = {
  id: string;
  name: string;
  contentType: string;
  size: number;
  description: string | null;
  folderId: string | null;
  publicToken: string | null;
  uploadedBy: string;
  createdAt: Date;
  chatMessageId: string | null;
  records: { entity: "person" | "organization" | "client"; id: string; name: string }[];
  score?: number | null;
};

/** A file in its API shape. `folders` is every folder (for its path); `team` names the uploader. */
export function toFile(f: ApiFileRow, ctx: { origin: string; folders: { id: string; name: string; parentId: string | null }[]; team: { id: string; name: string }[] }) {
  const uploader = ctx.team.find((m) => m.id === f.uploadedBy);
  return {
    id: f.id,
    name: f.name,
    contentType: f.contentType,
    size: f.size,
    description: f.description,
    records: f.records.map((r) => ({ type: r.entity, id: r.id, name: r.name })),
    folder: f.folderId ? { id: f.folderId, path: folderLabel(ctx.folders, f.folderId) } : null,
    visibility: f.publicToken ? ("public" as const) : ("internal" as const),
    publicUrl: f.publicToken ? `${ctx.origin}/share/${f.publicToken}` : null,
    url: `${ctx.origin}/api/files/${f.id}`,
    uploadedBy: uploader ? { id: uploader.id, name: uploader.name } : null,
    fromChat: !!f.chatMessageId,
    score: f.score ?? null,
    createdAt: f.createdAt.toISOString(),
  };
}

// ─── Team chat ───────────────────────────────────────────────────────────

/** Team chat messages in their API shape, with the names of who posted them and whom they mention. */
export async function toChatMessages(messages: ChatMessage[], ctx: Ctx) {
  const db = await getDb();
  const ids = [...new Set(messages.flatMap((m) => [m.userId, ...m.mentions]))];
  const team = ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : [];
  const name = (id: string) => team.find((u) => u.id === id)?.name ?? "Former teammate";
  return messages.map((m) => ({
    id: m.id,
    body: m.body,
    author: { id: m.userId, name: name(m.userId) },
    via: m.via,
    mentions: m.mentions.map((id) => ({ id, name: name(id) })),
    files: m.files.map((f) => ({ ...f, url: `${ctx.origin}/api/files/${f.id}` })),
    replyToId: m.replyTo?.id ?? null,
    agentTaskId: m.agentRun?.id ?? null,
    url: `${ctx.origin}/chat#m-${m.id}`,
    createdAt: iso(m.createdAt)!,
    editedAt: iso(m.editedAt),
  }));
}
