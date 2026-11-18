import { isDestructive, type OptionalFeature } from "@/lib/api/spec";
import type { Permission } from "@/lib/permissions";
import { offered, toolOperations } from "@/lib/mcp/protocol";

/**
 * Which tools the agent gets, and which wait for a button press. Pure
 * (tested): the role check is passed in.
 */

/** Archive, delete and merge: the teammate confirms with a button in text chat. Voice chat leaves them out, since there's no button to press. */
export const needsConfirmation = (name: string) => toolOperations.some((o) => o.tool === name && isDestructive(o));

/** What the confirm card says under the tool's name. */
export const confirmReason = (name: string) =>
  name.startsWith("archive_") ? "This archives a record. It can be restored later." : name.startsWith("merge_") ? "This merges records and can't be undone." : "This deletes it for good.";

export function allowedOperations(allowed: (p: Permission) => boolean, opts: { voice?: boolean; features?: readonly OptionalFeature[] } = {}) {
  return toolOperations.filter((o) => allowed(o.permission) && offered(o, opts.features ?? []) && !(opts.voice && isDestructive(o)));
}

/** Tool output the model sees. Long lists are trimmed so one call can't fill the context. */
export const MAX_RESULT_CHARS = 40_000;

/** Keeps a result under `max` characters of JSON by dropping list items from the end, and says so. */
export function capResult(result: unknown, max = MAX_RESULT_CHARS): unknown {
  if (JSON.stringify(result ?? null).length <= max) return result;
  const page = result as { data?: unknown; nextCursor?: unknown };
  if (Array.isArray(page?.data)) {
    const items = [...page.data];
    while (items.length > 1 && JSON.stringify({ ...page, data: items }).length > max) items.pop();
    return { ...page, data: items, trimmed: `Showing ${items.length} of ${page.data.length}. Ask for fewer at a time (limit) or narrow the search.` };
  }
  return { trimmed: "The result was too long to show. Narrow the request.", preview: JSON.stringify(result).slice(0, max) };
}
