import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { EntityType } from "@/lib/constants";

/**
 * The record an id stands for now. `pnpm run dedupe` deletes duplicates and
 * notes on the kept record which ids were merged into it ("merged" history),
 * so a link that still carries a duplicate's id, like the unsubscribe link in
 * an email sent before the merge, reaches the kept record. Follows a few
 * merges in a row; the id itself when nothing was merged.
 */
export async function currentRecordId(entity: EntityType, id: string) {
  const db = await getDb();
  const { events } = schema;
  let current = id;
  for (let hop = 0; hop < 5; hop++) {
    const ref = JSON.stringify([{ id: current }]);
    const [next] = await db
      .select({ id: events.entityId })
      .from(events)
      .where(and(eq(events.entityType, entity), eq(events.action, "merged"), sql`(${events.data}->'merged' @> ${ref}::jsonb or ${events.data}->'deleted' @> ${ref}::jsonb)`))
      .limit(1);
    if (!next || next.id === current) break;
    current = next.id;
  }
  return current;
}
