/**
 * Finds duplicate organizations and people and merges them. See docs/DEDUPE.md.
 *
 *   pnpm dedupe                          show what would be merged and deleted, write nothing
 *   pnpm dedupe --yes                    merge and delete
 *   pnpm dedupe --only=organizations     just organizations (or --only=people)
 *   pnpm dedupe --as=you@company.com     record the merges as this teammate instead of the owner
 *   pnpm dedupe --max-group=25           merge groups of people up to this size (10 by default; bigger ones are listed and skipped)
 *
 * Organizations: the same whole name, ignoring capitals. People: a shared email
 * address or phone number. In each group the oldest record with anything on it
 * is kept, its blanks are filled from the others, everything linked to the
 * others moves to it, and the others are deleted. Safe to run again: a second
 * run finds nothing to do until new duplicates arrive (after another
 * Pipedrive import, say).
 *
 * Writes to DATABASE_URL, or to the local embedded database in .data/ when it
 * isn't set (stop `pnpm dev` first: only one process can open it). Every run
 * writes a CSV of what it found to .data/.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import type { CampaignAudience } from "@/db/schema";
import { contactKeys, groupByName, groupByShared, pickSurvivor, planOrganizationMerge, planPersonMerge } from "@/lib/crm/merge";

type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

for (const f of [".env.local", ".env"]) if (existsSync(f)) process.loadEnvFile(f);
const args = new Set(process.argv.slice(2));
const flag = (name: string) => args.has(`--${name}`);
const option = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const log = (...m: unknown[]) => console.log(...m);

// ─── Database ────────────────────────────────────────────────────────────

/** Neon over a WebSocket pool (not HTTP), so each group merges in one transaction: a failure leaves nothing half-merged. */
async function connect(): Promise<{ db: Database; close: () => Promise<void> }> {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (url) {
    const { Pool } = await import("@neondatabase/serverless");
    const { drizzle } = await import("drizzle-orm/neon-serverless");
    const { migrate } = await import("drizzle-orm/neon-serverless/migrator");
    const pool = new Pool({ connectionString: url });
    const db = drizzle({ client: pool, schema });
    await migrate(db, { migrationsFolder: "drizzle" });
    log(`Database: ${new URL(url).host}`);
    return { db: db as unknown as Database, close: () => pool.end() };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  mkdirSync(".data", { recursive: true });
  const client = new PGlite(".data/pglite");
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: "drizzle" });
  log("Database: local (.data/pglite)");
  return { db: db as unknown as Database, close: () => client.close() };
}

const rowsOf = <T>(result: unknown) => ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];
/** A Postgres uuid[] of ids (uuids only, so the literal is safe). */
const uuids = (ids: string[]) => sql`${`{${ids.join(",")}}`}::uuid[]`;
const chunks = <T>(list: T[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));
const n = (v: unknown) => Number(v ?? 0);

// ─── What's on each record ───────────────────────────────────────────────

type Counts = { people: number; clients: number; activities: number; other: number };
const total = (c: Counts | undefined) => (c ? c.people + c.clients + c.activities + c.other : 0);

async function organizationCounts(db: Database, ids: string[]) {
  const out = new Map<string, Counts>();
  for (const batch of chunks(ids, 500)) {
    const rows = rowsOf<Record<string, unknown>>(
      await db.execute(sql`
        select o.id,
          (select count(*) from people p where p.organization_id = o.id) + (select count(*) from person_organizations po where po.organization_id = o.id) as people,
          (select count(*) from clients c where c.organization_id = o.id) as clients,
          (select count(*) from activities a where a.organization_id = o.id) as activities,
          (select count(*) from files f where f.organization_id = o.id and f.deleted_at is null)
            + (select count(*) from inbox_threads t where t.organization_id = o.id)
            + (select count(*) from synced_emails s where s.organization_id = o.id)
            + (select count(*) from phone_calls pc where pc.organization_id = o.id)
            + (select count(*) from text_messages tm where tm.organization_id = o.id) as other
        from organizations o where o.id = any(${uuids(batch)})`),
    );
    for (const r of rows) out.set(String(r.id), { people: n(r.people), clients: n(r.clients), activities: n(r.activities), other: n(r.other) });
  }
  return out;
}

