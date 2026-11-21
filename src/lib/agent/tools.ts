import "server-only";
import { jsonSchema, tool, type ToolSet } from "ai";
import { internalError, toApiError } from "@/lib/api/errors";
import { executeOperation } from "@/lib/api/execute";
import { deploymentToolDescription, enabledFeatures } from "@/lib/api/features";
import type { HandlerContext } from "@/lib/api/handlers";
import { operations } from "@/lib/api/operations";
import { can, type Actor } from "@/lib/crm/actor";
import { splitArguments, toolFor } from "@/lib/mcp/protocol";
import { toolArguments, toolResult } from "@/lib/api/tool-results";
import { allowedOperations, capResult } from "./policy";

export { needsConfirmation } from "./policy";

/**
 * The agent's tools are the MCP tools: one per API operation, generated
 * from src/lib/api/operations.ts, filtered by the teammate's role and run
 * through executeOperation (permission check, validation, history). Adding an
 * operation with a `tool` name gives the agent that tool too.
 */

/** The tools this actor may use. */
export const allowedTools = (actor: Actor, opts: { voice?: boolean } = {}) => allowedOperations((p) => can(actor, p), { ...opts, features: enabledFeatures() });

export function agentTools(actor: Actor, ctx: HandlerContext, opts: { voice?: boolean } = {}): ToolSet {
  const tools: ToolSet = {};
  for (const op of allowedTools(actor, opts)) {
    const def = toolFor(op);
    tools[op.tool] = tool({
      description: deploymentToolDescription(op.tool, def.description),
      inputSchema: jsonSchema(def.inputSchema as Parameters<typeof jsonSchema>[0]),
      execute: (args) => runTool(actor, op.tool, (args ?? {}) as Record<string, unknown>, ctx, opts),
    });
  }
  return tools;
}

/**
 * Runs one tool for the actor. Failures come back as `{ error }` with the same
 * sentence the API would give, so the model can correct itself or explain.
 */
export async function runTool(actor: Actor, name: string, args: Record<string, unknown>, ctx: HandlerContext, opts: { voice?: boolean } = {}) {
  const op = allowedTools(actor, opts).find((o) => o.tool === name);
  if (!op) return { error: `There's no tool called ${name} you can use.` };
  try {
    // Tools default to smaller lists and leave out HTML bodies that have a plain-text copy (src/lib/api/tool-results.ts).
    return capResult(toolResult(await executeOperation(actor, op.id, splitArguments(operations[op.id], toolArguments(operations[op.id], args)), ctx)));
  } catch (err) {
    const e = toApiError(err);
    if (!e) console.error(`[agent] ${name}`, err);
    return { error: (e ?? internalError).message, ...(e?.issues?.length ? { issues: e.issues } : {}) };
  }
}
