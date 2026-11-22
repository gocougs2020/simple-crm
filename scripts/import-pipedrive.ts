/**
 * Imports a Pipedrive account: users, organizations, people, deals (collapsed
 * into one client per organization), product deals as services, notes,
 * activities and email. See docs/PIPEDRIVE-IMPORT.md.
 *
 *   pnpm import:pipedrive --dry-run     show what would happen, write nothing
 *   pnpm import:pipedrive               import (safe to run again: it updates)
 *   pnpm import:pipedrive --no-email    skip email (much faster)
 *   pnpm import:pipedrive --email=all   email for everyone, not only people tied to clients
 *   pnpm import:pipedrive --since=14 --new-only
 *                                       only add what was created in Pipedrive in the last 14 days,
 *                                       onto the records here, and change nothing that's already here
 *   pnpm import:pipedrive --reset       remove everything a previous import added
 *
 * Needs PIPEDRIVE_API_TOKEN. Writes to DATABASE_URL, or to the local embedded
 * database in .data/ when it isn't set (stop `pnpm dev` first: only one
 * process can open it).
 */
import { existsSync, mkdirSync } from "node:fs";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import type { CustomValues } from "@/db/schema";
import type { ActivityType, ClientCategory, CustomFieldType, EntityType } from "@/lib/constants";
import { emailKey, keepContactsOnImport, planOrganizationMerge, planPersonMerge, type OrgFields, type PersonFields } from "@/lib/crm/merge";
import { followMerges, inWindow, mergedInto, OrganizationMatcher, parseSince, PersonMatcher } from "@/lib/crm/pipedrive-sync";
import { rankBetween } from "@/lib/rank";
import { sanitizeHtml, textToHtml } from "@/lib/safe-html";
import { mapLimit, PipedriveApi, type PdActivity, type PdDeal, type PdField, type PdId, type PdMailMessage, type PdUser } from "./pipedrive/api";
import { dealCategory, openToReturn, pipelineRole, planClients, planStages, productEnded, stageName, type ClientPlan, type Lookup } from "./pipedrive/plan";

type Database = PgDatabase<PgQueryResultHKT, typeof schema>;
const SOURCE = "pipedrive" as const;

for (const f of [".env.local", ".env"]) if (existsSync(f)) process.loadEnvFile(f);
const args = new Set(process.argv.slice(2));
const flag = (name: string) => args.has(`--${name}`);
const option = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const log = (...m: unknown[]) => console.log(...m);

// ─── Database ────────────────────────────────────────────────────────────

async function connect(): Promise<{ db: Database; close: () => Promise<void> }> {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (url) {
    const { neon } = await import("@neondatabase/serverless");
    const { drizzle } = await import("drizzle-orm/neon-http");
    const { migrate } = await import("drizzle-orm/neon-http/migrator");
    const db = drizzle({ client: neon(url), schema });
    await migrate(db, { migrationsFolder: "drizzle" });
    log(`Database: ${new URL(url).host}`);
    return { db: db as unknown as Database, close: async () => {} };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  // The extensions the app's local database uses (src/db/index.ts): the migrations need them.
  const { vector } = await import("@electric-sql/pglite-pgvector");
  const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  mkdirSync(".data", { recursive: true });
  const client = new PGlite(".data/pglite", { extensions: { vector, pg_trgm } });
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: "drizzle" });
  log("Database: local (.data/pglite)");
  return { db: db as unknown as Database, close: () => client.close() };
}

/** Which local record stands for which Pipedrive record (`external_ids`). */
class Links {
  private map = new Map<string, string>();
  private pending: (typeof schema.externalIds.$inferInsert)[] = [];
  constructor(private db: Database) {}
  async load() {
    for (const r of await this.db.select().from(schema.externalIds).where(eq(schema.externalIds.source, SOURCE))) this.map.set(`${r.kind}:${r.externalId}`, r.localId);
  }
  get = (kind: string, id: PdId | string | null | undefined) => (id === null || id === undefined ? null : (this.map.get(`${kind}:${id}`) ?? null));
  add(kind: string, id: PdId | string, localId: string) {
    this.map.set(`${kind}:${id}`, localId);
    this.pending.push({ source: SOURCE, kind, externalId: String(id), localId });
  }
  /** Records a mapping and writes it right away: used right after creating a record, so a later failure can't leave it unmapped (and duplicated by the next run). */
  async save(kind: string, id: PdId | string, localId: string) {
    this.add(kind, id, localId);
    await this.flush();
  }
  /** Local records that stand for more than one Pipedrive record of this kind: duplicates merged by `pnpm run dedupe`. */
  shared(kind: string) {
    const seen = new Set<string>();
    const out = new Set<string>();
    for (const [key, localId] of this.map) {
      if (!key.startsWith(`${kind}:`)) continue;
      if (seen.has(localId)) out.add(localId);
      seen.add(localId);
    }
    return out;
  }
  /** For external ids of this kind that share a local record (merged by `pnpm run dedupe`): each one → the first of its group. */
  aliases(kind: string) {
    const byLocal = new Map<string, string[]>();
    for (const [key, localId] of this.map) {
      if (!key.startsWith(`${kind}:`)) continue;
      byLocal.set(localId, [...(byLocal.get(localId) ?? []), key.slice(kind.length + 1)]);
    }
    const out = new Map<string, string>();
    for (const keys of byLocal.values()) {
      if (keys.length < 2) continue;
      const [first] = [...keys].sort();
      for (const k of keys) out.set(k, first);
    }
    return out;
  }
  /**
   * Points this kind's mappings at the records they stand for now (`resolve`): a record that was merged
   * into another maps to that one. Mappings to records that are gone are dropped when `dropGone` is set,
   * so the Pipedrive record counts as not imported yet. Returns how many were moved and dropped.
   */
  repair(kind: string, resolve: (localId: string) => string | null, dropGone: boolean) {
    let moved = 0;
    let dropped = 0;
    for (const [key, localId] of [...this.map]) {
      if (!key.startsWith(`${kind}:`)) continue;
      const now = resolve(localId);
      if (now && now !== localId) {
        this.add(kind, key.slice(kind.length + 1), now);
        moved++;
      } else if (!now && dropGone) {
        this.map.delete(key);
        dropped++;
      }
    }
    return { moved, dropped };
  }
  /** Forgets a mapping. */
  async remove(kind: string, id: PdId | string) {
    this.map.delete(`${kind}:${id}`);
    await this.db.delete(schema.externalIds).where(and(eq(schema.externalIds.source, SOURCE), eq(schema.externalIds.kind, kind), eq(schema.externalIds.externalId, String(id))));
  }
  async flush() {
    for (const rows of chunks(this.pending.splice(0), 500)) await this.db.insert(schema.externalIds).values(rows).onConflictDoUpdate({ target: [schema.externalIds.source, schema.externalIds.kind, schema.externalIds.externalId], set: { localId: sql`excluded.local_id` } });
  }
}

