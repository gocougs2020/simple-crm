import "server-only";
import { and, asc, count, desc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";

const { people, organizations, deals, stages } = schema;

/** Escapes % and _ so a search for "50%" means the literal text. */
export const likeTerm = (q: string) => `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Each record's next open task or planned activity: the one the board and tables show. */
function nextActivity(col: "person_id" | "organization_id" | "deal_id", idCol: SQL) {
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
      openDeals: sql<number>`(select count(*)::int from deals d where d.person_id = ${people.id} and d.status = 'open' and d.archived_at is null)`,
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
    deals: sql`3`,
  };
  const order = sorts[f.sort ?? ""] ?? sorts.name;
  const dir = f.dir ?? (["lastActivity", "created", "people", "deals"].includes(f.sort ?? "") ? "desc" : "asc");
  return db
    .select({
      organization: organizations,
      peopleCount: sql<number>`(select count(*)::int from people p where p.organization_id = ${organizations.id} and p.archived_at is null)`,
      openDeals: sql<number>`(select count(*)::int from deals d where d.organization_id = ${organizations.id} and d.status = 'open' and d.archived_at is null)`,
      openValue: sql<number>`(select coalesce(sum(d.value), 0)::bigint from deals d where d.organization_id = ${organizations.id} and d.status = 'open' and d.archived_at is null)`,
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

// ─── Deals ───────────────────────────────────────────────────────────────

export type DealFilter = { pipelineId?: string; status?: "open" | "won" | "lost" | "all"; ownerId?: string; q?: string; personId?: string; organizationId?: string; sort?: string; dir?: "asc" | "desc" };

export async function listDeals(f: DealFilter = {}) {
  const db = await getDb();
  const where: SQL[] = [isNull(deals.archivedAt)];
  if (f.pipelineId) where.push(eq(deals.pipelineId, f.pipelineId));
  if (f.status && f.status !== "all") where.push(eq(deals.status, f.status));
  if (f.ownerId) where.push(f.ownerId === "none" ? isNull(deals.ownerId) : eq(deals.ownerId, f.ownerId));
  if (f.personId) where.push(eq(deals.personId, f.personId));
  if (f.organizationId) where.push(eq(deals.organizationId, f.organizationId));
  if (f.q?.trim()) {
    const t = likeTerm(f.q);
    where.push(or(ilike(deals.title, t), ilike(organizations.name, t), ilike(sql`${people.firstName} || ' ' || coalesce(${people.lastName}, '')`, t))!);
  }
  const sorts: Record<string, SQL> = {
    title: sql`lower(${deals.title})`,
    value: sql`${deals.value}`,
    stage: sql`${stages.position}`,
    expectedClose: sql`${deals.expectedCloseDate}`,
    lastActivity: sql`${deals.lastActivityAt}`,
    created: sql`${deals.createdAt}`,
    organization: sql`lower(${organizations.name})`,
  };
  const order = f.sort ? (sorts[f.sort] ?? sorts.created) : null;
  const dir = f.dir ?? (["value", "lastActivity", "created"].includes(f.sort ?? "") ? "desc" : "asc");
  return db
    .select({
      deal: deals,
      stageName: stages.name,
      stagePosition: stages.position,
      organizationName: organizations.name,
      personFirstName: people.firstName,
      personLastName: people.lastName,
      next: nextActivity("deal_id", sql`${deals.id}`),
    })
    .from(deals)
    .innerJoin(stages, eq(stages.id, deals.stageId))
    .leftJoin(organizations, eq(organizations.id, deals.organizationId))
    .leftJoin(people, eq(people.id, deals.personId))
    .where(and(...where))
    .orderBy(...(order ? [dir === "desc" ? sql`${order} desc nulls last` : sql`${order} asc nulls last`] : [asc(stages.position), asc(deals.rank)]), asc(deals.id))
    .limit(1000);
}

export type DealRow = Awaited<ReturnType<typeof listDeals>>[number];

export async function getDeal(id: string) {
  const db = await getDb();
  const [row] = await db
    .select({ deal: deals, person: people, organization: organizations })
    .from(deals)
    .leftJoin(people, eq(people.id, deals.personId))
    .leftJoin(organizations, eq(organizations.id, deals.organizationId))
    .where(eq(deals.id, id))
    .limit(1);
  return row ?? null;
}

/** For the home page: open deal count and value per stage of one pipeline. */
export async function pipelineSummary(pipelineId: string) {
  const db = await getDb();
  return db
    .select({ stageId: deals.stageId, n: count(), value: sql<number>`coalesce(sum(${deals.value}), 0)::bigint` })
    .from(deals)
    .where(and(eq(deals.pipelineId, pipelineId), eq(deals.status, "open"), isNull(deals.archivedAt)))
    .groupBy(deals.stageId);
}

// ─── Lookups for pickers ─────────────────────────────────────────────────

/** Typeahead for linking a person, organization or deal. */
export async function lookup(kind: "person" | "organization" | "deal", q: string) {
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
    .select({ id: deals.id, title: deals.title, status: deals.status, organizationName: organizations.name, personId: deals.personId, organizationId: deals.organizationId })
    .from(deals)
    .leftJoin(organizations, eq(organizations.id, deals.organizationId))
    .where(and(isNull(deals.archivedAt), ilike(deals.title, t)))
    .orderBy(desc(deals.updatedAt))
    .limit(8);
  return rows.map((r) => ({ id: r.id, label: r.title, detail: [r.organizationName, r.status !== "open" ? r.status : null].filter(Boolean).join(" · ") || undefined, personId: r.personId, organizationId: r.organizationId }));
}

/** The command palette: a few of each kind, best matches first. */
export async function globalSearch(q: string) {
  if (q.trim().length < 1) return { people: [], organizations: [], deals: [] };
  const [p, o, d] = await Promise.all([lookup("person", q), lookup("organization", q), lookup("deal", q)]);
  return { people: p.slice(0, 5), organizations: o.slice(0, 5), deals: d.slice(0, 5) };
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
      dealTitle: deals.title,
    })
    .from(files)
    .leftJoin(people, eq(people.id, files.personId))
    .leftJoin(organizations, eq(organizations.id, files.organizationId))
    .leftJoin(deals, eq(deals.id, files.dealId))
    .where(and(...where))
    .orderBy(desc(files.createdAt))
    .limit(500);
}
