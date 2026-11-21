import type { Operation } from "./spec";

/** How many rows a list tool returns when the model doesn't ask for a number (the REST API keeps its own default). */
export const TOOL_LIST_LIMIT = 20;

/** A tool call's arguments with the tools' smaller default list size filled in, when the operation pages and no `limit` was given. */
export function toolArguments(op: Pick<Operation, "query">, args: Record<string, unknown>) {
  if (!op.query || !("limit" in op.query.shape) || args.limit !== undefined) return args;
  return { ...args, limit: TOOL_LIST_LIMIT };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A result as tools hand it to a model: wherever there's a plain-text copy of
 * a body (`bodyText`), the HTML `body` beside it is left out, since it says
 * the same thing in more tokens. The REST API returns both.
 */
export function toolResult<T>(value: T): T {
  if (Array.isArray(value)) return value.map(toolResult) as T;
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "body" && typeof value.bodyText === "string") continue;
    out[k] = toolResult(v);
  }
  return out as T;
}