const chunks = <T>(list: T[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

// ─── Value helpers ───────────────────────────────────────────────────────

/** Pipedrive v1 times are "2021-11-09 14:29:36" in UTC; v2 times are ISO. */
const time = (s: string | null | undefined) => {
  if (!s) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2} \d/.test(s) ? `${s.replace(" ", "T")}Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
};
const day = (s: string | null | undefined) => (s ? (time(s)?.toISOString().slice(0, 10) ?? (/^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null)) : null);
const cents = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) : 0);
/** Trimmed text, cut to `n` characters. Pipedrive sometimes sends ids or objects where text is expected; those count as blank. */
const clip = (s: unknown, n: number) => (typeof s === "string" || typeof s === "number" ? String(s).trim().slice(0, n) || null : null);

/**
 * Pipedrive HTML (notes, email) made safe. Pipedrive rewrites links in sent
 * email to go through its click tracker; the original address is kept in
 * data-pipedrive-original-href, so put that back before sanitizing.
 */
function cleanHtml(html: string | null | undefined) {
  if (!html?.trim()) return null;
  const untracked = html.replace(/<a\b[^>]*>/gi, (tag) => {
    const original = /data-pipedrive-original-href="([^"]*)"/i.exec(tag)?.[1];
    return original ? tag.replace(/\shref="[^"]*"/i, ` href="${original}"`) : tag;
  });
  const out = sanitizeHtml(untracked)
    .replace(/<p>(\s|&nbsp;|<br>)*<\/p>/g, "")
    .trim();
  return out ? out.slice(0, 200_000) : null;
}

const activityTypeMap: Record<string, ActivityType> = { call: "call", meeting: "meeting", lunch: "meeting", email: "email", sms: "text", text: "text", task: "task", deadline: "task" };

const fieldTypeMap: Record<string, CustomFieldType> = { text: "longtext", double: "number", int: "number", monetary: "currency", date: "date", enum: "select", set: "multiselect", phone: "phone" };
/** Pipedrive's own custom fields have a 40-character hash as their key. */
const isCustomField = (f: PdField) => /^[0-9a-f]{40}$/.test(f.key);
const isTagsField = (f: PdField) => isCustomField(f) && (f.field_type === "set" || f.field_type === "enum") && /^tags?$/i.test(f.name.trim());

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  const { db, close } = await connect();
  try {
    if (flag("reset")) return await reset(db);
    await runImport(db);
  } finally {
    await close();
  }
}

async function runImport(db: Database) {
  const token = process.env.PIPEDRIVE_API_TOKEN;
  if (!token) throw new Error("Set PIPEDRIVE_API_TOKEN (Pipedrive → Personal preferences → API) and run again.");
  const dryRun = flag("dry-run");
  // --since: only what was created in Pipedrive in the window is added. --new-only: nothing already here is changed.
  if (args.has("--since")) throw new Error("Give --since a number of days, like --since=14.");
  const since = parseSince(option("since"));
  const newOnly = flag("new-only");
  const fresh = (at: string | null | undefined) => inWindow(time(at), since);
  const emailScope = flag("no-email") ? "none" : option("email") === "all" ? "all" : "clients";
  const api = new PipedriveApi(token, process.env.PIPEDRIVE_COMPANY_DOMAIN);

  // Who the import is recorded as.
  const asEmail = option("as")?.toLowerCase();
  const team = await db.select().from(schema.users);
  const actor = asEmail ? team.find((u) => u.email.toLowerCase() === asEmail) : team.find((u) => u.role === "owner" && !u.deactivatedAt);
  if (!actor) throw new Error(asEmail ? `No teammate with the email ${asEmail}.` : "Create the owner account first (open the app and sign up), then run the import.");

  log("Reading Pipedrive…");
  const [pdUsers, pipelines, stages, activityTypes, dealFields, personFields, orgFields, activityFields] = await Promise.all([
    api.allV1<PdUser>("/v1/users"),
    api.pipelines(),
    api.stages(),
    api.activityTypes(),
    api.fields("deal"),
    api.fields("person"),
    api.fields("organization"),
    api.fields("activity").catch(() => [] as PdField[]),
  ]);
  const orgs = await api.organizations();
  log(`  ${orgs.length} organizations`);
  const persons = await api.persons({ mailTimes: !!since });
  log(`  ${persons.length} people`);
  const deals = await api.deals();
  log(`  ${deals.length} deals`);
  const notes = (await api.notes()).filter((n) => n.active_flag !== false);
  log(`  ${notes.length} notes`);
  const pdActivities = (await api.activities()).filter((a) => !a.is_deleted);
  log(`  ${pdActivities.length} activities`);

  const lk: Lookup = { pipelines: new Map(pipelines.map((p) => [p.id, p])), stages: new Map(stages.map((s) => [s.id, s])) };
  const links = new Links(db);
  await links.load();
  // Records merged here (pnpm run dedupe, or Merge on the People and Organizations pages) carry their Pipedrive ids to the record that was kept.
  // A mapping that still names a merged-away record follows its "merged" history to the kept one.
  const here = await localRecords(db);
  const resolver = (kind: "person" | "organization" | "client") => (id: string) => followMerges(id, (x) => here[kind].ids.has(x), here[kind].into);
  const repaired = (["person", "organization", "client", "deal", "client_archived"] as const).map((kind) => links.repair(kind, resolver(kind === "deal" || kind === "client_archived" ? "client" : kind), newOnly));
  const movedLinks = repaired.reduce((n, r) => n + r.moved, 0);
  const droppedLinks = repaired.reduce((n, r) => n + r.dropped, 0);
  if (movedLinks) log(`  ${movedLinks} Pipedrive records point at a record they were merged into here`);
  if (droppedLinks) log(`  ${droppedLinks} Pipedrive records point at nothing here any more (removed by hand); they're matched by name, email or phone instead`);
  // Clients merged by `pnpm run dedupe` stand for several Pipedrive organizations: plan their deals together, as one client.
  const clientAliases = links.aliases("client");
  const plans = planClients(deals, lk, (key) => clientAliases.get(key) ?? key);
  const stagePlan = planStages(plans, lk);
  const productDeals = deals.filter((d) => lk.pipelines.has(d.pipeline_id) && pipelineRole(lk.pipelines.get(d.pipeline_id)!).kind === "product" && d.status !== "deleted" && !d.is_deleted);
  const serviceNames = [...new Set(pipelines.map(pipelineRole).flatMap((r) => (r.kind === "product" ? [r.service] : [])))];

  if (!newOnly) printPlan(plans, stagePlan, lk, serviceNames, productDeals);
  // Email: by default only for people tied to a client that isn't archived (its contact, or anyone at its organization). Everyone's mail is often mostly cold outreach.
  const activePlans = plans.filter((p) => !p.archivedAt);
  // Every deal's organization and person, not only the lead deal's: a client that duplicates were merged into has the people of each.
  const clientOrgs = new Set(activePlans.flatMap((p) => [p.orgId, ...p.deals.map((d) => d.org_id)]).filter(Boolean));
  const clientPeople = new Set(activePlans.flatMap((p) => [p.personId, ...p.deals.map((d) => d.person_id)]).filter(Boolean));
  // With --since, only people whose last email is in the window (when Pipedrive says; otherwise their mail is read and filtered by date).
  const newMail = (p: (typeof persons)[number]) => !since || (p.last_incoming_mail_time === undefined && p.last_outgoing_mail_time === undefined) || fresh(p.last_incoming_mail_time) || fresh(p.last_outgoing_mail_time);
  const mailPeople = emailScope === "none" ? [] : persons.filter((p) => (p.email_messages_count ?? 1) > 0 && newMail(p) && (emailScope === "all" || clientPeople.has(p.id) || (p.org_id && clientOrgs.has(p.org_id))));
  // Who's already here, for matching Pipedrive records that aren't mapped to anything (new ones, and ones whose record was removed by hand).
  const orgMatcher = new OrganizationMatcher(here.organizations);
  const personMatcher = new PersonMatcher(here.people);
  if (newOnly || since) printWindow({ since, newOnly, orgs, persons, deals, notes, pdActivities, links, orgMatcher, personMatcher, fresh });
  log(
    emailScope === "none"
      ? "\nEmail: skipped (--no-email)"
      : `\nEmail: ${mailPeople.length} people (${emailScope === "all" ? "everyone with email" : "tied to a client; --email=all for everyone"}), about ${mailPeople.reduce((n, p) => n + (p.email_messages_count ?? 0), 0)} messages`,
  );
  if (dryRun) {
    log(`\nDry run: nothing was written. Run again without --dry-run to ${newOnly ? "add these" : "import"}.`);
    return;
  }

  const now = new Date();

  // ── Team: match Pipedrive users by email, then name. Anyone missing is added as a deactivated teammate so history stays attributed.
  const referenced = new Set<PdId>();
  for (const r of [...orgs, ...persons, ...deals]) if (r.owner_id) referenced.add(r.owner_id);
  for (const a of pdActivities) for (const id of [a.owner_id, a.creator_user_id]) if (id) referenced.add(id);
  for (const n of notes) if (n.user_id) referenced.add(n.user_id);
  const userIds = new Map<PdId, string>();
  let usersAdded = 0;
  for (const u of pdUsers) {
    const match = team.find((t) => t.id === links.get("user", u.id)) ?? team.find((t) => t.email.toLowerCase() === u.email?.toLowerCase()) ?? team.find((t) => t.name.toLowerCase() === u.name.toLowerCase());
    if (match) {
      userIds.set(u.id, match.id);
      continue;
    }
    if (!referenced.has(u.id) || !u.email || flag("no-users")) continue;
    const [row] = await db.insert(schema.users).values({ email: u.email.toLowerCase(), name: u.name, role: "member", deactivatedAt: now }).returning({ id: schema.users.id });
    await links.save("user", u.id, row.id);
    userIds.set(u.id, row.id);
    usersAdded++;
  }
  const user = (id: PdId | null | undefined) => (id ? (userIds.get(id) ?? null) : null);
  await links.flush();
  log(`\nTeam: ${userIds.size - usersAdded} matched, ${usersAdded} added as deactivated teammates`);

  // ── Custom fields: Pipedrive's custom fields become custom fields here, with the same names and options.
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  const personName = new Map(persons.map((p) => [p.id, p.name]));
  const userName = new Map(pdUsers.map((u) => [u.id, u.name]));
  const fieldMaps: Record<EntityType, { field: PdField; key: string }[]> = { person: [], organization: [], client: [] };
  for (const [entity, fields] of [["person", personFields], ["organization", orgFields], ["client", dealFields]] as const) {
    const existing = await db.select().from(schema.customFields).where(eq(schema.customFields.entityType, entity));
    const taken = new Set(existing.map((f) => f.key));
    let position = existing.reduce((m, f) => Math.max(m, f.position), -1);
    for (const f of fields.filter(isCustomField)) {
      // A "Tags" field becomes the record's own tags rather than a second, look-alike field.
      if (entity !== "organization" && isTagsField(f)) continue;
      const type = fieldTypeMap[f.field_type] ?? "text";
      const options = (f.options ?? []).map((o) => o.label.trim()).filter(Boolean);
      const known = existing.find((e) => e.id === links.get(`field:${entity}`, f.key));
      if (known) {
        if (options.length) await db.update(schema.customFields).set({ options: [...new Set([...known.options, ...options])] }).where(eq(schema.customFields.id, known.id));
        fieldMaps[entity].push({ field: f, key: known.key });
        continue;
      }
      const base = `pd_${f.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 36) || "field"}`;
      let key = base;
      for (let i = 2; taken.has(key); i++) key = `${base}_${i}`;
      taken.add(key);
      const [row] = await db
        .insert(schema.customFields)
        .values({ entityType: entity, key, label: f.name.trim().slice(0, 80), type, options: [...new Set(options)], position: ++position })
        .returning({ id: schema.customFields.id });
      await links.save(`field:${entity}`, f.key, row.id);
      fieldMaps[entity].push({ field: f, key });
    }
  }
  await links.flush();
  const tagFields = { person: personFields.filter(isTagsField), client: dealFields.filter(isTagsField) };
  const tagValues = (entity: "person" | "client", values: Record<string, unknown> | null | undefined) =>
    tagFields[entity].flatMap((f) => {
      const v = convertField(f, values?.[f.key], { orgName, personName, userName });
      return Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
    });
  const customValues = (entity: EntityType, values: Record<string, unknown> | null | undefined): CustomValues => {
    const out: CustomValues = {};
    for (const { field, key } of fieldMaps[entity]) {
      const v = convertField(field, values?.[field.key], { orgName, personName, userName });
      if (v !== null) out[key] = v;
    }
    return out;
  };

  // ── Organizations
  const orgIds = new Map<PdId, string>();
  const orgRows = orgs.map((o) => {
    const custom = customValues("organization", o.custom_fields);
    const domainField = orgFields.find((f) => isCustomField(f) && /domain/i.test(f.name));
    const website = o.website || (domainField ? String(o.custom_fields?.[domainField.key] ?? "") : "");
    const labels = (o.labels ?? []).map((l) => l.label);
    if (labels.length) custom.pd_labels = labels;
    const industry = o.industry !== null && o.industry !== undefined ? (orgFields.find((f) => f.key === "industry")?.options?.find((x) => String(x.id) === String(o.industry))?.label ?? String(o.industry)) : null;
    return {
      pd: o.id,
      values: {
        name: clip(o.name, 120) ?? "Unnamed organization",
        domain: clip(website.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/.*$/, "").toLowerCase(), 120),
        address: clip(o.address?.formatted_address || o.address?.value, 300),
        industry: clip(industry, 120),
        ownerId: user(o.owner_id),
        custom,
      },
      createdAt: time(o.add_time) ?? now,
    };
  });
  if (orgRows.some((r) => r.values.custom.pd_labels)) await ensureField(db, links, "organization", "pd_labels", "Labels", "multiselect", [...new Set(orgs.flatMap((o) => (o.labels ?? []).map((l) => l.label)))]);
  const orgCreated = new Map(orgs.map((o) => [o.id, o.add_time]));
  if (newOnly) {
    const counts = await addNew(db, links, "organization", orgRows, actor.id, orgIds, {
      fresh: (r) => fresh(orgCreated.get(r.pd)),
      match: (r) => orgMatcher.find(orgName.get(r.pd)),
      remember: (id, r) => orgMatcher.add({ id, name: r.values.name }),
    });
    log(`Organizations: ${counts.created} added, ${counts.matched} matched to ones already here`);
  } else {
    const orgCounts = await upsert(db, links, "organization", schema.organizations, orgRows.filter((r) => links.get("organization", r.pd) || fresh(orgCreated.get(r.pd))), actor.id, orgIds);
    log(`Organizations: ${orgCounts.created} added, ${orgCounts.updated} updated`);
  }
  for (const o of orgs) if (!orgIds.has(o.id) && links.get("organization", o.id)) orgIds.set(o.id, links.get("organization", o.id)!);

  // ── People
  const personIds = new Map<PdId, string>();
  const personOrg = new Map(persons.map((p) => [p.id, p.org_id]));
  const personRows = persons.map((p) => {
    const email = (p.emails?.find((e) => e.primary && e.value) ?? p.emails?.find((e) => e.value))?.value?.trim().toLowerCase() ?? null;
    const phone = (p.phones?.find((e) => e.primary && e.value) ?? p.phones?.find((e) => e.value))?.value ?? null;
    const [first, ...rest] = (p.name ?? "").trim().split(/\s+/);
    const titleField = personFields.find((f) => isCustomField(f) && /^title/i.test(f.name) && f.field_type === "varchar");
    return {
      pd: p.id,
      values: {
        firstName: clip(p.first_name, 80) ?? clip(first, 80) ?? email?.split("@")[0] ?? "Unknown",
        lastName: clip(p.last_name, 80) ?? (rest.length ? clip(rest.join(" "), 80) : null),
        email: clip(email, 320),
        phone: clip(phone, 40),
        title: clip(p.job_title ?? (titleField ? String(p.custom_fields?.[titleField.key] ?? "") : null), 120),
        organizationId: p.org_id ? (orgIds.get(p.org_id) ?? null) : null,
        ownerId: user(p.owner_id),
        tags: [...new Set([...(p.labels ?? []).map((l) => l.label), ...tagValues("person", p.custom_fields)].map((t) => t.slice(0, 40)))].slice(0, 30),
        custom: customValues("person", p.custom_fields),
      },
      createdAt: time(p.add_time) ?? now,
    };
  });
  const personCreated = new Map(persons.map((p) => [p.id, p.add_time]));
  if (newOnly) {
    // Every email and phone Pipedrive has for them, not only the primary ones: a person here is found by any of them, and keeps them all.
    const byId = new Map(persons.map((p) => [p.id, p]));
    const rows = personRows.map((r) => {
      const p = byId.get(r.pd)!;
      const otherEmails = [...new Set((p.emails ?? []).map((e) => emailKey(e.value)).filter((e) => e && e !== emailKey(r.values.email)))].slice(0, 20);
      const otherPhones = [...new Set((p.phones ?? []).map((e) => e.value?.trim()).filter((v): v is string => !!v && v !== r.values.phone))].slice(0, 20);
      return { ...r, values: { ...r.values, otherEmails, otherPhones } };
    });
    const counts = await addNew(db, links, "person", rows, actor.id, personIds, {
      fresh: (r) => fresh(personCreated.get(r.pd)),
      match: (r) => personMatcher.find(r.values),
      remember: (id, r) => personMatcher.add({ id, ...r.values }),
    });
    log(`People: ${counts.created} added, ${counts.matched} matched to people already here`);
  } else {
    const personCounts = await upsert(db, links, "person", schema.people, personRows.filter((r) => links.get("person", r.pd) || fresh(personCreated.get(r.pd))), actor.id, personIds);
    log(`People: ${personCounts.created} added, ${personCounts.updated} updated`);
  }
  for (const p of persons) if (!personIds.has(p.id) && links.get("person", p.id)) personIds.set(p.id, links.get("person", p.id)!);

  // ── Pipelines and stages: one pipeline per category, holding Pipedrive's stage names verbatim.
  const stageIds = new Map<string, string>(); // `${category}:${name}` → stage id
  const pipelineIds = {} as Record<ClientCategory, string>;
  for (const category of ["prospective", "current", "past"] as const) {
    let [pipeline] = await db.select().from(schema.pipelines).where(eq(schema.pipelines.category, category)).orderBy(schema.pipelines.position).limit(1);
    if (!pipeline) {
      [pipeline] = await db.insert(schema.pipelines).values({ name: { prospective: "Sales", current: "Accounts", past: "Former clients" }[category], category }).returning();
    }
    pipelineIds[category] = pipeline.id;
    const existing = await db.select().from(schema.stages).where(eq(schema.stages.pipelineId, pipeline.id)).orderBy(schema.stages.position);
    // --new-only leaves the pipelines as they are: a stage a new client needs is added after the others when it's created.
    if (newOnly) {
      for (const e of existing) if (!stageIds.has(`${category}:${e.name}`)) stageIds.set(`${category}:${e.name}`, e.id);
      continue;
    }
    const wanted = stagePlan[category];
    const ordered: string[] = [];
    for (const s of wanted) {
      let row = existing.find((e) => e.name === s.name);
      if (!row) {
        [row] = await db.insert(schema.stages).values({ pipelineId: pipeline.id, name: s.name, probability: s.probability, rottingDays: null }).returning();
        await links.save("stage", `${category}:${s.name}`, row.id);
      }
      stageIds.set(`${category}:${s.name}`, row.id);
      ordered.push(row.id);
    }
    // Pipedrive's stages first, in Pipedrive's order; anything else keeps its order after them.
    const rest = existing.filter((e) => !ordered.includes(e.id)).map((e) => e.id);
    await Promise.all([...ordered, ...rest].map((id, position) => db.update(schema.stages).set({ position }).where(eq(schema.stages.id, id))));
  }
  await links.flush();
  const ensureStage = async (category: ClientCategory, name: string) => {
    if (stageIds.has(`${category}:${name}`)) return;
    const [last] = await db.select({ position: schema.stages.position }).from(schema.stages).where(eq(schema.stages.pipelineId, pipelineIds[category])).orderBy(sql`${schema.stages.position} desc`).limit(1);
    const probability = stagePlan[category].find((s) => s.name === name)?.probability ?? 0;
    const [row] = await db.insert(schema.stages).values({ pipelineId: pipelineIds[category], name, probability, rottingDays: null, position: (last?.position ?? -1) + 1 }).returning();
    await links.save("stage", `${category}:${name}`, row.id);
    stageIds.set(`${category}:${name}`, row.id);
    log(`  Added the stage "${name}" to the ${category} pipeline`);
  };

  // ── Services: one per product pipeline.
  const serviceIds = new Map<string, string>();
  const services = await db.select().from(schema.services);
  for (const [i, name] of serviceNames.entries()) {
    let row = services.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!row) {
      [row] = await db.insert(schema.services).values({ name, interval: "month", position: services.length + i }).returning();
      await links.save("service", name, row.id);
    }
    serviceIds.set(name, row.id);
  }
  await links.flush();

  // ── Clients: one per organization (or person), from all its deals.
  const ranks = new Map<string, string>();
  for (const r of await db.select({ stageId: schema.clients.stageId, max: sql<string>`max(${schema.clients.rank})` }).from(schema.clients).groupBy(schema.clients.stageId)) ranks.set(r.stageId, r.max);
  const nextRank = (stageId: string) => {
    const r = rankBetween(ranks.get(stageId) ?? null, null);
    ranks.set(stageId, r);
    return r;
  };
  const clientIds = new Map<string, string>(); // plan key → client id
  const dealClient = new Map<PdId, string>();
  let clientsCreated = 0;
  let clientsUpdated = 0;
  const stageNames = new Map((await db.select({ id: schema.stages.id, name: schema.stages.name }).from(schema.stages)).map((s) => [s.id, s.name]));
  const existingClients = new Map((await db.select().from(schema.clients)).map((c) => [c.id, c]));
  // Deals already brought in, and the ones new in the window (--new-only adds only those).
  const newDeals = new Set(deals.filter((d) => !links.get("deal", d.id) && fresh(d.add_time)).map((d) => d.id));
  const joined: string[] = [];
  if (newOnly) {
    // A client here for an organization or person, for new deals on one whose client wasn't brought in from Pipedrive: live ones first, then the oldest.
    const byRecord = new Map<string, string>();
    for (const c of [...existingClients.values()].sort((a, b) => Number(!!a.archivedAt) - Number(!!b.archivedAt) || a.createdAt.getTime() - b.createdAt.getTime())) {
      for (const k of [c.organizationId && `org:${c.organizationId}`, !c.organizationId && c.personId && `person:${c.personId}`]) if (k && !byRecord.has(k)) byRecord.set(k, c.id);
    }
    for (const plan of [...plans].sort((a, b) => Date.parse(a.lead.add_time) - Date.parse(b.lead.add_time))) {
      const added = plan.deals.filter((d) => newDeals.has(d.id));
      let id = links.get("client", plan.key) ?? plan.deals.map((d) => links.get("deal", d.id)).find(Boolean) ?? null;
      if (!id && added.length) {
        const org = plan.orgId ? orgIds.get(plan.orgId) : null;
        const person = plan.personId ? personIds.get(plan.personId) : null;
        id = (org ? byRecord.get(`org:${org}`) : undefined) ?? (!org && person ? byRecord.get(`person:${person}`) : undefined) ?? null;
        if (id) await links.save("client", plan.key, id);
      }
      if (id && existingClients.has(id)) {
        // Already a client here: the new deals join it, and its stage, category and fields stay as the team left them.
        for (const d of added) joined.push(`  ${existingClients.get(id)!.name}: "${d.title}" (${lk.pipelines.get(d.pipeline_id)?.name} · ${lk.stages.get(d.stage_id)?.name}, ${d.status})`);
      } else if (added.length) {
        await ensureStage(plan.category, stageName(plan.stage));
        const values = clientValues(plan, lk, { orgName, personName, orgIds, personIds, user, customValues, tagValues, stageIds, pipelineIds });
        const createdAt = new Date(Math.min(...plan.deals.map((d) => time(d.add_time)?.getTime() ?? now.getTime())));
        const [row] = await db
          .insert(schema.clients)
          .values({ ...values, rank: nextRank(values.stageId), createdBy: actor.id, createdAt, archivedAt: plan.archivedAt })
          .returning();
        await links.save("client", plan.key, row.id);
        if (plan.archivedAt) await links.save("client_archived", plan.key, row.id);
        await db.insert(schema.events).values({
          entityType: "client",
          entityId: row.id,
          action: "created",
          data: { category: plan.category, stage: stageName(plan.stage), source: SOURCE, deals: plan.deals.map((d) => ({ id: d.id, title: d.title, pipeline: lk.pipelines.get(d.pipeline_id)?.name, stage: lk.stages.get(d.stage_id)?.name, status: d.status })) },
          userId: actor.id,
        });
        existingClients.set(row.id, row);
        for (const k of [values.organizationId && `org:${values.organizationId}`, !values.organizationId && values.personId && `person:${values.personId}`]) if (k && !byRecord.has(k)) byRecord.set(k, row.id);
        id = row.id;
        clientsCreated++;
      } else continue;
      clientIds.set(plan.key, id);
      for (const [from, to] of clientAliases) if (to === plan.key) clientIds.set(from, id);
      for (const d of plan.deals) {
        dealClient.set(d.id, id);
        if (newDeals.has(d.id)) links.add("deal", d.id, id);
      }
    }
  }
  // Oldest first, so ranks put long-standing clients at the top of each column.
  for (const plan of newOnly ? [] : [...plans].sort((a, b) => Date.parse(a.lead.add_time) - Date.parse(b.lead.add_time))) {
    // With --since, a client is only created for deals new in the window.
    if (since && !links.get("client", plan.key) && !plan.deals.some((d) => newDeals.has(d.id))) continue;
    const values = clientValues(plan, lk, { orgName, personName, orgIds, personIds, user, customValues, tagValues, stageIds, pipelineIds });
    const id = links.get("client", plan.key);
    const current = id ? existingClients.get(id) : undefined;
    if (current) {
      const moved = current.stageId !== values.stageId;
      // Follow Pipedrive's archiving, but only where the import is the one that archived: a client archived or restored by hand stays as it is.
      const archivedByImport = [plan.key, ...[...clientAliases].filter(([, to]) => to === plan.key).map(([from]) => from)].some((k) => !!links.get("client_archived", k));
      const archive = plan.archivedAt && !current.archivedAt && !archivedByImport ? { archivedAt: plan.archivedAt } : !plan.archivedAt && current.archivedAt && archivedByImport ? { archivedAt: null } : {};
      await db
        .update(schema.clients)
        .set({ ...values, ...archive, ...(moved ? { rank: nextRank(values.stageId) } : {}), updatedAt: now })
        .where(eq(schema.clients.id, current.id));
      if ("archivedAt" in archive) {
        await db.insert(schema.events).values({ entityType: "client", entityId: current.id, action: archive.archivedAt ? "archived" : "restored", data: { source: SOURCE }, userId: actor.id });
        if (archive.archivedAt) await links.save("client_archived", plan.key, current.id);
        else await links.remove("client_archived", plan.key);
      }
      if (current.category !== values.category) await db.insert(schema.events).values({ entityType: "client", entityId: current.id, action: "category_changed", data: { from: current.category, to: values.category, stage: stageName(plan.stage), source: SOURCE }, userId: actor.id });
      else if (moved) await db.insert(schema.events).values({ entityType: "client", entityId: current.id, action: "stage_changed", data: { from: stageNames.get(current.stageId) ?? null, to: stageName(plan.stage), source: SOURCE }, userId: actor.id });
      clientIds.set(plan.key, current.id);
      clientsUpdated++;
    } else {
      const createdAt = new Date(Math.min(...plan.deals.map((d) => time(d.add_time)?.getTime() ?? now.getTime())));
      const [row] = await db
        .insert(schema.clients)
        // A client whose deals are all archived in Pipedrive comes in archived: its history is kept, off the boards.
        .values({ ...values, rank: nextRank(values.stageId), createdBy: actor.id, createdAt, archivedAt: plan.archivedAt })
        .returning({ id: schema.clients.id });
      await links.save("client", plan.key, row.id);
      if (plan.archivedAt) await links.save("client_archived", plan.key, row.id);
      await db.insert(schema.events).values({
        entityType: "client",
        entityId: row.id,
        action: "created",
        data: { category: plan.category, stage: stageName(plan.stage), source: SOURCE, deals: plan.deals.map((d) => ({ id: d.id, title: d.title, pipeline: lk.pipelines.get(d.pipeline_id)?.name, stage: lk.stages.get(d.stage_id)?.name, status: d.status })) },
        userId: actor.id,
      });
      clientIds.set(plan.key, row.id);
      clientsCreated++;
    }
    // Keys folded into this one (merged clients) find it too, for notes and activities on those organizations.
    for (const [from, to] of clientAliases) if (to === plan.key) clientIds.set(from, clientIds.get(plan.key)!);
    for (const d of plan.deals) {
      dealClient.set(d.id, clientIds.get(plan.key)!);
      links.add("deal", d.id, clientIds.get(plan.key)!);
    }
  }
  await links.flush();
  if (newOnly) {
    log(`Clients: ${clientsCreated} added, from ${newDeals.size} new deals`);
    if (joined.length) log(`New deals on clients already here (their stage and category are left as they are; move them by hand if a deal changes that):\n${joined.join("\n")}`);
  } else log(`Clients: ${clientsCreated} added, ${clientsUpdated} updated (from ${plans.reduce((n, p) => n + p.deals.length, 0)} deals)`);

  // ── Services each client uses or used: one per product deal.
  const startField = dealFields.find((f) => isCustomField(f) && f.field_type === "date" && /start/i.test(f.name));
  const endField = dealFields.find((f) => isCustomField(f) && f.field_type === "date" && /end/i.test(f.name));
  const noteFields = dealFields.filter((f) => isCustomField(f) && /product|plan|level/i.test(f.name));
  let servicesAdded = 0;
  // --new-only: services only for new product deals, and not when the client already has that service going (someone added it here).
  const ongoing = new Map<string, string>();
  if (newOnly) for (const r of await db.select().from(schema.clientServices).where(isNull(schema.clientServices.endedOn))) ongoing.set(`${r.clientId}:${r.serviceId}`, r.id);
  for (const d of productDeals) {
    const clientId = dealClient.get(d.id);
    const role = pipelineRole(lk.pipelines.get(d.pipeline_id)!);
    if (!clientId || role.kind !== "product") continue;
    if ((newOnly || since) && !links.get("client_service", d.id) && !newDeals.has(d.id)) continue;
    if (newOnly && links.get("client_service", d.id)) continue;
    if (newOnly && ongoing.has(`${clientId}:${serviceIds.get(role.service)}`)) {
      await links.save("client_service", d.id, ongoing.get(`${clientId}:${serviceIds.get(role.service)}`)!);
      continue;
    }
    const ended = productEnded(d, lk);
    const note = noteFields
      .map((f) => {
        const v = convertField(f, d.custom_fields?.[f.key], { orgName, personName, userName });
        return v === null || (Array.isArray(v) && !v.length) ? null : `${f.name}: ${Array.isArray(v) ? v.join(", ") : v}`;
      })
      .filter(Boolean)
      .join(" · ");
    const values = {
      clientId,
      serviceId: serviceIds.get(role.service)!,
      // Pipedrive's MRR when it's filled in; otherwise the deal value, which this account records as a yearly contract value.
      price: cents(d.mrr || d.value),
      interval: d.mrr ? ("month" as const) : ("year" as const),
      startedOn: day(startField ? String(d.custom_fields?.[startField.key] ?? "") : null) ?? day(d.first_won_time) ?? day(d.won_time) ?? day(d.add_time),
      endedOn: ended ? (day(endField ? String(d.custom_fields?.[endField.key] ?? "") : null) ?? day(d.lost_time) ?? day(d.close_time) ?? day(d.stage_change_time) ?? day(d.update_time)) : null,
      note: clip(`${d.title}${note ? ` · ${note}` : ""}`, 500),
    };
    const id = links.get("client_service", d.id);
    if (id) await db.update(schema.clientServices).set(values).where(eq(schema.clientServices.id, id));
    else {
      const [row] = await db.insert(schema.clientServices).values(values).returning({ id: schema.clientServices.id });
      await links.save("client_service", d.id, row.id);
      if (newOnly && !values.endedOn) ongoing.set(`${clientId}:${values.serviceId}`, row.id);
      if (newOnly) await db.insert(schema.events).values({ entityType: "client", entityId: clientId, action: "service_added", data: { name: role.service, source: SOURCE }, userId: actor.id });
      servicesAdded++;
    }
  }
  await links.flush();
  log(`Services on clients: ${servicesAdded} added`);

  // ── Timeline: notes, activities, email.
  const clientFor = (dealId: PdId | null | undefined, orgId: PdId | null | undefined, personId: PdId | null | undefined) =>
    (dealId ? dealClient.get(dealId) : undefined) ??
    (orgId ? clientIds.get(`org:${orgId}`) : undefined) ??
    (personId ? (clientIds.get(`person:${personId}`) ?? (personOrg.get(personId) ? clientIds.get(`org:${personOrg.get(personId)}`) : undefined)) : undefined) ??
    null;
  const dealOrg = new Map(deals.map((d) => [d.id, d.org_id]));
  // --new-only: when Pipedrive's records don't lead to a client, the client here for the organization or person does.
  const clientOf = new Map<string, string>();
  if (newOnly) {
    for (const c of [...existingClients.values()].sort((a, b) => Number(!!a.archivedAt) - Number(!!b.archivedAt) || a.createdAt.getTime() - b.createdAt.getTime())) {
      for (const k of [c.organizationId, c.personId]) if (k && !clientOf.has(k)) clientOf.set(k, c.id);
    }
  }
  const linksFor = (dealId: PdId | null | undefined, orgId: PdId | null | undefined, personId: PdId | null | undefined) => {
    const org = orgId ?? (personId ? personOrg.get(personId) : null) ?? (dealId ? dealOrg.get(dealId) : null) ?? null;
    const local = { personId: personId ? (personIds.get(personId) ?? null) : null, organizationId: org ? (orgIds.get(org) ?? null) : null };
    // Someone whose Pipedrive organization isn't here is still at their organization here.
    if (newOnly && !local.organizationId && local.personId) local.organizationId = here.personOrg.get(local.personId) ?? null;
    const clientId = clientFor(dealId, org, personId) ?? (newOnly ? ((local.organizationId && clientOf.get(local.organizationId)) || (local.personId && clientOf.get(local.personId)) || null) : null);
    return { ...local, clientId };
  };
  const attached = (r: { values: { personId?: string | null; organizationId?: string | null; clientId?: string | null } }) => !!(r.values.personId || r.values.organizationId || r.values.clientId);

  const newNotes = notes.filter((n) => !links.get("note", n.id) && fresh(n.add_time));
  const noteRows = newNotes
    .map((n) => {
      const at = time(n.add_time) ?? now;
      return { pd: n.id, values: { type: "note" as const, body: cleanHtml(n.content), occurredAt: at, createdAt: at, updatedAt: at, pinned: !!(n.pinned_to_deal_flag || n.pinned_to_person_flag || n.pinned_to_organization_flag), userId: user(n.user_id), assigneeId: user(n.user_id), ...linksFor(n.deal_id, n.org_id, n.person_id) } };
    })
    .filter((r) => r.values.body && attached(r));
  await insertActivities(db, links, "note", noteRows);
  log(`Notes: ${noteRows.length} added${unplaced(newNotes.filter((n) => n.content?.trim()).length - noteRows.length)}`);

  const typeNames = new Map(activityTypes.map((t) => [t.key_string, t.name]));
  const outcomeNames = new Map((activityFields.find((f) => f.key === "outcome")?.options ?? []).map((o) => [String(o.id), o.label.trim()]));
  const newActivities = pdActivities.filter((a) => !links.get("activity", a.id) && fresh(a.add_time));
  const activityRows = newActivities.map((a) => ({ pd: a.id, values: { ...activityValues(a, typeNames, outcomeNames, user, now), ...linksFor(a.deal_id, a.org_id, a.person_id) } })).filter(attached);
  await insertActivities(db, links, "activity", activityRows);
  const byType = Object.entries(Object.groupBy(activityRows, (r) => r.values.type)).map(([t, list]) => `${list!.length} ${t}`);
  log(`Activities: ${activityRows.length} added${byType.length ? ` (${byType.join(", ")})` : ""}${unplaced(newActivities.length - activityRows.length)}`);

  if (mailPeople.length) {
    const withMail = mailPeople.filter((p) => personIds.has(p.id));
    log(`Email: reading the mail of ${withMail.length} people (this is the slow part; --no-email skips it)…`);
    let done = 0;
    let added = 0;
    const seen = new Set<PdId>();
    await mapLimit(withMail, 4, async (p) => {
      const mail = await api.personMail(p.id).catch((err) => {
        console.warn(`  Couldn't read email for ${p.name}: ${err instanceof Error ? err.message : err}`);
        return [] as PdMailMessage[];
      });
      const rows = mail
        .filter((m) => !m.draft_flag && !m.deleted_flag && !seen.has(m.id) && !links.get("email", m.id) && fresh(m.message_time))
        .map((m) => {
          seen.add(m.id);
          return { pd: m.id, values: { ...emailValues(m, user), ...linksFor(m.deal_id, null, p.id) } };
        });
      await insertActivities(db, links, "email", rows);
      added += rows.length;
      if (++done % 50 === 0) log(`  ${done}/${withMail.length} people, ${added} emails`);
    });
    log(`Email: ${added} messages added`);
  }

  // ── Last activity dates, for sorting and "needs attention".
  for (const [table, column] of [
    ["people", "person_id"],
    ["organizations", "organization_id"],
    ["clients", "client_id"],
  ] as const) {
    await db.execute(
      sql.raw(`update "${table}" t set last_activity_at = s.at from (select ${column} as id, max(coalesce(occurred_at, completed_at)) as at from activities where ${column} is not null group by ${column}) s
       where t.id = s.id and s.at is not null and (t.last_activity_at is null or t.last_activity_at < s.at)`),
    );
  }
  log(`\nDone. ${api.requests} Pipedrive requests.`);
}

