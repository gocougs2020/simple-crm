"use server";

import { refresh } from "next/cache";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import type { CustomValues, UserPrefs } from "@/db/schema";
import { run, type Result } from "@/lib/action";
import { ActionError, actionUser } from "@/lib/auth";
import type { EntityType } from "@/lib/constants";
import { cleanCustomValues, customLabels } from "@/lib/crm/custom-fields";
import { diff, labelRelations, recordEvent } from "@/lib/crm/events";
import { globalSearch, lookup } from "@/lib/crm/records";
import { rankBetween } from "@/lib/rank";

const { people, organizations, deals, stages } = schema;

const id = z.uuid();
const optionalId = z.uuid().nullable().optional();
const name = (label: string, max = 120) => z.string().trim().min(1, `Enter ${label}.`).max(max);
const optionalText = (max = 200) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => v || null);
const optionalEmail = z
  .string()
  .trim()
  .toLowerCase()
  .max(200)
  .nullable()
  .optional()
  .transform((v) => v || null)
  .refine((v) => !v || z.email().safeParse(v).success, "Enter a valid email address.");

/** Fields whose changes show up in a record's history, with the words the timeline uses. */
const personLabels = { firstName: "First name", lastName: "Last name", email: "Email", phone: "Phone", title: "Job title", organizationId: "Organization", ownerId: "Owner", tags: "Tags", marketingOptIn: "Email opt-in" } as const;
const orgLabels = { name: "Name", domain: "Website", phone: "Phone", address: "Address", industry: "Industry", ownerId: "Owner" } as const;
const dealLabels = { title: "Title", value: "Value", expectedCloseDate: "Expected close", personId: "Person", organizationId: "Organization", ownerId: "Owner" } as const;

async function withCustomChanges(entity: EntityType, before: CustomValues, after: CustomValues | undefined) {
  if (!after) return [];
  const labels = await customLabels(entity);
  return diff(before, after, labels).map((c) => ({ ...c, field: `custom.${c.field}` }));
}

// ─── People ──────────────────────────────────────────────────────────────

const personInput = z.object({
  firstName: name("a first name", 80),
  lastName: optionalText(80),
  email: optionalEmail,
  phone: optionalText(40),
  title: optionalText(120),
  organizationId: optionalId,
  ownerId: optionalId,
  tags: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(30).optional(),
  marketingOptIn: z.boolean().optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
});

export async function createPerson(input: z.input<typeof personInput> & { newOrganizationName?: string }): Promise<Result<{ id: string }>> {
  return run(async () => {
    const user = await actionUser();
    const data = personInput.parse(input);
    const db = await getDb();
    let organizationId = data.organizationId ?? null;
    // "Add 'Acme' as a new organization" from the picker creates both in one step.
    if (!organizationId && input.newOrganizationName?.trim()) organizationId = (await insertOrganization({ name: input.newOrganizationName.trim() }, user.id)).id;
    if (data.email) {
      const [dupe] = await db.select({ id: people.id }).from(people).where(and(eq(people.email, data.email), isNull(people.archivedAt))).limit(1);
      if (dupe) throw new ActionError(`Someone with ${data.email} already exists. Open them from search instead.`);
    }
    const [row] = await db
      .insert(people)
      .values({ ...data, organizationId, ownerId: data.ownerId === undefined ? user.id : data.ownerId, tags: data.tags ?? [], custom: data.custom ? await cleanCustomValues("person", data.custom) : {}, createdBy: user.id })
      .returning({ id: people.id });
    await recordEvent({ entityType: "person", entityId: row.id, action: "created", userId: user.id });
    refresh();
    return row;
  });
}

export async function updatePerson(personId: string, patch: Partial<z.input<typeof personInput>>): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const data = personInput.partial().parse(patch);
    const db = await getDb();
    const [before] = await db.select().from(people).where(eq(people.id, id.parse(personId)));
    if (!before) throw new ActionError("This person was deleted.");
    if (data.email && data.email !== before.email) {
      const [dupe] = await db.select({ id: people.id }).from(people).where(and(eq(people.email, data.email), isNull(people.archivedAt))).limit(1);
      if (dupe) throw new ActionError(`Someone else already has ${data.email}.`);
    }
    const custom = data.custom ? { ...before.custom, ...(await cleanCustomValues("person", data.custom)) } : undefined;
    const set = { ...data, custom, updatedAt: new Date() };
    await db.update(people).set(set).where(eq(people.id, before.id));
    const changes = [...(await labelRelations(diff(before, { ...data, custom: undefined }, personLabels))), ...(await withCustomChanges("person", before.custom, custom))];
    if (changes.length) await recordEvent({ entityType: "person", entityId: before.id, action: "updated", data: { changes }, userId: user.id });
    refresh();
  });
}

