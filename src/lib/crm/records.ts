import "server-only";
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { clientCategoryLabels, type ClientCategory } from "@/lib/constants";

const { people, organizations, clients, stages } = schema;

/** Escapes % and _ so a search for "50%" means the literal text. */
export const likeTerm = (q: string) => `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Each record's next open task or planned activity: the one the board and tables show. */
function nextActivity(col: "person_id" | "organization_id" | "client_id", idCol: SQL) {
  return sql<{ id: string; type: string; subject: string | null; dueAt: string | null; dueHasTime: boolean } | null>`(
    select json_build_object('id', a.id, 'type', a.type, 'subject', a.subject, 'dueAt', a.due_at, 'dueHasTime', a.due_has_time)
    from activities a
    where a.${sql.raw(col)} = ${idCol} and a.completed_at is null and a.due_at is not null
    order by a.due_at asc limit 1
  )`;
}

// ─── People ──────────────────────────────────────────────────────────────

export type PeopleFilter = { q?: string; ownerId?: string; organizationId?: string; tag?: string; sort?: string; dir?: "asc" | "desc" };

const peopleSorts: Record<string, SQL | ReturnType<typeof sql>> = {
  name: sql`lower(${people.firstName} || ' ' || coalesce(${people.lastName}, ''))`,
  organization: sql`lower(${organizations.name})`,
  lastActivity: sql`${people.lastActivityAt}`,
  created: sql`${people.createdAt}`,
};

export async function listPeople(f: PeopleFilter = {}) {
  const db = await getDb();
  const where: SQL[] = [isNull(people.archivedAt)];
  if (f.q?.trim()) {
    const t = likeTerm(f.q);
    where.push(or(ilike(sql`${people.firstName} || ' ' || coalesce(${people.lastName}, '')`, t), ilike(people.email, t), ilike(people.phone, t), ilike(organizations.name, t))!);
  }
  if (f.ownerId) where.push(f.ownerId === "none" ? isNull(people.ownerId) : eq(people.ownerId, f.ownerId));
  if (f.organizationId) where.push(eq(people.organizationId, f.organizationId));
  if (f.tag) where.push(sql`${people.tags} ? ${f.tag}`);
  const order = peopleSorts[f.sort ?? ""] ?? peopleSorts.name;
  const dir = f.dir ?? (f.sort === "lastActivity" || f.sort === "created" ? "desc" : "asc");
  return db
    .select({
      person: people,
      organizationName: organizations.name,
      clientCategories: sql<string[]>`(select coalesce(json_agg(distinct c.category), '[]') from clients c where c.person_id = ${people.id} and c.archived_at is null)`,
      next: nextActivity("person_id", sql`${people.id}`),
    })
    .from(people)
    .leftJoin(organizations, eq(organizations.id, people.organizationId))
    .where(and(...where))
    .orderBy(dir === "desc" ? sql`${order} desc nulls last` : sql`${order} asc nulls last`, asc(people.id))
    .limit(500);
}

export async function getPerson(id: string) {
  const db = await getDb();
  const [row] = await db
    .select({ person: people, organization: organizations })
    .from(people)
    .leftJoin(organizations, eq(organizations.id, people.organizationId))
    .where(eq(people.id, id))
    .limit(1);
  return row ?? null;
}

export async function allTags() {
  const db = await getDb();
  const rows = await db.execute<{ tag: string }>(sql`select distinct jsonb_array_elements_text(tags) as tag from people where archived_at is null order by 1`);
  return ((rows as unknown as { rows?: { tag: string }[] }).rows ?? (rows as unknown as { tag: string }[])).map((r) => r.tag);
}

// ─── Organizations ───────────────────────────────────────────────────────

export type OrgFilter = { q?: string; ownerId?: string; sort?: string; dir?: "asc" | "desc" };

export async function listOrganizations(f: OrgFilter = {}) {
  const db = await getDb();
  const where: SQL[] = [isNull(organizations.archivedAt)];
  if (f.q?.trim()) {
    const t = likeTerm(f.q);
    where.push(or(ilike(organizations.name, t), ilike(organizations.domain, t), ilike(organizations.industry, t))!);
  }
  if (f.ownerId) where.push(f.ownerId === "none" ? isNull(organizations.ownerId) : eq(organizations.ownerId, f.ownerId));
  const sorts: Record<string, SQL> = {
    name: sql`lower(${organizations.name})`,
    lastActivity: sql`${organizations.lastActivityAt}`,
    created: sql`${organizations.createdAt}`,
    people: sql`2`,
  };
  const order = sorts[f.sort ?? ""] ?? sorts.name;
  const dir = f.dir ?? (["lastActivity", "created", "people"].includes(f.sort ?? "") ? "desc" : "asc");
  return db
    .select({
      organization: organizations,
      peopleCount: sql<number>`(select count(*)::int from people p where p.organization_id = ${organizations.id} and p.archived_at is null)`,
      clientCategories: sql<string[]>`(select coalesce(json_agg(distinct c.category), '[]') from clients c where c.organization_id = ${organizations.id} and c.archived_at is null)`,
      next: nextActivity("organization_id", sql`${organizations.id}`),
    })
    .from(organizations)
    .where(and(...where))
    .orderBy(dir === "desc" ? sql`${order} desc nulls last` : sql`${order} asc nulls last`, asc(organizations.id))
    .limit(500);
}

export async function getOrganization(id: string) {
  const db = await getDb();
  const [row] = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
  return row ?? null;
}

export async function peopleOf(organizationId: string) {
  const db = await getDb();
  return db
    .select()
    .from(people)
    .where(and(eq(people.organizationId, organizationId), isNull(people.archivedAt)))
    .orderBy(asc(people.firstName), asc(people.lastName));
}

// ─── Clients ─────────────────────────────────────────────────────────────

/** Monthly value of a client's subscriptions: open ones, or for past clients, what they had when they left. */
const monthly = (where: SQL) => sql<number>`(
  select coalesce(round(sum(case cs.interval when 'month' then cs.price when 'quarter' then cs.price / 3.0 when 'year' then cs.price / 12.0 else 0 end)), 0)::bigint
  from client_services cs where cs.client_id = ${clients.id} and ${where}
)`;
const activeService = sql`(cs.ended_on is null or cs.ended_on > current_date)`;

export type ClientFilter = {
  category?: ClientCategory;
  pipelineId?: string;
  ownerId?: string;
  q?: string;
  personId?: string;
  organizationId?: string;
  tag?: string;
  serviceId?: string;
  health?: string;
  churnReason?: string;
  sort?: string;
  dir?: "asc" | "desc";
};

export async function listClients(f: ClientFilter = {}) {
  const db = await getDb();
  const where: SQL[] = [isNull(clients.archivedAt)];
  if (f.category) where.push(eq(clients.category, f.category));
  if (f.pipelineId) where.push(eq(clients.pipelineId, f.pipelineId));
  if (f.ownerId) where.push(f.ownerId === "none" ? isNull(clients.ownerId) : eq(clients.ownerId, f.ownerId));
  if (f.personId) where.push(eq(clients.personId, f.personId));
  if (f.organizationId) where.push(eq(clients.organizationId, f.organizationId));
  if (f.tag) where.push(sql`${clients.tags} ? ${f.tag}`);
  if (f.health) where.push(f.health === "none" ? isNull(clients.health) : eq(clients.health, f.health as never));
  if (f.churnReason) where.push(eq(clients.churnReason, f.churnReason));
  if (f.serviceId) where.push(sql`exists (select 1 from client_services cs where cs.client_id = ${clients.id} and cs.service_id = ${f.serviceId})`);
  if (f.q?.trim()) {
    const t = likeTerm(f.q);
    where.push(or(ilike(clients.name, t), ilike(organizations.name, t), ilike(sql`${people.firstName} || ' ' || coalesce(${people.lastName}, '')`, t))!);
  }
  const mrr = monthly(activeService);
  // What they paid when they last left: the services that ended on their latest end date, not every period they've ever had.
  const formerMrr = monthly(sql`cs.ended_on = (select max(x.ended_on) from client_services x where x.client_id = ${clients.id})`);
  const sorts: Record<string, SQL> = {
    name: sql`lower(${clients.name})`,
    value: sql`${clients.value}`,
    mrr: sql`${mrr}`,
    formerMrr: sql`${formerMrr}`,
    stage: sql`${stages.position}`,
    expectedClose: sql`${clients.expectedCloseDate}`,
    startedOn: sql`${clients.startedOn}`,
    endedOn: sql`${clients.endedOn}`,
    lastActivity: sql`${clients.lastActivityAt}`,
    created: sql`${clients.createdAt}`,
    organization: sql`lower(${organizations.name})`,
  };
  const order = f.sort ? (sorts[f.sort] ?? sorts.created) : null;
  const dir = f.dir ?? (["value", "mrr", "formerMrr", "startedOn", "endedOn", "lastActivity", "created"].includes(f.sort ?? "") ? "desc" : "asc");
  return db
    .select({
      client: clients,
      stageName: stages.name,
      stagePosition: stages.position,
      organizationName: organizations.name,
      personFirstName: people.firstName,
      personLastName: people.lastName,
      personEmail: people.email,
      mrr,
      formerMrr,
      services: sql<{ name: string; active: boolean }[]>`(
        select coalesce(json_agg(json_build_object('name', s.name, 'active', ${activeService}) order by s.position, s.name), '[]')
        from client_services cs join services s on s.id = cs.service_id where cs.client_id = ${clients.id}
      )`,
      next: nextActivity("client_id", sql`${clients.id}`),
    })
    .from(clients)
    .innerJoin(stages, eq(stages.id, clients.stageId))
    .leftJoin(organizations, eq(organizations.id, clients.organizationId))
    .leftJoin(people, eq(people.id, clients.personId))
    .where(and(...where))
    .orderBy(...(order ? [dir === "desc" ? sql`${order} desc nulls last` : sql`${order} asc nulls last`] : [asc(stages.position), asc(clients.rank)]), asc(clients.id))
    .limit(1000);
}

export type ClientRow = Awaited<ReturnType<typeof listClients>>[number];

export async function getClient(id: string) {
  const db = await getDb();
  const [row] = await db
    .select({ client: clients, person: people, organization: organizations })
    .from(clients)
    .leftJoin(people, eq(people.id, clients.personId))
    .leftJoin(organizations, eq(organizations.id, clients.organizationId))
    .where(eq(clients.id, id))
    .limit(1);
  return row ?? null;
}

/** Counts per category for the Clients tabs, so each tab says how many it holds. */
export async function clientCounts() {
  const db = await getDb();
  const rows = await db.select({ category: clients.category, n: count() }).from(clients).where(isNull(clients.archivedAt)).groupBy(clients.category);
  return Object.fromEntries(rows.map((r) => [r.category, r.n])) as Partial<Record<ClientCategory, number>>;
}

/** Every tag used on a client, for filters and campaign audiences. */
export async function allClientTags() {
  const db = await getDb();
  const rows = await db.execute<{ tag: string }>(sql`select distinct jsonb_array_elements_text(tags) as tag from clients where archived_at is null order by 1`);
  return ((rows as unknown as { rows?: { tag: string }[] }).rows ?? (rows as unknown as { tag: string }[])).map((r) => r.tag);
}

/** The services a client has had, current first. */
export async function servicesOf(clientId: string) {
  const db = await getDb();
  const { clientServices, services } = schema;
  return db
    .select({ id: clientServices.id, serviceId: clientServices.serviceId, name: services.name, price: clientServices.price, interval: clientServices.interval, startedOn: clientServices.startedOn, endedOn: clientServices.endedOn, note: clientServices.note })
    .from(clientServices)
    .innerJoin(services, eq(services.id, clientServices.serviceId))
    .where(eq(clientServices.clientId, clientId))
    .orderBy(sql`${clientServices.endedOn} desc nulls first`, asc(services.position), asc(services.name));
}

export type ClientServiceRow = Awaited<ReturnType<typeof servicesOf>>[number];

/** Performance numbers for a client, oldest first per label, so the card can show the latest and the trend. */
export async function metricsOf(clientId: string) {
  const db = await getDb();
  const m = schema.clientMetrics;
  return db.select().from(m).where(eq(m.clientId, clientId)).orderBy(asc(m.label), asc(m.period), asc(m.createdAt)).limit(1000);
}

/** Interactions (calls, emails, texts, meetings) in the last 30 and 90 days, and the most recent one. */
export async function interactionSummary(clientId: string) {
  const db = await getDb();
  const [row] = await db
    .select({
      last30: sql<number>`count(*) filter (where coalesce(occurred_at, created_at) > now() - interval '30 days')::int`,
      last90: sql<number>`count(*) filter (where coalesce(occurred_at, created_at) > now() - interval '90 days')::int`,
      lastAt: sql<string | null>`max(coalesce(occurred_at, created_at))`,
      inbound90: sql<number>`count(*) filter (where direction = 'inbound' and coalesce(occurred_at, created_at) > now() - interval '90 days')::int`,
      /** Nothing in the last 30 days: time for a check-in. */
      quiet: sql<boolean>`coalesce(max(coalesce(occurred_at, created_at)) < now() - interval '30 days', true)`,
    })
    .from(schema.activities)
    .where(and(eq(schema.activities.clientId, clientId), inArray(schema.activities.type, ["call", "email", "text", "meeting"]), or(isNotNull(schema.activities.completedAt), isNull(schema.activities.dueAt))));
  return row;
}

/** Clients linked to a person directly or through their organization, for the person's page. */
export async function clientsOfPerson(personId: string, organizationId: string | null) {
  const db = await getDb();
  return db
    .select({ id: clients.id, name: clients.name, category: clients.category, value: clients.value, stageName: stages.name, mrr: monthly(activeService) })
    .from(clients)
    .innerJoin(stages, eq(stages.id, clients.stageId))
    .where(and(isNull(clients.archivedAt), organizationId ? or(eq(clients.personId, personId), eq(clients.organizationId, organizationId)) : eq(clients.personId, personId)))
    .orderBy(asc(clients.category), desc(clients.updatedAt))
    .limit(50);
}

export async function clientsOfOrganization(organizationId: string) {
  const db = await getDb();
  return db
    .select({ id: clients.id, name: clients.name, category: clients.category, value: clients.value, stageName: stages.name, mrr: monthly(activeService) })
    .from(clients)
    .innerJoin(stages, eq(stages.id, clients.stageId))
    .where(and(isNull(clients.archivedAt), eq(clients.organizationId, organizationId)))
    .orderBy(asc(clients.category), desc(clients.updatedAt))
    .limit(50);
}

/** For the home page: prospects and their value per stage of one pipeline. */
export async function pipelineSummary(pipelineId: string) {
  const db = await getDb();
  return db
    .select({ stageId: clients.stageId, n: count(), value: sql<number>`coalesce(sum(${clients.value}), 0)::bigint` })
    .from(clients)
    .where(and(eq(clients.pipelineId, pipelineId), isNull(clients.archivedAt)))
    .groupBy(clients.stageId);
}

// ─── Lookups for pickers ─────────────────────────────────────────────────

/** Typeahead for linking a person, organization or client. */
export async function lookup(kind: "person" | "organization" | "client", q: string) {
  const db = await getDb();
  const t = likeTerm(q);
  if (kind === "person") {
    const rows = await db
      .select({ id: people.id, firstName: people.firstName, lastName: people.lastName, email: people.email, organizationId: people.organizationId, organizationName: organizations.name })
      .from(people)
      .leftJoin(organizations, eq(organizations.id, people.organizationId))
      .where(and(isNull(people.archivedAt), or(ilike(sql`${people.firstName} || ' ' || coalesce(${people.lastName}, '')`, t), ilike(people.email, t))))
      .orderBy(desc(people.lastActivityAt))
      .limit(8);
    return rows.map((r) => ({ id: r.id, label: [r.firstName, r.lastName].filter(Boolean).join(" "), detail: r.organizationName ?? r.email ?? undefined, organizationId: r.organizationId }));
  }
  if (kind === "organization") {
    const rows = await db
      .select({ id: organizations.id, name: organizations.name, domain: organizations.domain })
      .from(organizations)
      .where(and(isNull(organizations.archivedAt), or(ilike(organizations.name, t), ilike(organizations.domain, t))))
      .orderBy(asc(organizations.name))
      .limit(8);
    return rows.map((r) => ({ id: r.id, label: r.name, detail: r.domain ?? undefined }));
  }
  const rows = await db
    .select({ id: clients.id, name: clients.name, category: clients.category, organizationName: organizations.name, personId: clients.personId, organizationId: clients.organizationId })
    .from(clients)
    .leftJoin(organizations, eq(organizations.id, clients.organizationId))
    .where(and(isNull(clients.archivedAt), or(ilike(clients.name, t), ilike(organizations.name, t))))
    .orderBy(desc(clients.updatedAt))
    .limit(8);
  return rows.map((r) => ({
    id: r.id,
    label: r.name,
    detail: [clientCategoryLabels[r.category].one, r.organizationName !== r.name ? r.organizationName : null].filter(Boolean).join(" · "),
    personId: r.personId,
    organizationId: r.organizationId,
  }));
}

/** The command palette: a few of each kind, best matches first. */
export async function globalSearch(q: string) {
  if (q.trim().length < 1) return { people: [], organizations: [], clients: [] };
  const [p, o, c] = await Promise.all([lookup("person", q), lookup("organization", q), lookup("client", q)]);
  return { people: p.slice(0, 5), organizations: o.slice(0, 5), clients: c.slice(0, 5) };
}


// ─── Files ───────────────────────────────────────────────────────────────

/** Every file, newest first, with the records it belongs to. */
export async function listFiles(f: { q?: string; uploadedBy?: string }) {
  const db = await getDb();
  const { files } = schema;
  const where: SQL[] = [isNull(files.deletedAt)];
  if (f.q?.trim()) where.push(ilike(files.name, likeTerm(f.q)));
  if (f.uploadedBy) where.push(eq(files.uploadedBy, f.uploadedBy));
  return db
    .select({
      file: files,
      personName: sql<string | null>`case when ${people.id} is null then null else ${people.firstName} || coalesce(' ' || ${people.lastName}, '') end`,
      organizationName: organizations.name,
      clientName: clients.name,
    })
    .from(files)
    .leftJoin(people, eq(people.id, files.personId))
    .leftJoin(organizations, eq(organizations.id, files.organizationId))
    .leftJoin(clients, eq(clients.id, files.clientId))
    .where(and(...where))
    .orderBy(desc(files.createdAt))
    .limit(500);
}