// ─── Record builders ─────────────────────────────────────────────────────

function convertField(field: PdField, raw: unknown, names: { orgName: Map<PdId, string>; personName: Map<PdId, string>; userName: Map<PdId, string> }): CustomValues[string] {
  if (raw === null || raw === undefined || raw === "") return null;
  const label = (id: unknown) => field.options?.find((o) => String(o.id) === String(typeof id === "object" && id && "id" in id ? (id as { id: unknown }).id : id))?.label.trim() ?? null;
  const idOf = (v: unknown) => Number(typeof v === "object" && v && "value" in v ? (v as { value: unknown }).value : typeof v === "object" && v && "id" in v ? (v as { id: unknown }).id : v);
  switch (field.field_type) {
    case "enum":
      return label(raw);
    case "set": {
      const ids = Array.isArray(raw) ? raw : String(raw).split(",");
      return ids.map(label).filter((v): v is string => !!v);
    }
    case "double":
    case "int": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    case "monetary": {
      const n = Number(typeof raw === "object" && raw && "value" in raw ? (raw as { value: unknown }).value : raw);
      return Number.isFinite(n) ? Math.round(n * 100) : null;
    }
    case "date":
      return day(String(raw));
    case "org":
      return names.orgName.get(idOf(raw)) ?? null;
    case "people":
      return names.personName.get(idOf(raw)) ?? null;
    case "user":
      return names.userName.get(idOf(raw)) ?? null;
    case "address":
      return clip(typeof raw === "object" && raw ? String((raw as { formatted_address?: string; value?: string }).formatted_address ?? (raw as { value?: string }).value ?? "") : String(raw), 500);
    case "text":
      return clip(String(raw), 10_000);
    default:
      return clip(typeof raw === "object" ? JSON.stringify(raw) : String(raw), 500);
  }
}

