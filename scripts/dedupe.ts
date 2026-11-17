/**
 * Finds duplicate organizations, people and clients and merges them. See docs/DEDUPE.md.
 *
 *   pnpm run dedupe                          show what would be merged and deleted, write nothing
 *   pnpm run dedupe --yes                    merge and delete
 *   pnpm run dedupe --only=organizations     just organizations (or --only=people, --only=clients)
 *   pnpm run dedupe --as=you@company.com     record the merges as this teammate instead of the owner
 *   pnpm run dedupe --max-group=25           merge groups of people up to this size (10 by default; bigger ones are listed and skipped)
 *
 * Organizations: the same whole name, ignoring capitals. People: the same name
 * and a shared email address or phone number. In each group the oldest record with anything on it
 * is kept, its blanks are filled from the others, everything linked to the
 * others moves to it, and the others are deleted. Then each organization's
 * clients (or, without one, each person's) become one client. Safe to run again: a second
 * run finds nothing to do until new duplicates arrive (after another
 * Pipedrive import, say).
 *
 * Writes to DATABASE_URL, or to the local embedded database in .data/ when it
 * isn't set (stop `pnpm dev` first: only one process can open it). Every run
 * writes a CSV of what it found to .data/.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { contactKeys, groupByName, personMatchKeys, groupByShared, groupClients, pickClientSurvivor, pickSurvivor } from "@/lib/crm/merge";
import { fullName, mergeClientsInto, mergeOrganizationsInto, mergePeopleInto, stageProbabilities } from "@/lib/crm/merge-records";

type Database = PgDatabase<PgQueryResultHKT, typeof schema>;
type Transaction = (merge: (t: Database) => Promise<void>) => Promise<void>;

for (const f of [".env.local", ".env"]) if (existsSync(f)) process.loadEnvFile(f);
const args = new Set(process.argv.slice(2));
const flag = (name: string) => args.has(`--${name}`);
const option = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const log = (...m: unknown[]) => console.log(...m);

// ─── Database ────────────────────────────────────────────────────────────

/** Neon over a WebSocket pool (not HTTP), so each group merges in one transaction: a failure leaves nothing half-merged. */
async function connect(): Promise<{ db: Database; transaction: Transaction; close: () => Promise<void> }> {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (url) {
    const { Pool } = await import("@neondatabase/serverless");
    const { drizzle } = await import("drizzle-orm/neon-serverless");
    const { migrate } = await import("drizzle-orm/neon-serverless/migrator");
    const pool = new Pool({ connectionString: url });
    // A dropped WebSocket is reported as an "error" event on the connection. The pool
    // listens only while a connection sits idle, so one that drops mid-transaction would
    // otherwise crash the script; with a listener the failed query rejects instead and
    // `withRetry` tries the group again on a fresh connection.
    pool.on("error", () => {});
    pool.on("connect", (client: { on: (event: "error", listener: () => void) => unknown }) => client.on("error", () => {}));
    const db = drizzle({ client: pool, schema });
    await migrate(db, { migrationsFolder: "drizzle" });
    log(`Database: ${new URL(url).host}`);
    // Not drizzle's db.transaction: it sends BEGIN before its try, so a connection that drops
    // on BEGIN is never released, and enough of those would use up the pool. This always gives
    // the connection back, and closes it on any failure rather than reuse it.
    const transaction: Transaction = async (merge) => {
      const client = await pool.connect();
      let failure: Error | undefined;
      try {
        await client.query("begin");
        try {
          await merge(drizzle({ client, schema }) as unknown as Database);
          await client.query("commit");
        } catch (err) {
          await client.query("rollback").catch(() => {});
          throw err;
        }
      } catch (err) {
        failure = err instanceof Error ? err : new Error(describe(err));
        throw err;
      } finally {
        client.release(failure);
      }
    };
    return { db: db as unknown as Database, transaction, close: () => pool.end() };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  mkdirSync(".data", { recursive: true });
  const client = new PGlite(".data/pglite");
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: "drizzle" });
  log("Database: local (.data/pglite)");
  const transaction: Transaction = (merge) => db.transaction((tx) => merge(tx as unknown as Database));
  return { db: db as unknown as Database, transaction, close: () => client.close() };
}

/** A lost connection (no SQLSTATE, or class 08), a server restart, or a serialization failure or deadlock: worth trying again. */
function isTransient(err: unknown): boolean {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code.startsWith("08") || ["57P01", "57P02", "57P03", "40001", "40P01"].includes(code);
  }
  return true;
}

/**
 * Merges one group, trying again on a fresh connection when the connection drops.
 * `pending` says whether the group still needs merging: a drop just after COMMIT
 * can hide that it went through, and merging twice would log the merge twice.
 */
