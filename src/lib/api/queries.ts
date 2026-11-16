import "server-only";
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/db";
import type { ActivityType, EntityType } from "@/lib/constants";
import { actorUserId, type Actor } from "@/lib/crm/actor";
import { timeline } from "@/lib/crm/activities";
import { likeTerm } from "@/lib/crm/records";
import { ActionError, NotFoundError } from "@/lib/errors";
import { htmlToText } from "@/lib/safe-html";

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

type RecordFilter = { q?: string; ownerId?: string; updatedSince?: string; includeArchived?: boolean; limit?: number; cursor?: string };

function common(a: Actor, t: typeof people | typeof organizations | typeof clients, f: RecordFilter) {
  const where: (SQL | undefined)[] = [];
  if (!f.includeArchived) where.push(isNull(t.archivedAt));
  where.push(whoFilter(a, t.ownerId, f.ownerId));
  if (f.updatedSince) where.push(gte(t.updatedAt, new Date(f.updatedSince)));
  where.push(after(f.cursor, t.createdAt, t.id, "desc"));
  return where;
}

// ─── People ──────────────────────────────────────────────────────────────

const personSelect = { person: people, organizationName: organizations.name, key: exact(people.createdAt) };
type PersonRow = { person: typeof people.$inferSelect; organizationName: string | null };