type Ctx = {
  orgName: Map<PdId, string>;
  personName: Map<PdId, string>;
  orgIds: Map<PdId, string>;
  personIds: Map<PdId, string>;
  user: (id: PdId | null | undefined) => string | null;
  customValues: (entity: EntityType, values: Record<string, unknown> | null | undefined) => CustomValues;
  tagValues: (entity: "person" | "client", values: Record<string, unknown> | null | undefined) => string[];
  stageIds: Map<string, string>;
  pipelineIds: Record<ClientCategory, string>;
};

function clientValues(plan: ClientPlan, lk: Lookup, c: Ctx) {
  const { lead, category } = plan;
  const product = plan.deals.filter((d) => pipelineRole(lk.pipelines.get(d.pipeline_id)!).kind === "product");
  const openSales = plan.deals.filter((d) => dealCategory(d, lk) === "prospective" && d.status === "open");
  // Custom fields: the lead deal first, then blanks filled from the others; multi-option fields combine.
  const custom: CustomValues = {};
  for (const d of [lead, ...plan.deals.filter((d) => d !== lead)]) {
    for (const [k, v] of Object.entries(c.customValues("client", d.custom_fields))) {
      const prev = custom[k];
      if (Array.isArray(prev) && Array.isArray(v)) custom[k] = [...new Set([...prev, ...v])];
      else if (prev === undefined || prev === null) custom[k] = v;
    }
  }
  const tags = [...new Set(plan.deals.flatMap((d) => [...(d.labels ?? []).map((l) => l.label), ...c.tagValues("client", d.custom_fields)].map((t) => t.slice(0, 40))))];
  if (category === "prospective" && lead.status === "lost") tags.push("Lost in Pipedrive");
  const starts = product.map((d) => day(d.first_won_time) ?? day(d.won_time) ?? day(d.add_time)).filter((d): d is string => !!d);
  const wonSales = plan.deals.filter((d) => d.status === "won").map((d) => day(d.won_time)).filter((d): d is string => !!d);
  const ends = product.filter((d) => dealCategory(d, lk) === "past").map((d) => day(d.lost_time) ?? day(d.close_time) ?? day(d.stage_change_time)).filter((d): d is string => !!d);
  const name = (plan.orgId && c.orgName.get(plan.orgId)) || (plan.personId && c.personName.get(plan.personId)) || lead.title;
  const changed = time(lead.stage_change_time) ?? time(lead.update_time) ?? time(lead.add_time) ?? new Date();
  return {
    name: name.trim().slice(0, 200),
    category,
    value: category === "prospective" ? (openSales.length ? openSales.reduce((n, d) => n + cents(d.value), 0) : cents(lead.value)) : cents(lead.value),
    currency: lead.currency || "USD",
    pipelineId: c.pipelineIds[category],
    stageId: c.stageIds.get(`${category}:${stageName(plan.stage)}`)!,
    expectedCloseDate: category === "prospective" ? day(lead.expected_close_date) : null,
    startedOn: category === "prospective" ? null : ([...starts, ...wonSales].sort()[0] ?? null),
    endedOn: category === "past" ? (ends.sort().at(-1) ?? day(lead.close_time) ?? day(lead.update_time)) : null,
    churnReason: category === "past" ? clip(lead.lost_reason, 200) : null,
    openToReturn: category === "past" ? openToReturn(plan.stage) : true,
    tags: tags.slice(0, 30),
    personId: plan.personId ? (c.personIds.get(plan.personId) ?? null) : null,
    organizationId: plan.orgId ? (c.orgIds.get(plan.orgId) ?? null) : null,
    ownerId: c.user(lead.owner_id),
    custom,
    stageChangedAt: changed,
    categoryChangedAt: changed,
  };
}

