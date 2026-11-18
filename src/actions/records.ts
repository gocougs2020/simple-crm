"use server";

import { refresh } from "next/cache";
import { eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import type { UserPrefs } from "@/db/schema";
import { run, type Result } from "@/lib/action";
import { actionCan, actionEditor, actionUser } from "@/lib/auth";
import { clientCategories, type EntityType } from "@/lib/constants";
import { sessionActor } from "@/lib/crm/actor";
import { recordEvent } from "@/lib/crm/events";
import { id, optionalId, type orgInput, type personInput } from "@/lib/crm/schemas";
import { globalSearch, listOrganizations, listPeople, lookup, pageSize } from "@/lib/crm/records";
import * as svc from "@/lib/crm/service/records";
import * as merging from "@/lib/crm/service/merge";

const { people, organizations, clients } = schema;

// ─── People ──────────────────────────────────────────────────────────────

export async function createPerson(input: z.input<typeof personInput> & { newOrganizationName?: string }): Promise<Result<{ id: string }>> {
  return run(async () => {
    const row = await svc.createPerson(sessionActor(await actionUser()), input);
    refresh();
    return row;
  });
}

export async function updatePerson(personId: string, patch: Partial<z.input<typeof personInput>>): Promise<Result> {
  return run(async () => {
    await svc.updatePerson(sessionActor(await actionUser()), personId, patch);
    refresh();
  });
}

// ─── Organizations ───────────────────────────────────────────────────────

export async function createOrganization(input: z.input<typeof orgInput>): Promise<Result<{ id: string; name: string }>> {
  return run(async () => {
    const row = await svc.createOrganization(sessionActor(await actionUser()), input);
    refresh();
    return row;
  });
}

export async function updateOrganization(orgId: string, patch: Partial<z.input<typeof orgInput>>): Promise<Result> {
  return run(async () => {
    await svc.updateOrganization(sessionActor(await actionUser()), orgId, patch);
    refresh();
  });
}

// ─── Archive (soft delete) ───────────────────────────────────────────────

const tables = { person: people, organization: organizations, client: clients } as const;

/** Archived records disappear from lists and search but keep their history. Undo restores them. */
export async function setArchived(entity: EntityType, ids: string[], archived: boolean): Promise<Result<{ count: number }>> {
  return run(async () => {
    const { count } = await svc.setArchived(sessionActor(await actionUser()), entity, ids, archived);
    refresh();
    return { count };
  });
}

/** Bulk owner change from a table selection. */
export async function assignOwner(entity: EntityType, ids: string[], ownerId: string | null): Promise<Result<{ count: number }>> {
  return run(async () => {
    const user = await actionEditor();
    const list = z.array(id).min(1).max(500).parse(ids);
    const owner = optionalId.parse(ownerId) ?? null;
    const table = tables[entity];
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
    await actionCan("records:write");
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

// ─── Merge ───────────────────────────────────────────────────────────────

/** Merges the picked people or organizations into the one chosen to keep. */
export async function mergeRecords(entity: "person" | "organization", keepId: string, mergeIds: string[]): Promise<Result<{ id: string; merged: number; clientsMerged: number }>> {
  return run(async () => {
    const actor = sessionActor(await actionEditor());
    const kind = z.enum(["person", "organization"]).parse(entity);
    const result = kind === "person" ? await merging.mergePeople(actor, { keepId, mergeIds }) : await merging.mergeOrganizations(actor, { keepId, mergeIds });
    refresh();
    return result;
  });
}

// ─── Paging through lists ────────────────────────────────────────────────

const listFilter = z.object({
  q: z.string().max(200).optional(),
  ownerId: z.string().max(40).optional(),
  tag: z.string().max(40).optional(),
  /** People: at this organization, or at one that is part of it. */
  organizationId: z.uuid().optional(),
  /** Organizations: part of this parent organization, or "parents" for the parents themselves. */
  parentId: z.union([z.uuid(), z.literal("parents")]).optional(),
  sort: z.string().max(40).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
});
const pageRange = z.object({ offset: z.number().int().min(0).max(1_000_000), limit: z.number().int().min(1).max(2000).default(pageSize) });

/** The next rows of the People table as it's scrolled. */
export async function morePeople(filter: z.input<typeof listFilter>, range: z.input<typeof pageRange>): Promise<Result<Awaited<ReturnType<typeof listPeople>>>> {
  return run(async () => {
    const user = await actionUser();
    const f = listFilter.parse(filter);
    return listPeople({ ...f, ownerId: f.ownerId === "me" ? user.id : f.ownerId }, pageRange.parse(range));
  });
}

/** The next rows of the Organizations table as it's scrolled. */
export async function moreOrganizations(filter: z.input<typeof listFilter>, range: z.input<typeof pageRange>): Promise<Result<Awaited<ReturnType<typeof listOrganizations>>>> {
  return run(async () => {
    const user = await actionUser();
    const f = listFilter.parse(filter);
    return listOrganizations({ ...f, ownerId: f.ownerId === "me" ? user.id : f.ownerId }, pageRange.parse(range));
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
  calendarPeople: z.array(z.uuid()).max(20).optional(),
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
