import "server-only";
import { inArray, sql } from "drizzle-orm";
import { getDb, schema, type Database } from "@/db";
import type { EntityType } from "@/lib/constants";

export type FieldChange = { field: string; label: string; from: unknown; to: unknown; fromLabel?: string | null; toLabel?: string | null };

/** Adds names to changes of linked records, so history reads "Organization: Acme → Globex" even after renames or deletes. */
export async function labelRelations(changes: FieldChange[]) {
  const db = await getDb();
  const name = async (field: string, id: unknown) => {
    if (typeof id !== "string") return null;
    if (field === "organizationId") return (await db.select({ n: schema.organizations.name }).from(schema.organizations).where(inArray(schema.organizations.id, [id])))[0]?.n ?? null;
    if (field === "personId") {
      const [p] = await db.select({ f: schema.people.firstName, l: schema.people.lastName }).from(schema.people).where(inArray(schema.people.id, [id]));
      return p ? [p.f, p.l].filter(Boolean).join(" ") : null;
    }
    return null;
  };
  for (const c of changes) {
    if (c.field !== "organizationId" && c.field !== "personId") continue;
    c.fromLabel = await name(c.field, c.from);
    c.toLabel = await name(c.field, c.to);
  }
  return changes;
}

/** Writes one history entry. Called from every action that changes a record. */
export async function recordEvent(
  input: { entityType: EntityType; entityId: string; action: string; data?: Record<string, unknown>; userId: string | null },
  db?: Database,
) {
  const d = db ?? (await getDb());
  await d.insert(schema.events).values({ ...input, data: input.data ?? {} });
}

/**
 * The fields that actually changed between two versions of a record, with
 * labels for the timeline. Values are compared as JSON so arrays and dates
 * compare by content.
 */
export function diff<T extends Record<string, unknown>>(before: T, patch: Partial<T>, labels: Partial<Record<keyof T, string>>): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const key of Object.keys(patch) as (keyof T & string)[]) {
    if (!(key in labels)) continue;
    const from = before[key] ?? null;
    const to = patch[key] ?? null;
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    changes.push({ field: key, label: labels[key]!, from, to });
  }
  return changes;
}

/** Marks records as just-touched, for "last activity" columns and sorting. */
export async function touch(links: { personId?: string | null; organizationId?: string | null; clientId?: string | null }, at = new Date()) {
  const db = await getDb();
  const ops: Promise<unknown>[] = [];
  const later = (col: ReturnType<typeof sql.raw>) => sql`greatest(coalesce(${col}, ${at}), ${at})`;
  if (links.personId) ops.push(db.update(schema.people).set({ lastActivityAt: later(sql.raw(`"people"."last_activity_at"`)) }).where(inArray(schema.people.id, [links.personId])));
  if (links.organizationId)
    ops.push(db.update(schema.organizations).set({ lastActivityAt: later(sql.raw(`"organizations"."last_activity_at"`)) }).where(inArray(schema.organizations.id, [links.organizationId])));
  if (links.clientId) ops.push(db.update(schema.clients).set({ lastActivityAt: later(sql.raw(`"clients"."last_activity_at"`)) }).where(inArray(schema.clients.id, [links.clientId])));
  await Promise.all(ops);
}