function activityValues(a: PdActivity, typeNames: Map<string, string>, outcomeNames: Map<string, string>, user: (id: PdId | null | undefined) => string | null, now: Date) {
  const type = activityTypeMap[a.type] ?? "task";
  const hasTime = !!a.due_time;
  const due = a.due_date ? new Date(hasTime ? `${a.due_date}T${a.due_time!.slice(0, 5)}:00Z` : `${a.due_date}T12:00:00Z`) : null;
  const doneAt = time(a.marked_as_done_time);
  const [h, m] = (a.duration ?? "").split(":").map(Number);
  const minutes = Number.isFinite(h) && Number.isFinite(m) && h * 60 + m > 0 ? h * 60 + m : null;
  const location = typeof a.location === "string" ? a.location : a.location?.value;
  const extra = [location && `Location: ${location}`, a.conference_meeting_url && `Video call: ${a.conference_meeting_url}`, a.public_description].filter(Boolean).join("\n");
  const body = [cleanHtml(a.note), extra ? textToHtml(extra) : null].filter(Boolean).join("");
  const label = !activityTypeMap[a.type] ? typeNames.get(a.type) : null;
  const subject = clip([label, a.subject].filter(Boolean).join(": "), 200);
  const createdAt = time(a.add_time) ?? now;
  return {
    type,
    subject,
    body: body || null,
    // Outcome is an option id ("Connected", "Left voicemail" …); keep its label.
    outcome: a.outcome === null || a.outcome === undefined ? null : clip(outcomeNames.get(String(a.outcome)) ?? (typeof a.outcome === "string" ? a.outcome : null), 80),
    durationMinutes: minutes,
    occurredAt: a.done ? (due ?? doneAt ?? createdAt) : null,
    dueAt: due ?? (a.done ? null : createdAt),
    dueHasTime: hasTime,
    completedAt: a.done ? (doneAt ?? due ?? createdAt) : null,
    userId: user(a.creator_user_id) ?? user(a.owner_id),
    assigneeId: user(a.owner_id),
    createdAt,
    updatedAt: createdAt,
  };
}

