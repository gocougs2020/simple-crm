"use server";

import { refresh } from "next/cache";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import type { UserPrefs } from "@/db/schema";
import { run, type Result } from "@/lib/action";
import { ActionError, actionUser } from "@/lib/auth";
import { clientCategories, type EntityType } from "@/lib/constants";
import { cleanCustomValues } from "@/lib/crm/custom-fields";
import { diff, labelRelations, recordEvent } from "@/lib/crm/events";
import { id, insertOrganization, name, optionalEmail, optionalId, optionalText, orgInput, tagList, withCustomChanges } from "@/lib/crm/inputs";
import { globalSearch, lookup } from "@/lib/crm/records";

const { people, organizations, clients } = schema;

/** Fields whose changes show up in a record's history, with the words the timeline uses. */
const personLabels = { firstName: "First name", lastName: "Last name", email: "Email", phone: "Phone", title: "Job title", organizationId: "Organization", ownerId: "Owner", tags: "Tags", marketingOptIn: "Email opt-in" } as const;
const orgLabels = { name: "Name", domain: "Website", phone: "Phone", address: "Address", industry: "Industry", ownerId: "Owner" } as const;

// ─── People ──────────────────────────────────────────────────────────────

const personInput = z.object({
  firstName: name("a first name", 80),
  lastName: optionalText(80),
  email: optionalEmail,
  phone: optionalText(40),
  title: optionalText(120),
  organizationId: optionalId,
  ownerId: optionalId,
  tags: tagList.optional(),
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

// ─── Archive (soft delete) ───────────────────────────────────────────────

const archiveTables = { person: people, organization: organizations, client: clients } as const;

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

export async function lookupRecords(kind: "person" | "organization" | "client", q: string) {
  await actionUser();
  return lookup(kind, z.string().max(100).parse(q));
}

export async function searchEverything(q: string) {
  await actionUser();
  return globalSearch(z.string().max(100).parse(q));
}

const prefsSchema = z.object({
  clientsView: z.enum(["board", "table"]).optional(),
  clientPipelines: z.partialRecord(z.enum(clientCategories), z.uuid()).optional(),
  peopleSort: z.string().max(40).optional(),
  organizationsSort: z.string().max(40).optional(),
  clientsSort: z.string().max(40).optional(),
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
      .set({ prefs: { ...user.prefs, ...data, ...(data.clientPipelines ? { clientPipelines: { ...user.prefs.clientPipelines, ...data.clientPipelines } } : {}) } })
      .where(eq(schema.users.id, user.id));
  });
}
