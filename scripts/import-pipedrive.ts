/**
 * Imports a Pipedrive account: users, organizations, people, deals (collapsed
 * into one client per organization), product deals as services, notes,
 * activities and email. See docs/PIPEDRIVE-IMPORT.md.
 *
 *   pnpm import:pipedrive --dry-run     show what would happen, write nothing
 *   pnpm import:pipedrive               import (safe to run again: it updates)
 *   pnpm import:pipedrive --no-email    skip email (much faster)
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
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  mkdirSync(".data", { recursive: true });
  const client = new PGlite(".data/pglite");
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
const clip = (s: string | null | undefined, n: number) => (s ? s.trim().slice(0, n) || null : null);

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
  const withEmail = !flag("no-email");
  const api = new PipedriveApi(token, process.env.PIPEDRIVE_COMPANY_DOMAIN);

  // Who the import is recorded as.
  const asEmail = option("as")?.toLowerCase();
  const team = await db.select().from(schema.users);
  const actor = asEmail ? team.find((u) => u.email.toLowerCase() === asEmail) : team.find((u) => u.role === "owner" && !u.deactivatedAt);
  if (!actor) throw new Error(asEmail ? `No teammate with the email ${asEmail}.` : "Create the owner account first (open the app and sign up), then run the import.");

  log("Reading Pipedrive…");
  const [pdUsers, pipelines, stages, activityTypes, dealFields, personFields, orgFields] = await Promise.all([
    api.allV1<PdUser>("/v1/users"),
    api.pipelines(),
    api.stages(),
    api.activityTypes(),
    api.fields("deal"),
    api.fields("person"),
    api.fields("organization"),
  ]);
  const orgs = await api.organizations();
  log(`  ${orgs.length} organizations`);
  const persons = await api.persons();
  log(`  ${persons.length} people`);
  const deals = await api.deals();
  log(`  ${deals.length} deals`);
  const notes = (await api.notes()).filter((n) => n.active_flag !== false);
  log(`  ${notes.length} notes`);
  const pdActivities = (await api.activities()).filter((a) => !a.is_deleted);
  log(`  ${pdActivities.length} activities`);

  const lk: Lookup = { pipelines: new Map(pipelines.map((p) => [p.id, p])), stages: new Map(stages.map((s) => [s.id, s])) };
  const plans = planClients(deals, lk);
  const stagePlan = planStages(plans, lk);
  const productDeals = deals.filter((d) => lk.pipelines.has(d.pipeline_id) && pipelineRole(lk.pipelines.get(d.pipeline_id)!).kind === "product" && d.status !== "deleted" && !d.is_deleted);
  const serviceNames = [...new Set(pipelines.map(pipelineRole).flatMap((r) => (r.kind === "product" ? [r.service] : [])))];

  printPlan(plans, stagePlan, lk, serviceNames, productDeals);
  if (dryRun) {
    log("\nDry run: nothing was written. Run again without --dry-run to import.");
    return;
  }

  const links = new Links(db);
  await links.load();
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
    links.add("user", u.id, row.id);
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
      links.add(`field:${entity}`, f.key, row.id);
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
  const orgCounts = await upsert(db, links, "organization", schema.organizations, orgRows, actor.id, orgIds);
  log(`Organizations: ${orgCounts.created} added, ${orgCounts.updated} updated`);

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
  const personCounts = await upsert(db, links, "person", schema.people, personRows, actor.id, personIds);
  log(`People: ${personCounts.created} added, ${personCounts.updated} updated`);

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
    const wanted = stagePlan[category];
    const ordered: string[] = [];
    for (const s of wanted) {
      let row = existing.find((e) => e.name === s.name);
      if (!row) {
        [row] = await db.insert(schema.stages).values({ pipelineId: pipeline.id, name: s.name, probability: s.probability, rottingDays: null }).returning();
        links.add("stage", `${category}:${s.name}`, row.id);
      }
      stageIds.set(`${category}:${s.name}`, row.id);
      ordered.push(row.id);
    }
    // Pipedrive's stages first, in Pipedrive's order; anything else keeps its order after them.
    const rest = existing.filter((e) => !ordered.includes(e.id)).map((e) => e.id);
    await Promise.all([...ordered, ...rest].map((id, position) => db.update(schema.stages).set({ position }).where(eq(schema.stages.id, id))));
  }
  await links.flush();

  // ── Services: one per product pipeline.
  const serviceIds = new Map<string, string>();
  const services = await db.select().from(schema.services);
  for (const [i, name] of serviceNames.entries()) {
    let row = services.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!row) {
      [row] = await db.insert(schema.services).values({ name, interval: "month", position: services.length + i }).returning();
      links.add("service", name, row.id);
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
  // Oldest first, so ranks put long-standing clients at the top of each column.
  for (const plan of [...plans].sort((a, b) => Date.parse(a.lead.add_time) - Date.parse(b.lead.add_time))) {
    const values = clientValues(plan, lk, { orgName, personName, orgIds, personIds, user, customValues, tagValues, stageIds, pipelineIds });
    const id = links.get("client", plan.key);
    const current = id ? existingClients.get(id) : undefined;
    if (current) {
      const moved = current.stageId !== values.stageId;
      await db
        .update(schema.clients)
        .set({ ...values, ...(moved ? { rank: nextRank(values.stageId) } : {}), updatedAt: now })
        .where(eq(schema.clients.id, current.id));
      if (current.category !== values.category) await db.insert(schema.events).values({ entityType: "client", entityId: current.id, action: "category_changed", data: { from: current.category, to: values.category, stage: stageName(plan.stage), source: SOURCE }, userId: actor.id });
      else if (moved) await db.insert(schema.events).values({ entityType: "client", entityId: current.id, action: "stage_changed", data: { from: stageNames.get(current.stageId) ?? null, to: stageName(plan.stage), source: SOURCE }, userId: actor.id });
      clientIds.set(plan.key, current.id);
      clientsUpdated++;
    } else {
      const createdAt = new Date(Math.min(...plan.deals.map((d) => time(d.add_time)?.getTime() ?? now.getTime())));
      const [row] = await db
        .insert(schema.clients)
        .values({ ...values, rank: nextRank(values.stageId), createdBy: actor.id, createdAt })
        .returning({ id: schema.clients.id });
      links.add("client", plan.key, row.id);
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
    for (const d of plan.deals) {
      dealClient.set(d.id, clientIds.get(plan.key)!);
      links.add("deal", d.id, clientIds.get(plan.key)!);
    }
  }
  await links.flush();
  log(`Clients: ${clientsCreated} added, ${clientsUpdated} updated (from ${plans.reduce((n, p) => n + p.deals.length, 0)} deals)`);

  // ── Services each client uses or used: one per product deal.
  const startField = dealFields.find((f) => isCustomField(f) && f.field_type === "date" && /start/i.test(f.name));
  const endField = dealFields.find((f) => isCustomField(f) && f.field_type === "date" && /end/i.test(f.name));
  const noteFields = dealFields.filter((f) => isCustomField(f) && /product|plan|level/i.test(f.name));
  let servicesAdded = 0;
  for (const d of productDeals) {
    const clientId = dealClient.get(d.id);
    const role = pipelineRole(lk.pipelines.get(d.pipeline_id)!);
    if (!clientId || role.kind !== "product") continue;
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
      // Pipedrive's MRR when it's filled in, else the deal value (taken as monthly).
      price: cents(d.mrr ?? d.value),
      interval: "month" as const,
      startedOn: day(startField ? String(d.custom_fields?.[startField.key] ?? "") : null) ?? day(d.first_won_time) ?? day(d.won_time) ?? day(d.add_time),
      endedOn: ended ? (day(endField ? String(d.custom_fields?.[endField.key] ?? "") : null) ?? day(d.lost_time) ?? day(d.close_time) ?? day(d.stage_change_time) ?? day(d.update_time)) : null,
      note: clip(`${d.title}${note ? ` · ${note}` : ""}`, 500),
    };
    const id = links.get("client_service", d.id);
    if (id) await db.update(schema.clientServices).set(values).where(eq(schema.clientServices.id, id));
    else {
      const [row] = await db.insert(schema.clientServices).values(values).returning({ id: schema.clientServices.id });
      links.add("client_service", d.id, row.id);
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
  const linksFor = (dealId: PdId | null | undefined, orgId: PdId | null | undefined, personId: PdId | null | undefined) => {
    const org = orgId ?? (personId ? personOrg.get(personId) : null) ?? (dealId ? dealOrg.get(dealId) : null) ?? null;
    return { personId: personId ? (personIds.get(personId) ?? null) : null, organizationId: org ? (orgIds.get(org) ?? null) : null, clientId: clientFor(dealId, org, personId) };
  };

  const noteRows = notes
    .filter((n) => !links.get("note", n.id))
    .map((n) => {
      const at = time(n.add_time) ?? now;
      return { pd: n.id, values: { type: "note" as const, body: cleanHtml(n.content), occurredAt: at, createdAt: at, updatedAt: at, pinned: !!(n.pinned_to_deal_flag || n.pinned_to_person_flag || n.pinned_to_organization_flag), userId: user(n.user_id), assigneeId: user(n.user_id), ...linksFor(n.deal_id, n.org_id, n.person_id) } };
    })
    .filter((r) => r.values.body && (r.values.personId || r.values.organizationId || r.values.clientId));
  await insertActivities(db, links, "note", noteRows);
  log(`Notes: ${noteRows.length} added`);

  const typeNames = new Map(activityTypes.map((t) => [t.key_string, t.name]));
  const activityRows = pdActivities
    .filter((a) => !links.get("activity", a.id))
    .map((a) => ({ pd: a.id, values: { ...activityValues(a, typeNames, user, now), ...linksFor(a.deal_id, a.org_id, a.person_id) } }))
    .filter((r) => r.values.personId || r.values.organizationId || r.values.clientId);
  await insertActivities(db, links, "activity", activityRows);
  log(`Activities: ${activityRows.length} added`);

  if (withEmail) {
    const withMail = persons.filter((p) => (p.email_messages_count ?? 1) > 0 && personIds.has(p.id));
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
        .filter((m) => !m.draft_flag && !m.deleted_flag && !seen.has(m.id) && !links.get("email", m.id))
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

function activityValues(a: PdActivity, typeNames: Map<string, string>, user: (id: PdId | null | undefined) => string | null, now: Date) {
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
    outcome: clip(a.outcome, 80),
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
    await db.insert(schema.events).values(created.map((row) => ({ entityType: kind, entityId: row.id, action: "created", data: { source: SOURCE }, userId: actorId })));
  }
  await mapLimit(known, 8, (r) =>
    db
      .update(table)
      .set({ ...r.values, updatedAt: new Date() } as never)
      .where(eq(table.id, links.get(kind, r.pd)!)),
  );
  await links.flush();
  for (const r of rows) ids.set(r.pd, links.get(kind, r.pd)!);
  return { created: fresh.length, updated: known.length };
}

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
  links.add(`field:${entity}`, key, row.id);
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
    log(`\n  ${category[0].toUpperCase()}${category.slice(1)}: ${inCat.length}`);
    for (const s of stagePlan[category]) log(`    ${String(inCat.filter((p) => stageName(p.stage) === s.name).length).padStart(5)}  ${s.name}`);
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