function emailValues(m: PdMailMessage, user: (id: PdId | null | undefined) => string | null) {
  const at = time(m.message_time) ?? new Date();
  const who = (list: PdMailMessage["to"]) => list.map((p) => (p.name ? `${p.name} <${p.email_address}>` : p.email_address)).join(", ");
  const header = textToHtml([`From: ${who(m.from)}`, `To: ${who(m.to)}`, m.cc?.length ? `Cc: ${who(m.cc)}` : null].filter(Boolean).join("\n"));
  const body = cleanHtml(m.body) ?? (m.snippet ? textToHtml(m.snippet) : null);
  return {
    type: "email" as const,
    subject: clip(m.subject, 200) ?? "(no subject)",
    body: `${header}<hr>${body ?? ""}`,
    direction: (m.sent_flag ? "outbound" : "inbound") as "outbound" | "inbound",
    occurredAt: at,
    createdAt: at,
    updatedAt: at,
    userId: m.sent_flag ? user(m.user_id) : null,
    assigneeId: user(m.user_id),
  };
}

// ─── Writers ─────────────────────────────────────────────────────────────

type RecordTable = typeof schema.organizations | typeof schema.people;

/** Inserts records that are new and updates the ones a previous run brought in. Pipedrive's values win for the fields it has. */
async function upsert<V extends Record<string, unknown>>(
  db: Database,
  links: Links,
  kind: "organization" | "person",
  table: RecordTable,
  rows: { pd: PdId; values: V; createdAt: Date }[],
  actorId: string,
  ids: Map<PdId, string>,
) {
  const fresh = rows.filter((r) => !links.get(kind, r.pd));
  const known = rows.filter((r) => links.get(kind, r.pd));
  for (const batch of chunks(fresh, 500)) {
    const created = (await db
      .insert(table)
      .values(batch.map((r) => ({ ...r.values, createdBy: actorId, createdAt: r.createdAt, updatedAt: r.createdAt })) as never)
      .returning({ id: table.id })) as { id: string }[];
    created.forEach((row, i) => links.add(kind, batch[i].pd, row.id));
    await links.flush();
    await db.insert(schema.events).values(created.map((row) => ({ entityType: kind, entityId: row.id, action: "created", data: { source: SOURCE }, userId: actorId })));
  }
  // Records that stand for more than one Pipedrive record were merged (pnpm run dedupe): Pipedrive only fills their blanks, so the duplicates don't overwrite each other.
  const merged = links.shared(kind);
  const current = new Map<string, Record<string, unknown>>();
  for (const batch of chunks([...new Set(known.map((r) => links.get(kind, r.pd)!))], 500)) {
    for (const row of (await db.select().from(table).where(inArray(table.id, batch))) as Record<string, unknown>[]) current.set(row.id as string, row);
  }
  // One update per local record. A merged record gets all of its Pipedrive records in one go, so they don't overwrite each other's emails, tags and fields.
  const incoming = new Map<string, V[]>();
  for (const r of known) {
    const id = links.get(kind, r.pd)!;
    incoming.set(id, [...(incoming.get(id) ?? []), r.values]);
  }
  const alsoAt: { personId: string; organizationId: string }[] = [];
  await mapLimit([...incoming], 8, async ([id, list]) => {
    const now = current.get(id);
    if (!now) return;
    let values: Record<string, unknown> = list[0];
    if (kind === "organization") {
      if (merged.has(id)) values = planOrganizationMerge(now as unknown as OrgFields, list as Partial<OrgFields>[]);
    } else if (merged.has(id)) {
      const plan = planPersonMerge(now as unknown as PersonFields, list as Partial<PersonFields>[]);
      values = plan.patch;
      alsoAt.push(...plan.alsoAt.map((organizationId) => ({ personId: id, organizationId })));
    } else {
      // Pipedrive's primary email and phone lead, but the ones they replace are kept as other emails and phones.
      values = { ...list[0], ...keepContactsOnImport(now as unknown as PersonFields, list[0] as unknown as { email: string | null; phone: string | null }) };
    }
    if (!Object.keys(values).length) return;
    await db
      .update(table)
      .set({ ...values, updatedAt: new Date() } as never)
      .where(eq(table.id, id));
  });
  if (alsoAt.length) await db.insert(schema.personOrganizations).values(alsoAt).onConflictDoNothing();
  await links.flush();
  for (const r of rows) ids.set(r.pd, links.get(kind, r.pd)!);
  return { created: fresh.length, updated: known.length };
}

