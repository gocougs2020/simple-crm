import "server-only";
import { and, asc, count, desc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { cache } from "react";
import { getDb, schema } from "@/db";
import { clientCategoryLabels, monthlyPriceSql, type ClientCategory } from "@/lib/constants";
import { clientAtOrganization, organizationsOfClient } from "@/lib/crm/client-organizations";
import { effectiveTags } from "@/lib/crm/labels";
import { orderPeople } from "@/lib/crm/people-order";
import { personName } from "@/lib/format";

const { people, organizations, clients, stages, personOrganizations } = schema;

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

/**
 * "At this organization" for lists, audiences and the API: the organization
 * itself, or one that is part of it when it's a parent organization. `col`
 * is the column holding the record's organization.
 */
export const inOrganizations = (col: SQL | typeof people.organizationId, ids: string[]) => {
  const list = sql.join(ids.map((x) => sql`${x}`), sql`, `);
  return sql`(${col} in (${list}) or ${col} in (select child.id from organizations child where child.parent_id in (${list}) and child.archived_at is null))`;
};
/** Which rows of a list: the tables load this many at a time as they're scrolled. */
export type Page = { offset?: number; limit?: number };
export const pageSize = 100;

const peopleSorts: Record<string, SQL | ReturnType<typeof sql>> = {
  name: sql`lower(${people.firstName} || ' ' || coalesce(${people.lastName}, ''))`,
  organization: sql`lower(${organizations.name})`,
  lastActivity: sql`${people.lastActivityAt}`,
  lastCampaign: sql`${people.lastCampaignAt}`,
  created: sql`${people.createdAt}`,
};

const ordered = (order: SQL, dir: "asc" | "desc") => (dir === "desc" ? sql`${order} desc nulls last` : sql`${order} asc nulls last`);

function peopleQuery(f: PeopleFilter) {
  const where: SQL[] = [isNull(people.archivedAt)];
  if (f.q?.trim()) {
    const t = likeTerm(f.q);
    where.push(or(ilike(sql`${people.firstName} || ' ' || coalesce(${people.lastName}, '')`, t), ilike(people.email, t), ilike(people.phone, t), ilike(sql`${people.otherEmails}::text`, t), ilike(sql`${people.otherPhones}::text`, t), ilike(organizations.name, t))!);
  }
  if (f.ownerId) where.push(f.ownerId === "none" ? isNull(people.ownerId) : eq(people.ownerId, f.ownerId));
  if (f.organizationId) where.push(inOrganizations(people.organizationId, [f.organizationId]));
  // Their own label, or one their organization carries.
  if (f.tag) where.push(sql`${effectiveTags} ? ${f.tag}`);
  const order = peopleSorts[f.sort ?? ""] ?? peopleSorts.name;
  const dir = f.dir ?? (f.sort === "lastActivity" || f.sort === "lastCampaign" || f.sort === "created" ? "desc" : "asc");
  return { where: and(...where), sort: ordered(order as SQL, dir) };
}

/**
 * One page of the People table. The page's ids are picked first (filter,
 * sort, offset: cheap, on the people table alone), and only those rows get
 * their organization, clients and next activity, so scrolling further never
 * makes Postgres work out the extras for rows it skips.
 */
export async function listPeople(f: PeopleFilter = {}, { offset = 0, limit = pageSize }: Page = {}) {
  const db = await getDb();
  const { where, sort } = peopleQuery(f);
  const page = db
    .select({ id: people.id, n: sql<number>`row_number() over (order by ${sort}, ${people.id})`.as("n") })
    .from(people)
    .leftJoin(organizations, eq(organizations.id, people.organizationId))
    .where(where)
    .orderBy(sort, asc(people.id))
    .limit(limit)
    .offset(offset)
    .as("page");
  return db
    .select({
      person: people,
      organizationName: organizations.name,
      /** Labels they carry from their organization. */
      organizationTags: organizations.tags,
      clientCategories: sql<string[]>`(select coalesce(json_agg(distinct c.category), '[]') from clients c where c.person_id = ${people.id} and c.archived_at is null)`,
      next: nextActivity("person_id", sql`${people.id}`),
    })
    .from(page)
    .innerJoin(people, eq(people.id, page.id))
    .leftJoin(organizations, eq(organizations.id, people.organizationId))
    .orderBy(asc(page.n));
}

/** How many people the People table holds with these filters, for its heading. */
export async function countPeople(f: PeopleFilter = {}) {
  const db = await getDb();
  const { where } = peopleQuery(f);
  const query = db.select({ n: count() }).from(people);
  const [row] = await (f.q?.trim() ? query.leftJoin(organizations, eq(organizations.id, people.organizationId)) : query).where(where);
  return row?.n ?? 0;
}

export const getPerson = cache(async (id: string) => {
  const db = await getDb();
  const [row] = await db
    .select({ person: people, organization: organizations })
    .from(people)
    .leftJoin(organizations, eq(organizations.id, people.organizationId))
    .where(eq(people.id, id))
    .limit(1);
  return row ?? null;
});

/** The organizations a person is also at, besides their main one (merged duplicates keep every one). */
export async function otherOrganizationsOf(personId: string) {
  const db = await getDb();
  return db
    .select({ organization: organizations })
    .from(personOrganizations)
    .innerJoin(organizations, eq(organizations.id, personOrganizations.organizationId))
    .where(and(eq(personOrganizations.personId, personId), isNull(organizations.archivedAt)))
    .orderBy(asc(organizations.name))
    .then((rows) => rows.map((r) => r.organization));
}

export async function allTags() {
  const db = await getDb();
  // People's own labels and their organizations', which they carry too.
  const rows = await db.execute<{ tag: string }>(
    sql`select distinct jsonb_array_elements_text(tags) as tag from people where archived_at is null union select jsonb_array_elements_text(tags) from organizations where archived_at is null order by 1`,
  );
  return ((rows as unknown as { rows?: { tag: string }[] }).rows ?? (rows as unknown as { tag: string }[])).map((r) => r.tag);
}

// ─── Organizations ───────────────────────────────────────────────────────

/** `parentId` is a parent organization's id (the organizations that are part of it), or "parents" for the parent organizations themselves. */
export type OrgFilter = { q?: string; ownerId?: string; parentId?: string; tag?: string; sort?: string; dir?: "asc" | "desc" };

// Qualified by hand: in a select with no joins Drizzle renders a column as a bare "id", which the subquery would read as its own.
const peopleCount = sql<number>`(select count(*)::int from people p where p.organization_id = "organizations"."id" and p.archived_at is null)`;

function organizationsQuery(f: OrgFilter) {
  const where: SQL[] = [isNull(organizations.archivedAt)];
  if (f.q?.trim()) {
    const t = likeTerm(f.q);
    where.push(or(ilike(organizations.name, t), ilike(organizations.domain, t), ilike(organizations.industry, t))!);
  }
  if (f.ownerId) where.push(f.ownerId === "none" ? isNull(organizations.ownerId) : eq(organizations.ownerId, f.ownerId));
  if (f.tag) where.push(sql`${organizations.tags} ? ${f.tag}`);
  if (f.parentId) where.push(f.parentId === "parents" ? eq(organizations.isParent, true) : eq(organizations.parentId, f.parentId));
  const sorts: Record<string, SQL> = {
    name: sql`lower(${organizations.name})`,
    lastActivity: sql`${organizations.lastActivityAt}`,
    created: sql`${organizations.createdAt}`,
    people: peopleCount,
  };
  const order = sorts[f.sort ?? ""] ?? sorts.name;
  const dir = f.dir ?? (["lastActivity", "created", "people"].includes(f.sort ?? "") ? "desc" : "asc");
  return { where: and(...where), sort: ordered(order, dir) };
}

/** One page of the Organizations table, picked like the People table's: ids first, extras only for the rows shown. */
export async function listOrganizations(f: OrgFilter = {}, { offset = 0, limit = pageSize }: Page = {}) {
  const db = await getDb();
  const { where, sort } = organizationsQuery(f);
  const page = db
    .select({ id: organizations.id, n: sql<number>`row_number() over (order by ${sort}, "organizations"."id")`.as("n") })
    .from(organizations)
    .where(where)
    .orderBy(sort, asc(organizations.id))
    .limit(limit)
    .offset(offset)
    .as("page");
  return db
    .select({
      organization: organizations,
      peopleCount,
      parentName: sql<string | null>`(select parent.name from organizations parent where parent.id = "organizations"."parent_id")`,
      clientCategories: sql<string[]>`(select coalesce(json_agg(distinct c.category), '[]') from clients c where (c.organization_id = "organizations"."id" or exists (select 1 from client_organizations co where co.client_id = c.id and co.organization_id = "organizations"."id")) and c.archived_at is null)`,
      next: nextActivity("organization_id", sql`"organizations"."id"`),
    })
    .from(page)
    .innerJoin(organizations, eq(organizations.id, page.id))
    .orderBy(asc(page.n));
}

/** How many organizations the Organizations table holds with these filters, for its heading. */
export async function countOrganizations(f: OrgFilter = {}) {
  const db = await getDb();
  const [row] = await db.select({ n: count() }).from(organizations).where(organizationsQuery(f).where);
  return row?.n ?? 0;
}

export const getOrganization = cache(async (id: string) => {
  const db = await getDb();
  const [row] = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
  return row ?? null;
});

/** Every parent organization, by name: the choices for an organization's parent and for filters. */
export async function parentOrganizations() {
  const db = await getDb();
  return db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(and(eq(organizations.isParent, true), isNull(organizations.archivedAt)))
    .orderBy(sql`lower(${organizations.name})`, asc(organizations.id));
}

/** The organizations that are part of a parent organization, by name, with how many people each has. */
export async function organizationsOf(parentId: string) {
  const db = await getDb();
  return db
    .select({ id: organizations.id, name: organizations.name, peopleCount })
    .from(organizations)
    .where(and(eq(organizations.parentId, parentId), isNull(organizations.archivedAt)))
    .orderBy(sql`lower(${organizations.name})`, asc(organizations.id));
}

export async function peopleOf(organizationId: string) {
  const db = await getDb();
  return db
    .select()
    .from(people)
    .where(
      and(
        or(eq(people.organizationId, organizationId), sql`exists (select 1 from ${personOrganizations} po where po.person_id = ${people.id} and po.organization_id = ${organizationId})`),
        isNull(people.archivedAt),
      ),
    )
    .orderBy(asc(people.firstName), asc(people.lastName));
}

// ─── Clients ─────────────────────────────────────────────────────────────

/** Monthly value of a client's subscriptions: open ones, or for past clients, what they had when they left. */
const monthly = (where: SQL) => sql<number>`(
  select coalesce(round(sum(${sql.raw(monthlyPriceSql)})), 0)::bigint
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
  /** A billing status from Stripe, or "none" for clients with no Stripe customer. */
  billing?: string;
  /** The name of a Stripe product they're subscribed to now. */
  stripeProduct?: string;
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
  if (f.organizationId) where.push(clientAtOrganization(f.organizationId));
  if (f.tag) where.push(sql`${clients.tags} ? ${f.tag}`);
  if (f.health) where.push(f.health === "none" ? isNull(clients.health) : eq(clients.health, f.health as never));
  if (f.churnReason) where.push(eq(clients.churnReason, f.churnReason));
  if (f.serviceId) where.push(sql`exists (select 1 from client_services cs where cs.client_id = ${clients.id} and cs.service_id = ${f.serviceId})`);
  if (f.billing) where.push(f.billing === "none" ? isNull(clients.stripeStatus) : eq(clients.stripeStatus, f.billing as never));
  if (f.stripeProduct) where.push(sql`${clients.stripeProducts} ? ${f.stripeProduct}`);
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
    stripeMrr: sql`${clients.stripeMrr}`,
    stripeCollected: sql`${clients.stripeCollected}`,
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
  const dir = f.dir ?? (["value", "mrr", "stripeMrr", "stripeCollected", "formerMrr", "startedOn", "endedOn", "lastActivity", "created"].includes(f.sort ?? "") ? "desc" : "asc");
  return db
    .select({
      // Only what the board, the table and the merge dialog show (no AI summary, notes or timestamps they don't use).
      client: {
        id: clients.id,
        name: clients.name,
        category: clients.category,
        createdAt: clients.createdAt,
        value: clients.value,
        stageId: clients.stageId,
        ownerId: clients.ownerId,
        personId: clients.personId,
        health: clients.health,
        churnReason: clients.churnReason,
        openToReturn: clients.openToReturn,
        lastActivityAt: clients.lastActivityAt,
        stageChangedAt: clients.stageChangedAt,
        expectedCloseDate: clients.expectedCloseDate,
        startedOn: clients.startedOn,
        endedOn: clients.endedOn,
        tags: clients.tags,
        custom: clients.custom,
        stripeStatus: clients.stripeStatus,
        stripeMrr: clients.stripeMrr,
        stripeOwed: clients.stripeOwed,
        stripeCollected: clients.stripeCollected,
        stripeProducts: clients.stripeProducts,
      },
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

export const getClient = cache(async (id: string) => {
  const db = await getDb();
  const [row] = await db
    .select({ client: clients, person: people, organization: organizations })
    .from(clients)
    .leftJoin(people, eq(people.id, clients.personId))
    .leftJoin(organizations, eq(organizations.id, clients.organizationId))
    .where(eq(clients.id, id))
    .limit(1);
  return row ?? null;
});

/** How someone comes to be on a client: its contact, added to it by hand, or at its organization. */
export type ClientPersonSource = "contact" | "added" | "organization";

/**
 * Everyone associated with a client: its contact first, then people added to
 * it by hand, then everyone at its organizations (decision makers first).
 * Each person once, under the closest of the three.
 */
export async function clientPeople(client: { id: string; personId: string | null; organizationId: string | null }) {
  const db = await getDb();
  const cp = schema.clientPeople;
  const added = sql<boolean>`exists (select 1 from ${cp} where ${cp.clientId} = ${client.id} and ${cp.personId} = ${people.id})`;
  // At any organization it's tied to: its main one, or one kept from a merge.
  const orgs = organizationsOfClient(client.id);
  const atOrganization = or(sql`${people.organizationId} in ${orgs}`, sql`exists (select 1 from ${personOrganizations} po where po.person_id = ${people.id} and po.organization_id in ${orgs})`);
  const rows = await db
    .select({ person: people, added })
    .from(people)
    .where(and(or(client.personId ? eq(people.id, client.personId) : undefined, added, atOrganization), isNull(people.archivedAt)))
    // The contact and the people added by hand come first, so a very large organization can't crowd them out of the limit.
    .orderBy(...(client.personId ? [sql`${people.id} = ${client.personId} desc`] : []), sql`${added} desc`, desc(people.decisionMaker), asc(people.firstName), asc(people.lastName))
    .limit(200);
  // Shown the contact first, then decision makers A to Z, then everyone else A to Z (src/lib/crm/people-order.ts).
  return orderPeople(
    rows.map((r) => ({ person: r.person, source: (r.person.id === client.personId ? "contact" : r.added ? "added" : "organization") as ClientPersonSource })),
    ({ person: p, source }) => ({ name: personName(p), contact: source === "contact", starred: p.decisionMaker }),
  );
}
export type ClientPerson = Awaited<ReturnType<typeof clientPeople>>[number];

/** The organizations a client is tied to besides its main one: kept from clients merged into it. */
export async function otherOrganizationsOfClient(clientId: string) {
  const db = await getDb();
  return db
    .select({ organization: organizations })
    .from(schema.clientOrganizations)
    .innerJoin(organizations, eq(organizations.id, schema.clientOrganizations.organizationId))
    .where(and(eq(schema.clientOrganizations.clientId, clientId), isNull(organizations.archivedAt)))
    .orderBy(asc(organizations.name))
    .then((rows) => rows.map((r) => r.organization));
}

/** Counts per category for the Clients tabs, so each tab says how many it holds. */
export async function clientCounts() {
  const db = await getDb();
  const rows = await db.select({ category: clients.category, n: count() }).from(clients).where(isNull(clients.archivedAt)).groupBy(clients.category);
  return Object.fromEntries(rows.map((r) => [r.category, r.n])) as Partial<Record<ClientCategory, number>>;
}

/** Every tag used on a client, for filters and campaign audiences. */
/** Every industry organizations have, for audience filters. */
export async function allIndustries() {
  const db = await getDb();
  const rows = await db
    .selectDistinct({ industry: organizations.industry })
    .from(organizations)
    .where(and(isNull(organizations.archivedAt), sql`coalesce(${organizations.industry}, '') <> ''`))
    .orderBy(organizations.industry);
  return rows.map((r) => r.industry!);
}

/** Every Stripe product a client is subscribed to now, for the Clients filter. */
export async function allStripeProducts() {
  const db = await getDb();
  const rows = await db.execute<{ name: string }>(sql`select distinct jsonb_array_elements_text(stripe_products) as name from clients where archived_at is null order by 1`);
  return ((rows as unknown as { rows?: { name: string }[] }).rows ?? (rows as unknown as { name: string }[])).map((r) => r.name);
}

export async function allClientTags() {
  const db = await getDb();
  const rows = await db.execute<{ tag: string }>(sql`select distinct jsonb_array_elements_text(tags) as tag from clients where archived_at is null order by 1`);
  return ((rows as unknown as { rows?: { tag: string }[] }).rows ?? (rows as unknown as { tag: string }[])).map((r) => r.tag);
}

/** The services a client has had, current first. */
export async function servicesOf(clientId: string) {
  const db = await getDb();
  const { clientServices, services, servicePlans } = schema;
  return db
    .select({ id: clientServices.id, serviceId: clientServices.serviceId, planId: clientServices.planId, name: sql<string>`${services.name} || coalesce(' · ' || ${servicePlans.name}, '')`, service: services.name, plan: servicePlans.name, price: clientServices.price, interval: clientServices.interval, startedOn: clientServices.startedOn, endedOn: clientServices.endedOn, note: clientServices.note })
    .from(clientServices)
    .innerJoin(services, eq(services.id, clientServices.serviceId))
    .leftJoin(servicePlans, eq(servicePlans.id, clientServices.planId))
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

/** Clients linked to a person directly (as the contact, or added to its people) or through their organization, for the person's page. */
export async function clientsOfPerson(personId: string, organizationId: string | null) {
  const db = await getDb();
  const theirs = or(eq(clients.personId, personId), sql`exists (select 1 from client_people cp where cp.client_id = ${clients.id} and cp.person_id = ${personId})`)!;
  return db
    .select({ id: clients.id, name: clients.name, category: clients.category, value: clients.value, stageName: stages.name, mrr: monthly(activeService) })
    .from(clients)
    .innerJoin(stages, eq(stages.id, clients.stageId))
    .where(and(isNull(clients.archivedAt), organizationId ? or(theirs, clientAtOrganization(organizationId)) : theirs))
    .orderBy(asc(clients.category), desc(clients.updatedAt))
    .limit(50);
}

export async function clientsOfOrganization(organizationId: string) {
  const db = await getDb();
  return db
    .select({ id: clients.id, name: clients.name, category: clients.category, value: clients.value, stageName: stages.name, mrr: monthly(activeService) })
    .from(clients)
    .innerJoin(stages, eq(stages.id, clients.stageId))
    .where(and(isNull(clients.archivedAt), clientAtOrganization(organizationId)))
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

