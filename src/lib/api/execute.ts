import "server-only";
import { assertCan, type Actor } from "@/lib/crm/actor";
import { handlers, type HandlerContext } from "./handlers";
import { operations, type OperationId } from "./operations";
import type { Operation } from "./spec";

/**
 * Runs one operation for an actor: checks its permission, validates params,
 * query and body with the operation's schemas, and calls the handler. The
 * REST router and MCP both come through here. Returns the response body:
 * `{ data, nextCursor }` for lists, `{ data }` otherwise. Throws on failure;
 * callers turn errors into responses with toApiError.
 */
export async function executeOperation(actor: Actor, id: OperationId, raw: { params?: unknown; query?: unknown; body?: unknown }, ctx: HandlerContext) {
  const op = operations[id] as Operation;
  assertCan(actor, op.permission);
  const input = {
    params: op.params ? op.params.parse(raw.params ?? {}) : {},
    query: op.query ? op.query.parse(raw.query ?? {}) : {},
    body: op.body ? op.body.parse(raw.body ?? {}) : {},
  };
  const handler = handlers[id] as (a: Actor, input: unknown, ctx: HandlerContext) => Promise<unknown>;
  const result = await handler(actor, input, ctx);
  if (op.list) {
    const page = Array.isArray(result) ? { data: result, nextCursor: null } : (result as { data: unknown[]; nextCursor: string | null });
    return { data: page.data, nextCursor: page.nextCursor ?? null };
  }
  return { data: result ?? null };
}