async function withRetry(label: string, pending: () => Promise<boolean>, merge: () => Promise<void>) {
  for (let attempt = 1; ; attempt++) {
    try {
      if (attempt > 1 && !(await pending())) return;
      return await merge();
    } catch (err) {
      if (attempt >= 5 || !isTransient(err)) throw new Error(`Couldn't merge ${label}: ${describe(err)}. The groups before it are merged; run again to continue.`, { cause: err });
      log(`  Merging ${label} failed (${describe(err)}), trying again (${attempt} of 4)`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
  }
}

function describe(err: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = err; e && parts.length < 4; e = (e as { cause?: unknown }).cause) {
    const m = e instanceof Error ? e.message.split("\n")[0] : (e as { message?: string }).message;
    if (m && !m.startsWith("Failed query")) parts.push(m);
  }
  return parts.join(": ") || "the database connection closed";
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

const report: string[][] = [["record", "group", "action", "id", "name", "email", "phone", "category", "created", "people_or_orgs", "clients", "activities", "other_links"]];
const csv = (cells: string[]) => cells.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",");
function addToReport(record: string, group: number, action: string, r: { id: string; createdAt: Date; name: string; email?: string | null; phone?: string | null; category?: string }, c: Counts | undefined) {
  report.push([record, String(group), action, r.id, r.name, r.email ?? "", r.phone ?? "", r.category ?? "", r.createdAt.toISOString().slice(0, 10), String(c?.people ?? 0), String(c?.clients ?? 0), String(c?.activities ?? 0), String(c?.other ?? 0)]);
}

// ─── Organizations ───────────────────────────────────────────────────────

/** Returns where each merged or deleted organization went, so clients can be grouped the same way in a preview. */
async function dedupeOrganizations(db: Database, transaction: Transaction, apply: boolean, actorId: string) {
  const movedTo = new Map<string, string>();
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
    for (const o of [...plan.merged, ...plan.empty]) movedTo.set(o.id, plan.survivor.id);
    if (i < 25 || flag("verbose")) log(`  “${plan.survivor.name}”: keep the one from ${plan.survivor.createdAt.toISOString().slice(0, 10)}${plan.merged.length ? `, merge ${plan.merged.length}` : ""}${plan.empty.length ? `, delete ${plan.empty.length} empty` : ""}`);
    else if (i === 25) log(`  …and ${groups.length - 25} more (--verbose lists them all; the CSV has every one)`);
    if (!apply) continue;

    const others = plan.donors;
    const ids = others.map((o) => o.id);
    const stillThere = async () => ids.length > 0 && (await db.select({ id: schema.organizations.id }).from(schema.organizations).where(inArray(schema.organizations.id, ids)).limit(1)).length > 0;
    await withRetry(`“${plan.survivor.name}”`, stillThere, () =>
      transaction(async (t) => {
        await mergeOrganizationsInto(t, { keep: plan.survivor, donors: others, merged: plan.merged, deleted: plan.empty, by: { userId: actorId } });
      }),
    );
  }
  log(`  ${merged} to merge, ${deleted} empty to delete${apply ? ": done" : ""}`);
  return movedTo;
}

// ─── People ──────────────────────────────────────────────────────────────

async function dedupePeople(db: Database, transaction: Transaction, apply: boolean, actorId: string) {
  const movedTo = new Map<string, string>();
  const all = await db.select().from(schema.people);
  const groups = groupByShared(all, personMatchKeys);
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
  // A safety net: even with matching names, a big group is more likely a shared line or inbox than one person. List it and leave it unless asked.
  const maxGroup = Number(option("max-group") ?? 10);
  if (!Number.isInteger(maxGroup) || maxGroup < 2) throw new Error("--max-group takes a whole number of 2 or more.");
  log(`\nPeople: ${groups.length} groups with the same name sharing an email or phone`);
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
    for (const p of [...plan.merged, ...plan.empty]) movedTo.set(p.id, plan.survivor.id);
    addToReport("person", i + 1, "keep", row(plan.survivor), counts.get(plan.survivor.id));
    for (const p of plan.merged) addToReport("person", i + 1, "merge", row(p), counts.get(p.id));
    for (const p of plan.empty) addToReport("person", i + 1, "delete (empty)", row(p), counts.get(p.id));
    if (i < 25 || flag("verbose")) log(`  ${fullName(plan.survivor)} (${plan.survivor.email ?? plan.survivor.phone}): keep the one from ${plan.survivor.createdAt.toISOString().slice(0, 10)}${plan.merged.length ? `, merge ${plan.merged.map(fullName).join(", ")}` : ""}${plan.empty.length ? `, delete ${plan.empty.length} empty` : ""}`);
    else if (i === 25) log(`  …and ${groups.length - 25} more (--verbose lists them all; the CSV has every one)`);
    if (!apply) continue;

    const others = plan.donors;
    const ids = others.map((p) => p.id);
    const keep = plan.survivor.id;
    const stillThere = async () => ids.length > 0 && (await db.select({ id: schema.people.id }).from(schema.people).where(inArray(schema.people.id, ids)).limit(1)).length > 0;
    await withRetry(fullName(plan.survivor), stillThere, () =>
      transaction(async (t) => {
        await mergePeopleInto(t, { keep: plan.survivor, donors: others, merged: plan.merged, deleted: plan.empty, alsoAt: { survivor: alsoAt.get(keep) ?? [], others: ids.flatMap((id) => alsoAt.get(id) ?? []) }, by: { userId: actorId } });
      }),
    );
  }
  log(`  ${merged} to merge, ${deleted} empty to delete${skipped ? `, ${skipped} large groups skipped` : ""}${apply ? ": done" : ""}`);
  return movedTo;
}

