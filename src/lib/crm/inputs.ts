import "server-only";
import { getDb, schema } from "@/db";
import type { CustomValues } from "@/db/schema";
import type { EntityType } from "@/lib/constants";
import { customLabels } from "@/lib/crm/custom-fields";
import { diff } from "@/lib/crm/events";

/** Validation lives in schemas.ts (pure, shared with the API docs and MCP); re-exported for the actions. */
export { id, name, optionalDate, optionalEmail, optionalId, optionalText, orgInput, tagList } from "@/lib/crm/schemas";

export async function withCustomChanges(entity: EntityType, before: CustomValues, after: CustomValues | undefined) {
  if (!after) return [];
  const labels = await customLabels(entity);
  return diff(before, after, labels).map((c) => ({ ...c, field: `custom.${c.field}` }));
}

/** Today in the workspace's time zone, as YYYY-MM-DD. */
export async function workspaceToday() {
  const db = await getDb();
  const [ws] = await db.select({ timezone: schema.workspace.timezone }).from(schema.workspace).limit(1);
  return new Intl.DateTimeFormat("en-CA", { timeZone: ws?.timezone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
