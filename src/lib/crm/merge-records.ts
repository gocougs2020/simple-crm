/**
 * The database side of merging records: moving everything from the merged
 * records onto the one that's kept, filling its blanks, deleting the others
 * and writing "merged" history. Shared by the cleanup script
 * (scripts/dedupe.ts) and the manual merge on the People and Organizations
 * pages (src/lib/crm/service/merge.ts). Each function expects to run inside
 * a transaction, so a failure leaves nothing half-merged. The rules for what
 * is kept are in ./merge.ts; see docs/DEDUPE.md.
 *
 * No "server-only": the script imports it too.
 */
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import type { CampaignAudience } from "@/db/schema";
import { planClientMerge, planOrganizationMerge, planPersonMerge, type ClientFields, type OrgFields, type PersonFields } from "./merge";

export type MergeDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
/** Who the "merged" history entry is credited to. */
export type MergeAuthor = { userId: string | null; apiKeyId?: string | null };

/** A Postgres uuid[] of ids (uuids only, so the literal is safe). */
const uuids = (ids: string[]) => sql`${`{${ids.join(",")}}`}::uuid[]`;

const summaryReset = { summary: null, summaryAt: null, summaryStartedAt: null };
const briefly = (r: { id: string; name: string; createdAt: Date }) => ({ id: r.id, name: r.name, createdAt: r.createdAt.toISOString() });
export const fullName = (p: { firstName: string; lastName: string | null }) => [p.firstName, p.lastName].filter(Boolean).join(" ");

// ─── Shared steps ────────────────────────────────────────────────────────

/** Saved audiences and campaign filters that name merged records point at the one that's kept. */
async function repointAudiences(db: MergeDatabase, field: "organizationIds" | "personIds", from: string[], to: string) {
  const swap = (a: CampaignAudience) => {
    const list = a[field];
    if (!list?.some((id) => from.includes(id))) return null;
    return { ...a, [field]: [...new Set(list.map((id) => (from.includes(id) ? to : id)))] };
  };
  const like = sql.raw(`'${field}'`);
  for (const r of await db.select({ id: schema.audiences.id, filters: schema.audiences.filters }).from(schema.audiences).where(sql`${schema.audiences.filters} ? ${like}`)) {
    const next = swap(r.filters);
    if (next) await db.update(schema.audiences).set({ filters: next }).where(eq(schema.audiences.id, r.id));
  }
  for (const r of await db.select({ id: schema.campaigns.id, audience: schema.campaigns.audience }).from(schema.campaigns).where(sql`${schema.campaigns.audience} ? ${like}`)) {
    const next = swap(r.audience);
    if (next) await db.update(schema.campaigns).set({ audience: next }).where(eq(schema.campaigns.id, r.id));
  }
}

/**
 * Spreadsheet imports forget every record in a merge, the kept one too: it now
 * holds what was moved from the others, so undoing the import mustn't delete
 * it (or put back its pre-import values over the merged ones).
 */
async function forgetInImports(db: MergeDatabase, field: "createdIds" | "createdOrgIds", ids: string[]) {
  const column = field === "createdIds" ? schema.peopleImports.createdIds : schema.peopleImports.createdOrgIds;
  const rows = await db
    .select({ id: schema.peopleImports.id, created: column, updates: schema.peopleImports.updates })
    .from(schema.peopleImports)
    .where(sql`${column} ?| ${`{${ids.join(",")}}`}::text[] or (${field === "createdIds"} and exists (select 1 from jsonb_array_elements(${schema.peopleImports.updates}) u where u->>'id' = any(${uuids(ids)}::text[])))`);
  for (const r of rows) {
    await db
      .update(schema.peopleImports)
      .set({ [field]: r.created.filter((id) => !ids.includes(id)), ...(field === "createdIds" ? { updates: r.updates.filter((u) => !ids.includes(u.id)) } : {}) })
      .where(eq(schema.peopleImports.id, r.id));
  }
}