// ─── Clients ─────────────────────────────────────────────────────────────

async function clientCounts(db: Database, ids: string[]) {
  const out = new Map<string, Counts>();
  for (const batch of chunks(ids, 500)) {
    const rows = rowsOf<Record<string, unknown>>(
      await db.execute(sql`
        select c.id,
          (select count(*) from activities a where a.client_id = c.id) as activities,
          (select count(*) from client_services cs where cs.client_id = c.id)
            + (select count(*) from client_metrics cm where cm.client_id = c.id)
            + (select count(*) from files f where f.client_id = c.id and f.deleted_at is null)
            + (select count(*) from outbound_emails e where e.client_id = c.id)
            + (select count(*) from inbox_threads t where t.client_id = c.id) as other
        from clients c where c.id = any(${uuids(batch)})`),
    );
    for (const r of rows) out.set(String(r.id), { people: 0, clients: 0, activities: n(r.activities), other: n(r.other) });
  }
  return out;
}

/**
 * One client per organization (or, for clients with no organization, per
 * person), the way the Pipedrive import builds them. Runs after organizations
 * and people, so duplicates' clients already share the kept organization;
 * in a preview, `orgMoves` and `personMoves` say where they will.
 */
async function dedupeClients(db: Database, transaction: Transaction, apply: boolean, actorId: string, orgMoves: Map<string, string>, personMoves: Map<string, string>) {
  const all = await db.select().from(schema.clients);
  const groups = groupClients(
    all,
    (id) => orgMoves.get(id) ?? id,
    (id) => personMoves.get(id) ?? id,
  );
  const counts = await clientCounts(
    db,
    groups.flat().map((c) => c.id),
  );
  const probability = await stageProbabilities(db, groups.flat().map((c) => c.id));
  let merged = 0;
  log(`\nClients: ${groups.length} organizations (or people) with more than one client`);
  for (const [i, group] of groups.entries()) {
    const { survivor, donors } = pickClientSurvivor(group, (c) => probability.get(c.id) ?? 0);
    merged += donors.length;
    addToReport("client", i + 1, "keep", survivor, counts.get(survivor.id));
    for (const c of donors) addToReport("client", i + 1, "merge", c, counts.get(c.id));
    if (i < 25 || flag("verbose")) log(`  “${survivor.name}”: keep the ${survivor.archivedAt ? "archived " : ""}${survivor.category} client from ${survivor.createdAt.toISOString().slice(0, 10)}, merge ${donors.map((d) => `${d.category}${d.archivedAt ? " (archived)" : ""}`).join(", ")}`);
    else if (i === 25) log(`  …and ${groups.length - 25} more (--verbose lists them all; the CSV has every one)`);
    if (!apply) continue;

    const ids = donors.map((c) => c.id);
    const stillThere = async () => ids.length > 0 && (await db.select({ id: schema.clients.id }).from(schema.clients).where(inArray(schema.clients.id, ids)).limit(1)).length > 0;
    await withRetry(`the clients of “${survivor.name}”`, stillThere, () =>
      transaction(async (t) => {
        await mergeClientsInto(t, { keep: survivor, donors, by: { userId: actorId } });
      }),
    );
  }
  log(`  ${merged} to merge${apply ? ": done" : ""}`);
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  const only = option("only");
  if (only && only !== "organizations" && only !== "people" && only !== "clients") throw new Error("--only takes organizations, people or clients.");
  const apply = flag("yes");
  const { db, transaction, close } = await connect();
  try {
    const asEmail = option("as")?.toLowerCase();
    const team = await db.select().from(schema.users);
    const actor = asEmail ? team.find((u) => u.email.toLowerCase() === asEmail) : team.find((u) => u.role === "owner" && !u.deactivatedAt);
    if (!actor) throw new Error(asEmail ? `No teammate with the email ${asEmail}.` : "Create the owner account first (open the app and sign up), then run this again.");

    // Organizations, then people, then clients: each step finds the records the one before kept.
    const orgMoves = !only || only === "organizations" ? await dedupeOrganizations(db, transaction, apply, actor.id) : new Map<string, string>();
    const personMoves = !only || only === "people" ? await dedupePeople(db, transaction, apply, actor.id) : new Map<string, string>();
    if (!only || only === "clients") await dedupeClients(db, transaction, apply, actor.id, orgMoves, personMoves);

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