/** For people, "people" counts the organizations they're at. */
async function personCounts(db: Database, ids: string[]) {
  const out = new Map<string, Counts>();
  for (const batch of chunks(ids, 500)) {
    const rows = rowsOf<Record<string, unknown>>(
      await db.execute(sql`
        select p.id,
          (case when p.organization_id is null then 0 else 1 end) + (select count(*) from person_organizations po where po.person_id = p.id) as people,
          (select count(*) from clients c where c.person_id = p.id) as clients,
          (select count(*) from activities a where a.person_id = p.id) as activities,
          (select count(*) from files f where f.person_id = p.id and f.deleted_at is null)
            + (select count(*) from outbound_emails e where e.person_id = p.id)
            + (select count(*) from inbox_threads t where t.person_id = p.id)
            + (select count(*) from synced_emails s where s.person_id = p.id)
            + (select count(*) from phone_calls pc where pc.person_id = p.id)
            + (select count(*) from text_messages tm where tm.person_id = p.id) as other
        from people p where p.id = any(${uuids(batch)})`),
    );
    for (const r of rows) out.set(String(r.id), { people: n(r.people), clients: n(r.clients), activities: n(r.activities), other: n(r.other) });
  }
  return out;
}

// ─── Report ──────────────────────────────────────────────────────────────

const report: string[][] = [["record", "group", "action", "id", "name", "email", "phone", "created", "people_or_orgs", "clients", "activities", "other_links"]];
const csv = (cells: string[]) => cells.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",");
function addToReport(record: string, group: number, action: string, r: { id: string; createdAt: Date; name: string; email?: string | null; phone?: string | null }, c: Counts | undefined) {
  report.push([record, String(group), action, r.id, r.name, r.email ?? "", r.phone ?? "", r.createdAt.toISOString().slice(0, 10), String(c?.people ?? 0), String(c?.clients ?? 0), String(c?.activities ?? 0), String(c?.other ?? 0)]);
}

// ─── Shared steps ────────────────────────────────────────────────────────