function toPerson(ctx: Ctx, r: PersonRow) {
  const p = r.person;
  return {
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    name: fullName(p.firstName, p.lastName),
    email: p.email,
    phone: p.phone,
    title: p.title,
    organizationId: p.organizationId,
    organization: p.organizationId && r.organizationName ? { id: p.organizationId, name: r.organizationName } : null,
    ownerId: p.ownerId,
    tags: p.tags,
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
    where.push(or(ilike(sql`${people.firstName} || ' ' || coalesce(${people.lastName}, '')`, t), ilike(people.email, t), ilike(people.phone, t), ilike(organizations.name, t)));
  }
  if (f.organizationId) where.push(eq(people.organizationId, f.organizationId));
  if (f.email) where.push(eq(people.email, f.email));
  if (f.tag) where.push(sql`${people.tags} ? ${f.tag}`);
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
const orgSelect = { organization: organizations, peopleCount, key: exact(organizations.createdAt) };

function toOrganization(ctx: Ctx, r: { organization: typeof organizations.$inferSelect; peopleCount: number }) {
  const o = r.organization;
  return {
    id: o.id,
    name: o.name,
    domain: o.domain,
    phone: o.phone,
    address: o.address,
    industry: o.industry,
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

export async function listOrganizations(a: Actor, ctx: Ctx, f: RecordFilter & { domain?: string }) {
  const db = await getDb();
  const limit = f.limit ?? 50;
  const where = common(a, organizations, f);
  if (f.q) {
    const t = likeTerm(f.q);
    where.push(or(ilike(organizations.name, t), ilike(organizations.domain, t), ilike(organizations.industry, t)));
  }
  if (f.domain) where.push(eq(organizations.domain, f.domain.replace(/^https?:\/\//, "").replace(/\/$/, "")));
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

const mrr = sql<number>`(
  select coalesce(round(sum(case cs.interval when 'month' then cs.price when 'quarter' then cs.price / 3.0 when 'year' then cs.price / 12.0 else 0 end)), 0)::bigint
  from client_services cs where cs.client_id = ${clients.id} and (cs.ended_on is null or cs.ended_on > current_date)
)`;
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
    stripeCustomerId: c.stripeCustomerId,
    tags: c.tags,
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
  f: RecordFilter & { category?: string; pipelineId?: string; stageId?: string; personId?: string; organizationId?: string; health?: string; tag?: string },
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
  if (f.organizationId) where.push(eq(clients.organizationId, f.organizationId));
  if (f.health) where.push(eq(clients.health, f.health as never));
  if (f.tag) where.push(sql`${clients.tags} ? ${f.tag}`);
  const rows = await selectClients(and(...where), limit + 1);
  return page(rows, limit, (r) => r.client.id, (r) => toClient(ctx, r));
}

export async function getClient(ctx: Ctx, id: string) {
  const [row] = await selectClients(eq(clients.id, id), 1);
  if (!row) throw new NotFoundError("There's no client with that id.");
  return toClient(ctx, row);
}

export async function clientServices(clientId: string) {
  const db = await getDb();
  await assertExists("client", clientId);
  const rows = await db
    .select({ cs: schema.clientServices, name: schema.services.name, position: schema.services.position })
    .from(schema.clientServices)
    .innerJoin(schema.services, eq(schema.services.id, schema.clientServices.serviceId))
    .where(eq(schema.clientServices.clientId, clientId))
    .orderBy(asc(schema.services.position), asc(schema.services.name));
  const today = new Date().toISOString().slice(0, 10);
  return rows.map(({ cs, name }) => ({
    id: cs.id,
    serviceId: cs.serviceId,
    name,
    price: Number(cs.price),
    interval: cs.interval,
    startedOn: cs.startedOn,
    endedOn: cs.endedOn,
    active: !cs.endedOn || cs.endedOn > today,
    note: cs.note,
  }));
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
};
type ActivityRowLike = { activity: typeof activities.$inferSelect; personName: string | null; organizationName: string | null; clientName: string | null };

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
    personId: x.personId,
    person: ref(x.personId, r.personName),
    organizationId: x.organizationId,
    organization: ref(x.organizationId, r.organizationName),
    clientId: x.clientId,
    client: ref(x.clientId, r.clientName),
    userId: x.userId,
    assigneeId: x.assigneeId,
    apiKeyId: x.apiKeyId,
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
  limit?: number;
  cursor?: string;
};

export async function listActivities(a: Actor, f: ActivityListFilter) {
  const limit = f.limit ?? 50;
  const where: (SQL | undefined)[] = [];
  if (f.types?.length) where.push(inArray(activities.type, f.types));
  if (f.status === "planned") where.push(isNull(activities.completedAt), isNotNull(activities.dueAt));
  if (f.status === "done") where.push(or(isNotNull(activities.completedAt), isNull(activities.dueAt)));
  where.push(whoFilter(a, activities.assigneeId, f.assigneeId));
  if (f.personId) where.push(eq(activities.personId, f.personId));
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

export async function recordTimeline(entity: EntityType, id: string, limit = 50) {
  await assertExists(entity, id);
  const t = await timeline(entity, id);
  const event = (e: typeof schema.events.$inferSelect) => ({ id: e.id, action: e.action, data: e.data, userId: e.userId, apiKeyId: e.apiKeyId, createdAt: iso(e.createdAt)! });
  const history = [...t.pinned, ...t.past].slice(0, limit).map((i) => {
    if (i.kind === "activity") return { kind: "activity" as const, at: i.at, activity: toActivity(i.row) };
    if (i.kind === "event") return { kind: "event" as const, at: i.at, event: event(i.event) };
    return { kind: "file" as const, at: i.at, file: { id: i.file.id, name: i.file.name, size: i.file.size, contentType: i.file.contentType } };
  });
  return { planned: t.planned.map(toActivity), history, lastContactAt: t.lastContactAt };
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

export async function listServices() {
  const db = await getDb();
  const rows = await db.select().from(schema.services).orderBy(asc(schema.services.position), asc(schema.services.name));
  return rows.map((s) => ({ id: s.id, name: s.name, description: s.description, price: Number(s.price), interval: s.interval, archived: !!s.archivedAt }));
}

export const toUser = (u: typeof users.$inferSelect) => ({ id: u.id, name: u.name, email: u.email, role: u.role, title: u.title, active: !u.deactivatedAt && !!u.passwordHash });

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