// ─── Organizations ───────────────────────────────────────────────────────

const orgInput = z.object({
  name: name("a name"),
  domain: optionalText(200).transform((v) => (v ? v.replace(/^https?:\/\//i, "").replace(/\/$/, "").toLowerCase() : null)),
  phone: optionalText(40),
  address: optionalText(300),
  industry: optionalText(80),
  ownerId: optionalId,
  custom: z.record(z.string(), z.unknown()).optional(),
});

async function insertOrganization(input: z.input<typeof orgInput>, userId: string) {
  const data = orgInput.parse(input);
  const db = await getDb();
  const [row] = await db
    .insert(organizations)
    .values({ ...data, ownerId: data.ownerId === undefined ? userId : data.ownerId, custom: data.custom ? await cleanCustomValues("organization", data.custom) : {}, createdBy: userId })
    .returning({ id: organizations.id, name: organizations.name });
  await recordEvent({ entityType: "organization", entityId: row.id, action: "created", userId });
  return row;
}

export async function createOrganization(input: z.input<typeof orgInput>): Promise<Result<{ id: string; name: string }>> {
  return run(async () => {
    const user = await actionUser();
    const db = await getDb();
    const [dupe] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(sql`lower(${organizations.name}) = lower(${String(input.name ?? "").trim()})`, isNull(organizations.archivedAt)))
      .limit(1);
    if (dupe) throw new ActionError(`${String(input.name).trim()} already exists. Open it from search instead.`);
    const row = await insertOrganization(input, user.id);
    refresh();
    return row;
  });
}

export async function updateOrganization(orgId: string, patch: Partial<z.input<typeof orgInput>>): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const data = orgInput.partial().parse(patch);
    const db = await getDb();
    const [before] = await db.select().from(organizations).where(eq(organizations.id, id.parse(orgId)));
    if (!before) throw new ActionError("This organization was deleted.");
    const custom = data.custom ? { ...before.custom, ...(await cleanCustomValues("organization", data.custom)) } : undefined;
    await db.update(organizations).set({ ...data, custom, updatedAt: new Date() }).where(eq(organizations.id, before.id));
    const changes = [...diff(before, { ...data, custom: undefined }, orgLabels), ...(await withCustomChanges("organization", before.custom, custom))];
    if (changes.length) await recordEvent({ entityType: "organization", entityId: before.id, action: "updated", data: { changes }, userId: user.id });
    refresh();
  });
}

// ─── Deals ───────────────────────────────────────────────────────────────

const dealInput = z.object({
  title: name("a title", 160),
  value: z.number().int().min(0).max(1e15).optional(),
  stageId: id,
  personId: optionalId,
  organizationId: optionalId,
  ownerId: optionalId,
  expectedCloseDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional()
    .transform((v) => v || null),
  custom: z.record(z.string(), z.unknown()).optional(),
});