/** Saved audiences and campaign filters that name merged records point at the one that's kept. */
async function repointAudiences(db: Database, field: "organizationIds" | "personIds", from: string[], to: string) {
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

/** Spreadsheet imports forget merged records, so undoing one can't delete what they were merged into. */
async function forgetInImports(db: Database, field: "createdIds" | "createdOrgIds", ids: string[]) {
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
async function moveHistory(db: Database, entity: "organization" | "person", from: string[], to: string) {
  await db.delete(schema.events).where(and(eq(schema.events.entityType, entity), inArray(schema.events.entityId, from), eq(schema.events.action, "created")));
  await db
    .update(schema.events)
    .set({ entityId: to })
    .where(and(eq(schema.events.entityType, entity), inArray(schema.events.entityId, from)));
  await db.update(schema.externalIds).set({ localId: to }).where(inArray(schema.externalIds.localId, from));
}

const summaryReset = { summary: null, summaryAt: null, summaryStartedAt: null };
const briefly = (r: { id: string; name: string; createdAt: Date }) => ({ id: r.id, name: r.name, createdAt: r.createdAt.toISOString() });

// ─── Organizations ───────────────────────────────────────────────────────

async function dedupeOrganizations(db: Database, apply: boolean, actorId: string) {
  const all = await db.select().from(schema.organizations);
  const groups = groupByName(all);
  const counts = await organizationCounts(
    db,
    groups.flat().map((o) => o.id),
  );
  const hasData = (o: { id: string }) => total(counts.get(o.id)) > 0;
  let merged = 0;
  let deleted = 0;
  log(`\nOrganizations: ${groups.length} names shared by more than one organization`);
  for (const [i, group] of groups.entries()) {
    const plan = pickSurvivor(group, hasData);
    merged += plan.merged.length;
    deleted += plan.empty.length;
    addToReport("organization", i + 1, "keep", plan.survivor, counts.get(plan.survivor.id));
    for (const o of plan.merged) addToReport("organization", i + 1, "merge", o, counts.get(o.id));
    for (const o of plan.empty) addToReport("organization", i + 1, "delete (empty)", o, counts.get(o.id));
    if (i < 25 || flag("verbose")) log(`  “${plan.survivor.name}”: keep the one from ${plan.survivor.createdAt.toISOString().slice(0, 10)}${plan.merged.length ? `, merge ${plan.merged.length}` : ""}${plan.empty.length ? `, delete ${plan.empty.length} empty` : ""}`);
    else if (i === 25) log(`  …and ${groups.length - 25} more (--verbose lists them all; the CSV has every one)`);
    if (!apply) continue;

    const others = [...plan.merged, ...plan.empty];
    const ids = others.map((o) => o.id);
    const keep = plan.survivor.id;
    const patch = planOrganizationMerge(plan.survivor, others);
    await db.transaction(async (tx) => {
      const t = tx as unknown as Database;
      await t.update(schema.people).set({ organizationId: keep }).where(inArray(schema.people.organizationId, ids));
      // Other organizations people are at: move to the kept one, unless it's already their main one.
      await t.execute(sql`insert into person_organizations (person_id, organization_id, created_at)
        select po.person_id, ${keep}, min(po.created_at) from person_organizations po join people p on p.id = po.person_id
        where po.organization_id = any(${uuids(ids)}) and p.organization_id is distinct from ${keep} group by po.person_id
        on conflict do nothing`);
      await t.delete(schema.personOrganizations).where(inArray(schema.personOrganizations.organizationId, ids));
      // Someone whose main organization just became the kept one isn't "also at" it too.
      await t.execute(sql`delete from person_organizations po using people p where po.person_id = p.id and po.organization_id = ${keep} and p.organization_id = ${keep}`);
      for (const table of [schema.clients, schema.activities, schema.files, schema.inboxThreads, schema.syncedEmails, schema.phoneCalls, schema.textMessages]) {
        await t.update(table).set({ organizationId: keep }).where(inArray(table.organizationId, ids));
      }
      await moveHistory(t, "organization", ids, keep);
      await repointAudiences(t, "organizationIds", ids, keep);
      await forgetInImports(t, "createdOrgIds", ids);
      await t
        .update(schema.organizations)
        .set({ ...patch, ...summaryReset, updatedAt: new Date() })
        .where(eq(schema.organizations.id, keep));
      await t.delete(schema.organizations).where(inArray(schema.organizations.id, ids));
      await t.insert(schema.events).values({
        entityType: "organization",
        entityId: keep,
        action: "merged",
        data: { merged: plan.merged.map(briefly), deleted: plan.empty.map(briefly), filled: Object.keys(patch) },
        userId: actorId,
      });
    });
  }
  log(`  ${merged} to merge, ${deleted} empty to delete${apply ? ": done" : ""}`);
}

// ─── People ──────────────────────────────────────────────────────────────

const fullName = (p: { firstName: string; lastName: string | null }) => [p.firstName, p.lastName].filter(Boolean).join(" ");

async function dedupePeople(db: Database, apply: boolean, actorId: string) {
  const all = await db.select().from(schema.people);
  const groups = groupByShared(all, contactKeys);
  const counts = await personCounts(
    db,
    groups.flat().map((p) => p.id),
  );
  const hasData = (p: { id: string }) => total(counts.get(p.id)) > 0;
  const alsoAt = new Map<string, string[]>();
  for (const r of await db.select().from(schema.personOrganizations)) alsoAt.set(r.personId, [...(alsoAt.get(r.personId) ?? []), r.organizationId]);
  let merged = 0;
  let deleted = 0;
  let skipped = 0;
  // A big group usually means a shared line or inbox (a switchboard, info@), not one person: list it and leave it unless asked.
  const maxGroup = Number(option("max-group") ?? 10);
  if (!Number.isInteger(maxGroup) || maxGroup < 2) throw new Error("--max-group takes a whole number of 2 or more.");
  log(`\nPeople: ${groups.length} groups sharing an email or phone`);
  for (const [i, group] of groups.entries()) {
    if (group.length > maxGroup) {
      skipped++;
      const seen = new Map<string, number>();
      for (const p of group) for (const k of new Set(contactKeys(p))) seen.set(k, (seen.get(k) ?? 0) + 1);
      const shared = [...seen].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]);
      log(`  Skipped: ${group.length} people share ${shared.slice(0, 3).map(([k]) => k.slice(2)).join(", ")}. Check them in the CSV; --max-group=${group.length} merges them.`);
      for (const p of group) addToReport("person", i + 1, "skipped (large group)", { ...p, name: fullName(p) }, counts.get(p.id));
      continue;
    }
    const plan = pickSurvivor(group, hasData);
    merged += plan.merged.length;
    deleted += plan.empty.length;
    const row = (p: (typeof group)[number]) => ({ ...p, name: fullName(p) });
    addToReport("person", i + 1, "keep", row(plan.survivor), counts.get(plan.survivor.id));
    for (const p of plan.merged) addToReport("person", i + 1, "merge", row(p), counts.get(p.id));
    for (const p of plan.empty) addToReport("person", i + 1, "delete (empty)", row(p), counts.get(p.id));
    if (i < 25 || flag("verbose")) log(`  ${fullName(plan.survivor)} (${plan.survivor.email ?? plan.survivor.phone}): keep the one from ${plan.survivor.createdAt.toISOString().slice(0, 10)}${plan.merged.length ? `, merge ${plan.merged.map(fullName).join(", ")}` : ""}${plan.empty.length ? `, delete ${plan.empty.length} empty` : ""}`);
    else if (i === 25) log(`  …and ${groups.length - 25} more (--verbose lists them all; the CSV has every one)`);
    if (!apply) continue;

    const others = [...plan.merged, ...plan.empty];
    const ids = others.map((p) => p.id);
    const keep = plan.survivor.id;
    const { patch, alsoAt: orgs } = planPersonMerge(plan.survivor, others, { survivor: alsoAt.get(keep) ?? [], others: ids.flatMap((id) => alsoAt.get(id) ?? []) });
    await db.transaction(async (tx) => {
      const t = tx as unknown as Database;
      for (const table of [schema.clients, schema.activities, schema.files, schema.inboxThreads, schema.syncedEmails, schema.phoneCalls]) {
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
      await forgetInImports(t, "createdIds", ids);
      await t
        .update(schema.people)
        .set({ ...patch, ...summaryReset, updatedAt: new Date() })
        .where(eq(schema.people.id, keep));
      await t.delete(schema.people).where(inArray(schema.people.id, ids));
      const main = patch.organizationId !== undefined ? patch.organizationId : plan.survivor.organizationId;
      if (orgs.length) await t.insert(schema.personOrganizations).values(orgs.map((organizationId) => ({ personId: keep, organizationId }))).onConflictDoNothing();
      if (main) await t.delete(schema.personOrganizations).where(and(eq(schema.personOrganizations.personId, keep), eq(schema.personOrganizations.organizationId, main)));
      await t.insert(schema.events).values({
        entityType: "person",
        entityId: keep,
        action: "merged",
        data: { merged: plan.merged.map((p) => briefly(row(p))), deleted: plan.empty.map((p) => briefly(row(p))), filled: Object.keys(patch) },
        userId: actorId,
      });
    });
  }
  log(`  ${merged} to merge, ${deleted} empty to delete${skipped ? `, ${skipped} large groups skipped` : ""}${apply ? ": done" : ""}`);
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  const only = option("only");
  if (only && only !== "organizations" && only !== "people") throw new Error("--only takes organizations or people.");
  const apply = flag("yes");
  const { db, close } = await connect();
  try {
    const asEmail = option("as")?.toLowerCase();
    const team = await db.select().from(schema.users);
    const actor = asEmail ? team.find((u) => u.email.toLowerCase() === asEmail) : team.find((u) => u.role === "owner" && !u.deactivatedAt);
    if (!actor) throw new Error(asEmail ? `No teammate with the email ${asEmail}.` : "Create the owner account first (open the app and sign up), then run this again.");

    // Organizations first, so people merged next already point at the organizations that are kept.
    if (only !== "people") await dedupeOrganizations(db, apply, actor.id);
    if (only !== "organizations") await dedupePeople(db, apply, actor.id);

    mkdirSync(".data", { recursive: true });
    const file = `.data/dedupe-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}${apply ? "" : "-preview"}.csv`;
    writeFileSync(file, report.map(csv).join("\n") + "\n");
    log(`\nEvery group is listed in ${file}.`);
    log(apply ? "Done. Run it again any time, after another Pipedrive import for instance." : "Nothing was changed. Check the list, then run again with --yes to merge.");
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