/**
 * --new-only: adds the Pipedrive records that are new in the window, unless `match` finds the record
 * they already are here, and leaves every record that's here as it is. A record that's matched is
 * mapped to the one here (so its notes and activities go on it); a new one only fills that one's
 * blanks, as merging duplicates does. Records that aren't new and match nothing are left out.
 */
async function addNew<V extends Record<string, unknown>>(
  db: Database,
  links: Links,
  kind: "organization" | "person",
  rows: { pd: PdId; values: V; createdAt: Date }[],
  actorId: string,
  ids: Map<PdId, string>,
  o: { fresh: (r: { pd: PdId; values: V }) => boolean; match: (r: { pd: PdId; values: V }) => string | null; remember: (id: string, r: { pd: PdId; values: V }) => void },
) {
  const table = kind === "organization" ? schema.organizations : schema.people;
  let created = 0;
  let matched = 0;
  for (const r of rows) {
    const known = links.get(kind, r.pd);
    if (known) {
      ids.set(r.pd, known);
      continue;
    }
    const isNew = o.fresh(r);
    const found = o.match(r);
    if (found) {
      links.add(kind, r.pd, found);
      ids.set(r.pd, found);
      matched++;
      if (isNew) await fillBlanks(db, kind, found, r.values);
      continue;
    }
    if (!isNew) continue;
    const [row] = (await db
      .insert(table)
      .values({ ...r.values, createdBy: actorId, createdAt: r.createdAt, updatedAt: r.createdAt } as never)
      .returning({ id: table.id })) as { id: string }[];
    await links.save(kind, r.pd, row.id);
    await db.insert(schema.events).values({ entityType: kind, entityId: row.id, action: "created", data: { source: SOURCE }, userId: actorId });
    ids.set(r.pd, row.id);
    o.remember(row.id, r);
    created++;
  }
  await links.flush();
  return { created, matched };
}

/** Fills a record's blanks from a Pipedrive record that turned out to be the same one, the way merging duplicates does: nothing that's filled in changes. */
async function fillBlanks(db: Database, kind: "organization" | "person", id: string, values: Record<string, unknown>) {
  if (kind === "organization") {
    const [now] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, id));
    if (!now) return;
    const patch = planOrganizationMerge(now as unknown as OrgFields, [values as Partial<OrgFields>]);
    if (Object.keys(patch).length) await db.update(schema.organizations).set({ ...patch, updatedAt: new Date() }).where(eq(schema.organizations.id, id));
    return;
  }
  const [now] = await db.select().from(schema.people).where(eq(schema.people.id, id));
  if (!now) return;
  const { patch, alsoAt } = planPersonMerge(now as unknown as PersonFields, [values as Partial<PersonFields>]);
  if (Object.keys(patch).length) await db.update(schema.people).set({ ...patch, updatedAt: new Date() }).where(eq(schema.people.id, id));
  if (alsoAt.length) await db.insert(schema.personOrganizations).values(alsoAt.map((organizationId) => ({ personId: id, organizationId }))).onConflictDoNothing();
}

/** The people, organizations and clients here, and where merged-away ones went ("merged" history), for following Pipedrive's ids to them. */
async function localRecords(db: Database) {
  const [people, organizations, clients, merges] = await Promise.all([
    db
      .select({ id: schema.people.id, firstName: schema.people.firstName, lastName: schema.people.lastName, email: schema.people.email, phone: schema.people.phone, otherEmails: schema.people.otherEmails, otherPhones: schema.people.otherPhones, organizationId: schema.people.organizationId, archivedAt: schema.people.archivedAt, createdAt: schema.people.createdAt })
      .from(schema.people),
    db.select({ id: schema.organizations.id, name: schema.organizations.name, archivedAt: schema.organizations.archivedAt, createdAt: schema.organizations.createdAt }).from(schema.organizations),
    db.select({ id: schema.clients.id }).from(schema.clients),
    db.select({ entityType: schema.events.entityType, entityId: schema.events.entityId, data: schema.events.data }).from(schema.events).where(eq(schema.events.action, "merged")),
  ]);
  // Ties go to live records, then the oldest: the one a merge would have kept.
  const order = (a: { archivedAt: Date | null; createdAt: Date }, b: { archivedAt: Date | null; createdAt: Date }) => Number(!!a.archivedAt) - Number(!!b.archivedAt) || a.createdAt.getTime() - b.createdAt.getTime();
  const into = (type: EntityType) => mergedInto(merges.filter((m) => m.entityType === type));
  return {
    person: { ids: new Set(people.map((p) => p.id)), into: into("person") },
    organization: { ids: new Set(organizations.map((o) => o.id)), into: into("organization") },
    client: { ids: new Set(clients.map((c) => c.id)), into: into("client") },
    people: people.sort(order),
    organizations: organizations.sort(order),
    personOrg: new Map(people.flatMap((p) => (p.organizationId ? [[p.id, p.organizationId] as const] : []))),
  };
}