export async function createDeal(input: z.input<typeof dealInput> & { newOrganizationName?: string; newPersonName?: string }): Promise<Result<{ id: string }>> {
  return run(async () => {
    const user = await actionUser();
    const data = dealInput.parse(input);
    const db = await getDb();
    const [stage] = await db.select().from(stages).where(eq(stages.id, data.stageId));
    if (!stage) throw new ActionError("That stage no longer exists. Reload and pick another.");

    let organizationId = data.organizationId ?? null;
    if (!organizationId && input.newOrganizationName?.trim()) organizationId = (await insertOrganization({ name: input.newOrganizationName.trim() }, user.id)).id;
    let personId = data.personId ?? null;
    if (!personId && input.newPersonName?.trim()) {
      const [first, ...rest] = input.newPersonName.trim().split(/\s+/);
      const [p] = await db.insert(people).values({ firstName: first, lastName: rest.join(" ") || null, organizationId, ownerId: user.id, createdBy: user.id }).returning({ id: people.id });
      await recordEvent({ entityType: "person", entityId: p.id, action: "created", userId: user.id });
      personId = p.id;
    }
    // A deal for a person who works somewhere is that organization's deal too.
    if (personId && !organizationId) {
      const [p] = await db.select({ organizationId: people.organizationId }).from(people).where(eq(people.id, personId));
      organizationId = p?.organizationId ?? null;
    }
    // New deals go to the top of their column.
    const [top] = await db.select({ rank: deals.rank }).from(deals).where(and(eq(deals.stageId, stage.id), eq(deals.status, "open"))).orderBy(asc(deals.rank)).limit(1);
    const [ws] = await db.select({ currency: schema.workspace.currency }).from(schema.workspace).limit(1);
    const [row] = await db
      .insert(deals)
      .values({
        title: data.title,
        value: data.value ?? 0,
        currency: ws?.currency ?? "USD",
        pipelineId: stage.pipelineId,
        stageId: stage.id,
        personId,
        organizationId,
        ownerId: data.ownerId === undefined ? user.id : data.ownerId,
        expectedCloseDate: data.expectedCloseDate,
        rank: rankBetween(null, top?.rank),
        custom: data.custom ? await cleanCustomValues("deal", data.custom) : {},
        createdBy: user.id,
      })
      .returning({ id: deals.id });
    await recordEvent({ entityType: "deal", entityId: row.id, action: "created", data: { stage: stage.name }, userId: user.id });
    refresh();
    return row;
  });
}

export async function updateDeal(dealId: string, patch: Partial<Omit<z.input<typeof dealInput>, "stageId">>): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const data = dealInput.omit({ stageId: true }).partial().parse(patch);
    const db = await getDb();
    const [before] = await db.select().from(deals).where(eq(deals.id, id.parse(dealId)));
    if (!before) throw new ActionError("This deal was deleted.");
    const custom = data.custom ? { ...before.custom, ...(await cleanCustomValues("deal", data.custom)) } : undefined;
    await db.update(deals).set({ ...data, custom, updatedAt: new Date() }).where(eq(deals.id, before.id));
    const changes = [...(await labelRelations(diff(before, { ...data, custom: undefined }, dealLabels))), ...(await withCustomChanges("deal", before.custom, custom))];
    if (changes.length) await recordEvent({ entityType: "deal", entityId: before.id, action: "updated", data: { changes }, userId: user.id });
    refresh();
  });
}

/**
 * Moves a deal to a stage (and a spot in its column). `beforeId`/`afterId` are
 * the cards it lands between; only this deal is written.
 */
export async function moveDeal(dealId: string, stageId: string, place?: { beforeId?: string | null; afterId?: string | null }): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const db = await getDb();
    const [deal] = await db.select().from(deals).where(eq(deals.id, id.parse(dealId)));
    const [stage] = await db.select().from(stages).where(eq(stages.id, id.parse(stageId)));
    if (!deal || !stage) throw new ActionError("This deal or stage no longer exists. Reload the board.");
    const ids = [place?.beforeId, place?.afterId].filter((x): x is string => !!x);
    const neighbours = ids.length ? await db.select({ id: deals.id, rank: deals.rank }).from(deals).where(inArray(deals.id, ids)) : [];
    const rankOf = (x?: string | null) => neighbours.find((n) => n.id === x)?.rank ?? null;
    let rank: string;
    if (place) {
      rank = rankBetween(rankOf(place.beforeId), rankOf(place.afterId));
    } else {
      // Moved from a menu or the stage bar: top of the new column.
      const [top] = await db.select({ rank: deals.rank }).from(deals).where(and(eq(deals.stageId, stage.id), eq(deals.status, "open"))).orderBy(asc(deals.rank)).limit(1);
      rank = rankBetween(null, top?.rank);
    }
    const changedStage = stage.id !== deal.stageId;
    await db
      .update(deals)
      .set({ stageId: stage.id, pipelineId: stage.pipelineId, rank, updatedAt: new Date(), ...(changedStage ? { stageChangedAt: new Date() } : {}) })
      .where(eq(deals.id, deal.id));
    if (changedStage) {
      const [from] = await db.select({ name: stages.name }).from(stages).where(eq(stages.id, deal.stageId));
      await recordEvent({ entityType: "deal", entityId: deal.id, action: "stage_changed", data: { from: from?.name ?? null, to: stage.name }, userId: user.id });
    }
    refresh();
  });
}

const statusInput = z.discriminatedUnion("status", [
  z.object({ status: z.literal("won") }),
  z.object({ status: z.literal("lost"), reason: z.string().trim().max(300).optional() }),
  z.object({ status: z.literal("open") }),
]);