/** History of the merged records moves to the one that's kept (all but their "created" entries); external ids follow so the Pipedrive import updates the kept record instead of bringing the others back. */
async function moveHistory(db: MergeDatabase, entity: "organization" | "person" | "client", from: string[], to: string) {
  await db.delete(schema.events).where(and(eq(schema.events.entityType, entity), inArray(schema.events.entityId, from), eq(schema.events.action, "created")));
  await db
    .update(schema.events)
    .set({ entityId: to })
    .where(and(eq(schema.events.entityType, entity), inArray(schema.events.entityId, from)));
  await db.update(schema.externalIds).set({ localId: to }).where(inArray(schema.externalIds.localId, from));
}

// ─── Organizations ───────────────────────────────────────────────────────

type Org = OrgFields;

/**
 * Merges `donors` into `keep`. `donors` is the order they fill its blanks in
 * (first wins). `merged` and `deleted` only say how the history entry
 * describes them: duplicates with something on them, and empty ones.
 * Returns the fields that were filled.
 */
export async function mergeOrganizationsInto(t: MergeDatabase, o: { keep: Org; donors: Org[]; merged?: Org[]; deleted?: Org[]; by: MergeAuthor }) {
  const keep = o.keep.id;
  const ids = o.donors.map((d) => d.id);
  const patch = planOrganizationMerge(o.keep, o.donors);
  await t.update(schema.people).set({ organizationId: keep }).where(inArray(schema.people.organizationId, ids));
  // Other organizations people are at: move to the kept one, unless it's already their main one.
  await t.execute(sql`insert into person_organizations (person_id, organization_id, created_at)
    select po.person_id, ${keep}, min(po.created_at) from person_organizations po join people p on p.id = po.person_id
    where po.organization_id = any(${uuids(ids)}) and p.organization_id is distinct from ${keep} group by po.person_id
    on conflict do nothing`);
  await t.delete(schema.personOrganizations).where(inArray(schema.personOrganizations.organizationId, ids));
  // Someone whose main organization just became the kept one isn't "also at" it too.
  await t.execute(sql`delete from person_organizations po using people p where po.person_id = p.id and po.organization_id = ${keep} and p.organization_id = ${keep}`);
  for (const table of [schema.clients, schema.activities, schema.files, schema.inboxThreads, schema.syncedEmails, schema.phoneCalls, schema.textMessages, schema.textThreads]) {
    await t.update(table).set({ organizationId: keep }).where(inArray(table.organizationId, ids));
  }
  // Organizations that were part of a merged parent are part of the kept one (which the plan marks as a parent).
  await t
    .update(schema.organizations)
    .set({ parentId: keep })
    .where(and(inArray(schema.organizations.parentId, ids), ne(schema.organizations.id, keep)));
  await moveHistory(t, "organization", ids, keep);
  await repointAudiences(t, "organizationIds", ids, keep);
  await forgetInImports(t, "createdOrgIds", [...ids, keep]);
  await t
    .update(schema.organizations)
    .set({ ...patch, ...summaryReset, updatedAt: new Date() })
    .where(eq(schema.organizations.id, keep));
  await t.delete(schema.organizations).where(inArray(schema.organizations.id, ids));
  await t.insert(schema.events).values({
    entityType: "organization",
    entityId: keep,
    action: "merged",
    data: { merged: (o.merged ?? o.donors).map(briefly), deleted: (o.deleted ?? []).map(briefly), filled: Object.keys(patch) },
    userId: o.by.userId,
    apiKeyId: o.by.apiKeyId ?? null,
  });
  return patch;
}

// ─── People ──────────────────────────────────────────────────────────────

type Person = PersonFields;

