import "server-only";
import { and, asc, eq, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { EntityType } from "@/lib/constants";
import { filterConditions, type CustomFieldDef, type FilterConditions } from "./filter-fields";
import { filterSql } from "./filter-sql";

const { savedFilters, users } = schema;

/** A saved filter as the Filters menu and the API show it. */
export type SavedFilter = {
  id: string;
  name: string;
  entityType: EntityType;
  conditions: FilterConditions;
  shared: boolean;
  createdBy: string | null;
  createdByName: string | null;
  updatedAt: Date;
};

/** Filters someone can use: their own, and everyone's shared ones. `userId` null (a workspace key) sees the shared ones. */
const visibleTo = (userId: string | null) => (userId ? or(eq(savedFilters.shared, true), eq(savedFilters.createdBy, userId))! : eq(savedFilters.shared, true));

const select = {
  id: savedFilters.id,
  name: savedFilters.name,
  entityType: savedFilters.entityType,
  conditions: savedFilters.conditions,
  shared: savedFilters.shared,
  createdBy: savedFilters.createdBy,
  createdByName: users.name,
  updatedAt: savedFilters.updatedAt,
};

/** The filters someone can pick on a list, by name. */
export async function visibleFilters(userId: string | null, entity?: EntityType): Promise<SavedFilter[]> {
  const db = await getDb();
  return db
    .select(select)
    .from(savedFilters)
    .leftJoin(users, eq(users.id, savedFilters.createdBy))
    .where(and(visibleTo(userId), entity ? eq(savedFilters.entityType, entity) : undefined))
    .orderBy(sql`lower(${savedFilters.name})`, asc(savedFilters.id));
}

/** One filter, if it exists and this person can use it. */
export async function visibleFilter(userId: string | null, id: string): Promise<SavedFilter | null> {
  const db = await getDb();
  const [row] = await db.select(select).from(savedFilters).leftJoin(users, eq(users.id, savedFilters.createdBy)).where(and(eq(savedFilters.id, id), visibleTo(userId))).limit(1);
  return row ?? null;
}

/**
 * Every custom field, archived ones included: archiving a field hides it but
 * keeps its values, so a filter on it keeps working.
 */
export async function filterCustomFields(): Promise<CustomFieldDef[]> {
  const db = await getDb();
  const f = schema.customFields;
  return db.select({ entityType: f.entityType, key: f.key, label: f.label, type: f.type, options: f.options }).from(f);
}

/** A filter's conditions as a WHERE fragment on its list. */
export async function filterWhere(entity: EntityType, conditions: FilterConditions): Promise<SQL | undefined> {
  return filterSql(entity, filterConditions.parse(conditions), await filterCustomFields());
}

/**
 * The filter a list was asked for (`?filter=` in the app, `filterId` in the
 * API), checked against who's asking. `missing` when it doesn't exist, is
 * someone else's private filter, or is for another list, so the list can say
 * so rather than quietly showing everything.
 */
export async function resolveFilter(userId: string | null, entity: EntityType, id: string | undefined): Promise<{ filter: SavedFilter | null; where: SQL | undefined; missing: boolean }> {
  if (!id) return { filter: null, where: undefined, missing: false };
  const found = /^[0-9a-f-]{36}$/i.test(id) ? await visibleFilter(userId, id) : null;
  if (!found || found.entityType !== entity) return { filter: null, where: sql`false`, missing: true };
  return { filter: found, where: await filterWhere(entity, found.conditions), missing: false };
}