const unplaced = (n: number) => (n > 0 ? `; ${n} left out: nothing here to put them on` : "");

async function insertActivities(db: Database, links: Links, kind: "note" | "activity" | "email", rows: { pd: PdId; values: typeof schema.activities.$inferInsert }[]) {
  for (const batch of chunks(rows, 200)) {
    const created = await db
      .insert(schema.activities)
      .values(batch.map((r) => r.values))
      .returning({ id: schema.activities.id });
    created.forEach((row, i) => links.add(kind, batch[i].pd, row.id));
    await links.flush();
  }
}

async function ensureField(db: Database, links: Links, entity: EntityType, key: string, label: string, type: CustomFieldType, options: string[]) {
  const [found] = await db
    .select()
    .from(schema.customFields)
    .where(and(eq(schema.customFields.entityType, entity), eq(schema.customFields.key, key)));
  if (found) {
    await db.update(schema.customFields).set({ options: [...new Set([...found.options, ...options])] }).where(eq(schema.customFields.id, found.id));
    return;
  }
  const [row] = await db.insert(schema.customFields).values({ entityType: entity, key, label, type, options, position: 999 }).returning({ id: schema.customFields.id });
  await links.save(`field:${entity}`, key, row.id);
  await links.flush();
}

// ─── Plan output ─────────────────────────────────────────────────────────

function printPlan(plans: ClientPlan[], stagePlan: ReturnType<typeof planStages>, lk: Lookup, serviceNames: string[], productDeals: PdDeal[]) {
  log("\nPipedrive pipelines:");
  for (const p of [...lk.pipelines.values()].sort((a, b) => a.order_nr - b.order_nr)) {
    const role = pipelineRole(p);
    log(`  ${p.name} → ${role.kind === "product" ? `product "${role.service}" (current/past clients)` : "sales (prospective clients)"}`);
  }
  log(`\n${plans.length} clients from ${plans.reduce((n, p) => n + p.deals.length, 0)} deals (${plans.filter((p) => p.deals.length > 1).length} with more than one deal):`);
  for (const category of ["prospective", "current", "past"] as const) {
    const inCat = plans.filter((p) => p.category === category);
    const shown = inCat.filter((p) => !p.archivedAt);
    const extra = (n: number) => (n ? ` (+${n} archived)` : "");
    log(`\n  ${category[0].toUpperCase()}${category.slice(1)}: ${shown.length}${extra(inCat.length - shown.length)}`);
    for (const s of stagePlan[category]) {
      const here = inCat.filter((p) => stageName(p.stage) === s.name);
      log(`    ${String(here.filter((p) => !p.archivedAt).length).padStart(5)}  ${s.name}${extra(here.filter((p) => p.archivedAt).length)}`);
    }
  }
  log(`\nServices: ${serviceNames.join(", ")}`);
  for (const name of serviceNames) {
    const ofService = productDeals.filter((d) => {
      const r = pipelineRole(lk.pipelines.get(d.pipeline_id)!);
      return r.kind === "product" && r.service === name;
    });
    const active = ofService.filter((d) => !productEnded(d, lk)).length;
    log(`  ${name}: ${active} active, ${ofService.length - active} ended`);
  }
}

/** What a --since or --new-only run will add, before anything is written. */
function printWindow(o: {
  since: Date | undefined;
  newOnly: boolean;
  orgs: { id: PdId; name: string; add_time: string }[];
  persons: { id: PdId; name: string; add_time: string; first_name: string | null; last_name: string | null; emails?: { value: string }[] | null; phones?: { value: string }[] | null }[];
  deals: PdDeal[];
  notes: { id: PdId; add_time: string }[];
  pdActivities: PdActivity[];
  links: Links;
  orgMatcher: OrganizationMatcher;
  personMatcher: PersonMatcher;
  fresh: (at: string | null | undefined) => boolean;
}) {
  const window = o.since ? `since ${o.since.toISOString().slice(0, 16).replace("T", " ")} UTC` : "at any time";
  log(`\nNew in Pipedrive ${window}, not brought in yet${o.newOnly ? " (records already here are left as they are)" : ""}:`);
  const newOrgs = o.orgs.filter((r) => !o.links.get("organization", r.id) && o.fresh(r.add_time));
  const newPeople = o.persons.filter((r) => !o.links.get("person", r.id) && o.fresh(r.add_time));
  if (o.newOnly) {
    const orgMatches = newOrgs.filter((r) => o.orgMatcher.find(r.name));
    const personMatches = newPeople.filter((p) => {
      const [first, ...rest] = (p.name ?? "").trim().split(/\s+/);
      const emails = (p.emails ?? []).map((e) => e.value).filter(Boolean);
      const phones = (p.phones ?? []).map((e) => e.value).filter(Boolean);
      return o.personMatcher.find({ firstName: p.first_name || first || "", lastName: p.last_name || rest.join(" ") || null, email: emails[0] ?? null, phone: phones[0] ?? null, otherEmails: emails, otherPhones: phones });
    });
    log(`  ${newOrgs.length} organizations: ${newOrgs.length - orgMatches.length} to add, ${orgMatches.length} already here by name (their blanks are filled)`);
    for (const r of orgMatches.slice(0, 20)) log(`      ${r.name}`);
    log(`  ${newPeople.length} people: ${newPeople.length - personMatches.length} to add, ${personMatches.length} already here by email or phone (their blanks are filled)`);
    for (const r of personMatches.slice(0, 20)) log(`      ${r.name}`);
  } else {
    log(`  ${newOrgs.length} organizations, ${newPeople.length} people`);
  }
  const newDeals = o.deals.filter((d) => !o.links.get("deal", d.id) && o.fresh(d.add_time) && d.status !== "deleted" && !d.is_deleted);
  log(`  ${newDeals.length} deals`);
  for (const d of newDeals.slice(0, 30)) log(`      "${d.title}" (${d.status})`);
  log(`  ${o.notes.filter((n) => !o.links.get("note", n.id) && o.fresh(n.add_time)).length} notes`);
  const acts = o.pdActivities.filter((a) => !o.links.get("activity", a.id) && o.fresh(a.add_time));
  const byType = Object.entries(Object.groupBy(acts, (a) => a.type)).map(([t, list]) => `${list!.length} ${t}`);
  log(`  ${acts.length} activities${byType.length ? ` (${byType.join(", ")})` : ""}`);
}

// ─── Reset ───────────────────────────────────────────────────────────────

/** Removes everything a Pipedrive import added. Records people created by hand since are left alone. */
async function reset(db: Database) {
  const rows = await db.select().from(schema.externalIds).where(eq(schema.externalIds.source, SOURCE));
  const of = (...kinds: string[]) => [...new Set(rows.filter((r) => kinds.includes(r.kind) || kinds.some((k) => k.endsWith("*") && r.kind.startsWith(k.slice(0, -1)))).map((r) => r.localId))];
  const del = async (ids: string[], fn: (batch: string[]) => Promise<unknown>) => {
    for (const batch of chunks(ids, 500)) await fn(batch);
  };
  if (!flag("yes")) {
    log(`This removes ${of("client").length} clients, ${of("person").length} people, ${of("organization").length} organizations and ${of("note", "activity", "email").length} notes, activities and emails brought in from Pipedrive. Run again with --reset --yes to go ahead.`);
    return;
  }
  const records = [...of("client"), ...of("person"), ...of("organization")];
  await del(of("note", "activity", "email"), (b) => db.delete(schema.activities).where(inArray(schema.activities.id, b)));
  await del(records, (b) => db.delete(schema.events).where(inArray(schema.events.entityId, b)));
  await del(of("client"), (b) => db.delete(schema.clients).where(inArray(schema.clients.id, b)));
  await del(of("person"), (b) => db.delete(schema.people).where(inArray(schema.people.id, b)));
  await del(of("organization"), (b) => db.delete(schema.organizations).where(inArray(schema.organizations.id, b)));
  await del(of("field:*"), (b) => db.delete(schema.customFields).where(inArray(schema.customFields.id, b)));
  // Stages, services and teammates only when nothing else uses them.
  for (const id of of("stage")) {
    const [used] = await db.select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.stageId, id)).limit(1);
    if (!used) await db.delete(schema.stages).where(eq(schema.stages.id, id));
  }
  for (const id of of("service")) {
    const [used] = await db.select({ id: schema.clientServices.id }).from(schema.clientServices).where(eq(schema.clientServices.serviceId, id)).limit(1);
    if (!used) await db.delete(schema.services).where(eq(schema.services.id, id));
  }
  for (const id of of("user")) {
    await db
      .delete(schema.users)
      .where(and(eq(schema.users.id, id), isNull(schema.users.passwordHash)))
      .catch(() => {});
  }
  await db.delete(schema.externalIds).where(eq(schema.externalIds.source, SOURCE));
  log(`Removed ${records.length} records and their history. Teammates who signed in since are kept.`);
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