/** Merges `donors` into `keep`, like organizations. `alsoAt` is every other organization the kept person and the donors are at (person_organizations). */
export async function mergePeopleInto(t: MergeDatabase, o: { keep: Person; donors: Person[]; merged?: Person[]; deleted?: Person[]; alsoAt: { survivor: string[]; others: string[] }; by: MergeAuthor }) {
  const keep = o.keep.id;
  const ids = o.donors.map((p) => p.id);
  const { patch, alsoAt: orgs } = planPersonMerge(o.keep, o.donors, o.alsoAt);
  for (const table of [schema.clients, schema.activities, schema.files, schema.inboxThreads, schema.syncedEmails, schema.phoneCalls, schema.textThreads]) {
    await t.update(table).set({ personId: keep }).where(inArray(table.personId, ids));
  }
  // A campaign sends each person one email or text. When two of them got the same campaign, the kept record keeps its own; the other's copy stays without a person.
  for (const id of ids) {
    for (const table of [schema.outboundEmails, schema.textMessages]) {
      const name = table === schema.outboundEmails ? "outbound_emails" : "text_messages";
      // Qualified by hand: inside the subquery an unqualified campaign_id would mean x's.
      await t
        .update(table)
        .set({ personId: keep })
        .where(and(eq(table.personId, id), sql.raw(`("${name}"."campaign_id" is null or not exists (select 1 from ${name} x where x.campaign_id = "${name}"."campaign_id" and x.person_id = '${keep}'))`)));
    }
  }
  await moveHistory(t, "person", ids, keep);
  await repointAudiences(t, "personIds", ids, keep);
  await forgetInImports(t, "createdIds", [...ids, keep]);
  await t
    .update(schema.people)
    .set({ ...patch, ...summaryReset, updatedAt: new Date() })
    .where(eq(schema.people.id, keep));
  await t.delete(schema.people).where(inArray(schema.people.id, ids));
  const main = patch.organizationId !== undefined ? patch.organizationId : o.keep.organizationId;
  if (orgs.length) await t.insert(schema.personOrganizations).values(orgs.map((organizationId) => ({ personId: keep, organizationId }))).onConflictDoNothing();
  if (main) await t.delete(schema.personOrganizations).where(and(eq(schema.personOrganizations.personId, keep), eq(schema.personOrganizations.organizationId, main)));
  const row = (p: Person) => briefly({ ...p, name: fullName(p) });
  await t.insert(schema.events).values({
    entityType: "person",
    entityId: keep,
    action: "merged",
    data: { merged: (o.merged ?? o.donors).map(row), deleted: (o.deleted ?? []).map(row), filled: Object.keys(patch) },
    userId: o.by.userId,
    apiKeyId: o.by.apiKeyId ?? null,
  });
  return patch;
}

// ─── Clients ─────────────────────────────────────────────────────────────

/** Merges `donors` (newest first) into `keep`: services, metrics and everything on the timeline move to it. */
export async function mergeClientsInto(t: MergeDatabase, o: { keep: ClientFields; donors: ClientFields[]; by: MergeAuthor }) {
  const keep = o.keep.id;
  const ids = o.donors.map((c) => c.id);
  const patch = planClientMerge(o.keep, o.donors);
  for (const table of [schema.clientServices, schema.clientMetrics, schema.activities, schema.files, schema.outboundEmails, schema.inboxThreads, schema.syncedEmails, schema.phoneCalls, schema.textMessages, schema.textThreads]) {
    await t.update(table).set({ clientId: keep }).where(inArray(table.clientId, ids));
  }
  await moveHistory(t, "client", ids, keep);
  await t
    .update(schema.clients)
    .set({ ...patch, ...summaryReset, updatedAt: new Date() })
    .where(eq(schema.clients.id, keep));
  await t.delete(schema.clients).where(inArray(schema.clients.id, ids));
  await t.insert(schema.events).values({
    entityType: "client",
    entityId: keep,
    action: "merged",
    data: { merged: o.donors.map((c) => ({ ...briefly(c), category: c.category })), deleted: [], filled: Object.keys(patch) },
    userId: o.by.userId,
    apiKeyId: o.by.apiKeyId ?? null,
  });
  return patch;
}

/** Each client's stage win probability, so "furthest along" can tell a prospect in negotiation from a new lead. */
export async function stageProbabilities(t: MergeDatabase, clientIds: string[]) {
  if (!clientIds.length) return new Map<string, number>();
  const rows = await t
    .select({ id: schema.clients.id, probability: schema.stages.probability })
    .from(schema.clients)
    .innerJoin(schema.stages, eq(schema.stages.id, schema.clients.stageId))
    .where(inArray(schema.clients.id, clientIds));
  return new Map(rows.map((r) => [r.id, r.probability]));
}