/** Won, lost (with a reason), or reopened. Closed deals leave the board but keep their stage for reporting. */
export async function setDealStatus(dealId: string, input: z.input<typeof statusInput>): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const data = statusInput.parse(input);
    const db = await getDb();
    const [deal] = await db.select().from(deals).where(eq(deals.id, id.parse(dealId)));
    if (!deal) throw new ActionError("This deal was deleted.");
    if (deal.status === data.status) return;
    const reason = data.status === "lost" ? data.reason || null : null;
    await db
      .update(deals)
      .set({ status: data.status, lostReason: reason, closedAt: data.status === "open" ? null : new Date(), updatedAt: new Date() })
      .where(eq(deals.id, deal.id));
    await recordEvent({
      entityType: "deal",
      entityId: deal.id,
      action: data.status === "open" ? "reopened" : data.status,
      data: reason ? { reason } : {},
      userId: user.id,
    });
    refresh();
  });
}

// ─── Archive (soft delete) ───────────────────────────────────────────────

const archiveTables = { person: people, organization: organizations, deal: deals } as const;

/** Archived records disappear from lists and search but keep their history. Undo restores them. */
export async function setArchived(entity: EntityType, ids: string[], archived: boolean): Promise<Result<{ count: number }>> {
  return run(async () => {
    const user = await actionUser();
    const list = z.array(id).min(1).max(500).parse(ids);
    const table = archiveTables[entity];
    const db = await getDb();
    const rows = await db
      .update(table)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(inArray(table.id, list))
      .returning({ id: table.id });
    for (const r of rows) await recordEvent({ entityType: entity, entityId: r.id, action: archived ? "archived" : "restored", userId: user.id });
    refresh();
    return { count: rows.length };
  });
}

/** Bulk owner change from a table selection. */
export async function assignOwner(entity: EntityType, ids: string[], ownerId: string | null): Promise<Result<{ count: number }>> {
  return run(async () => {
    const user = await actionUser();
    const list = z.array(id).min(1).max(500).parse(ids);
    const owner = optionalId.parse(ownerId) ?? null;
    const table = archiveTables[entity];
    const db = await getDb();
    const before = await db.select({ id: table.id, ownerId: table.ownerId }).from(table).where(inArray(table.id, list));
    await db.update(table).set({ ownerId: owner, updatedAt: new Date() }).where(inArray(table.id, list));
    for (const b of before)
      if (b.ownerId !== owner) await recordEvent({ entityType: entity, entityId: b.id, action: "updated", data: { changes: [{ field: "ownerId", label: "Owner", from: b.ownerId, to: owner }] }, userId: user.id });
    refresh();
    return { count: before.length };
  });
}

export async function addTag(personIds: string[], tag: string): Promise<Result<{ count: number }>> {
  return run(async () => {
    await actionUser();
    const list = z.array(id).min(1).max(500).parse(personIds);
    const t = z.string().trim().toLowerCase().min(1, "Enter a tag.").max(40).parse(tag);
    const db = await getDb();
    const rows = await db
      .update(people)
      .set({ tags: sql`(select coalesce(jsonb_agg(distinct x), '[]'::jsonb) from jsonb_array_elements_text(${people.tags} || ${JSON.stringify([t])}::jsonb) x)` })
      .where(inArray(people.id, list))
      .returning({ id: people.id });
    refresh();
    return { count: rows.length };
  });
}

// ─── Lookups and preferences ─────────────────────────────────────────────

export async function lookupRecords(kind: "person" | "organization" | "deal", q: string) {
  await actionUser();
  return lookup(kind, z.string().max(100).parse(q));
}

export async function searchEverything(q: string) {
  await actionUser();
  return globalSearch(z.string().max(100).parse(q));
}

const prefsSchema = z.object({
  dealsView: z.enum(["board", "table"]).optional(),
  pipelineId: z.uuid().optional(),
  peopleSort: z.string().max(40).optional(),
  organizationsSort: z.string().max(40).optional(),
  dealsSort: z.string().max(40).optional(),
  timelineFilter: z.string().max(40).optional(),
});

/** Remembers a view choice for this teammate, on every device. */
export async function savePrefs(patch: UserPrefs): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const data = prefsSchema.parse(patch);
    const db = await getDb();
    await db
      .update(schema.users)
      .set({ prefs: { ...user.prefs, ...data } })
      .where(eq(schema.users.id, user.id));
  });
}
