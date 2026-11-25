"use server";

import { refresh } from "next/cache";
import { and, count, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { run, type Result } from "@/lib/action";
import { ActionError, actionEditor, actionUser, isAdmin } from "@/lib/auth";
import { entityTypes, type EntityType } from "@/lib/constants";
import { conditionCount, conditionProblem, filterConditions, type FilterConditions } from "@/lib/crm/filter-fields";
import { filterSql } from "@/lib/crm/filter-sql";
import { countOrganizations, countPeople } from "@/lib/crm/records";
import { filterCustomFields } from "@/lib/crm/saved-filters";

const { savedFilters } = schema;
const uuid = z.uuid();

const saveInput = z.object({
  name: z.string().trim().min(1, "Name the filter.").max(80, "Keep the name under 80 characters."),
  entityType: z.enum(entityTypes),
  conditions: filterConditions,
  shared: z.boolean().default(false),
});

/**
 * Creates or changes a saved filter. Anyone who can edit records makes
 * their own; sharing one puts it in everyone's Filters menu. Only its maker
 * or an admin can change or delete it afterwards.
 */
export async function saveFilter(filterId: string | null, input: z.input<typeof saveInput>): Promise<Result<{ id: string }>> {
  return run(async () => {
    const user = await actionEditor();
    const data = saveInput.parse(input);
    if (!conditionCount(data.conditions)) throw new ActionError("Add at least one condition.");
    const custom = await filterCustomFields();
    for (const c of [...data.conditions.all, ...data.conditions.any]) {
      const problem = conditionProblem(c, custom);
      if (problem) throw new ActionError(problem);
    }
    const db = await getDb();
    if (!filterId) {
      const [row] = await db.insert(savedFilters).values({ ...data, createdBy: user.id }).returning({ id: savedFilters.id });
      refresh();
      return row;
    }
    const id = uuid.parse(filterId);
    const [before] = await db.select({ createdBy: savedFilters.createdBy, shared: savedFilters.shared, entityType: savedFilters.entityType }).from(savedFilters).where(eq(savedFilters.id, id));
    if (!before || (!before.shared && before.createdBy !== user.id)) throw new ActionError("This filter was deleted. Make a new one.");
    if (before.createdBy !== user.id && !isAdmin(user)) throw new ActionError("Only the person who made this filter, or an admin, can change it. Make your own copy with Save as new.");
    if (before.entityType !== data.entityType) throw new ActionError("A filter stays on the list it was made for.");
    const [row] = await db
      .update(savedFilters)
      .set({ name: data.name, conditions: data.conditions, shared: data.shared, updatedAt: new Date() })
      .where(eq(savedFilters.id, id))
      .returning({ id: savedFilters.id });
    refresh();
    return row;
  });
}

export async function deleteFilter(filterId: string): Promise<Result> {
  return run(async () => {
    const user = await actionEditor();
    const db = await getDb();
    const id = uuid.parse(filterId);
    // Their own, or (admins) any shared one. Someone else's private filter is never touched.
    const mine = eq(savedFilters.createdBy, user.id);
    const rows = await db
      .delete(savedFilters)
      .where(and(eq(savedFilters.id, id), isAdmin(user) ? or(mine, eq(savedFilters.shared, true)) : mine))
      .returning({ id: savedFilters.id });
    if (!rows.length) throw new ActionError("Only the person who made this filter, or an admin, can delete it.");
    refresh();
  });
}

/**
 * How many records match while the filter is being built. Conditions that
 * aren't finished yet (no value picked) are left out, so the count follows
 * along as they're filled in.
 */
export async function previewFilter(entity: EntityType, conditions: FilterConditions): Promise<Result<{ count: number }>> {
  return run(async () => {
    await actionUser();
    const e = z.enum(entityTypes).parse(entity);
    const parsed = filterConditions.parse(conditions);
    const custom = await filterCustomFields();
    const ready = { all: parsed.all.filter((c) => !conditionProblem(c, custom)), any: parsed.any.filter((c) => !conditionProblem(c, custom)) };
    const saved = filterSql(e, ready, custom);
    if (e === "person") return { count: await countPeople({ saved }) };
    if (e === "organization") return { count: await countOrganizations({ saved }) };
    const db = await getDb();
    const [row] = await db
      .select({ n: count() })
      .from(schema.clients)
      .where(and(isNull(schema.clients.archivedAt), saved));
    return { count: row?.n ?? 0 };
  });
}
