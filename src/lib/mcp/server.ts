import "server-only";
import { appConfig } from "@/app.config";
import { authenticate } from "@/lib/api/auth";
import { internalError, toApiError } from "@/lib/api/errors";
import { executeOperation } from "@/lib/api/execute";
import { readBodyLimited } from "@/lib/api/body";
import { API_RATE_LIMIT, errorResponse, tooLarge } from "@/lib/api/http";
import { operations } from "@/lib/api/operations";
import { can, type Actor } from "@/lib/crm/actor";
import { siteOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { handleMessage, RpcError, splitArguments, toolOperations, toolsFor, type JsonRpcResponse, type McpServer, type ToolCallResult } from "./protocol";

/** Messages per request. Batching is for a few calls at once, not bulk work. */
const MAX_BATCH = 20;

/**
 * The MCP endpoint (/api/mcp). Personal keys only: an agent acts as its
 * teammate, with their role, and every change it makes is attributed to them
 * (and to the key) in history. Workspace keys are refused here on purpose.
 */

const instructions = (name: string, actor: Actor & { kind: "user" }, readOnly: boolean) =>
  [
    `You're connected to ${name}, a CRM, acting as ${actor.user.name} (${actor.user.role}). Everything you change is recorded in history as them.`,
    readOnly ? "This teammate has read-only access, so only reading tools are available." : "",
    "Records: people (contacts), organizations (companies) and clients. A client is a relationship in one of three categories: prospective, current or past, moving through its category's pipeline stages.",
    "Use search first to find ids. Money is in integer cents (12500 is 125.00). Dates are YYYY-MM-DD; times are ISO 8601 with an offset.",
    "Tasks and notes can stand alone or link to a person, organization or client. Logging on a client also shows on its contact and organization.",
    "Archiving hides a record but keeps its history. Lists return nextCursor; pass it back as cursor for the next page.",
  ]
    .filter(Boolean)
    .join("\n");

function serverFor(actor: Actor & { kind: "user" }, origin: string): McpServer {
  const allowed = (p: Parameters<typeof can>[1]) => can(actor, p);
  const tools = toolsFor(allowed);
  return {
    info: { name: "crm", title: appConfig.brand.name, version: "1.0.0" },
    instructions: instructions(appConfig.brand.name, actor, !can(actor, "records:write")),
    tools,
    async callTool(name, args): Promise<ToolCallResult> {
      const op = toolOperations.find((o) => o.tool === name)!;
      try {
        const result = await executeOperation(actor, op.id, splitArguments(operations[op.id], args), { origin });
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
      } catch (err) {
        const e = toApiError(err);
        if (!e) console.error(`[mcp] ${name}`, err);
        const issues = e?.issues && e.issues.length > 1 ? `\n${e.issues.map((i) => `- ${i.path || "input"}: ${i.message}`).join("\n")}` : "";
        return { content: [{ type: "text", text: `${(e ?? internalError).message}${issues}` }], isError: true };
      }
    },
  };
}

const jsonHeaders = { "Cache-Control": "no-store", "Content-Type": "application/json" };

/** Whether a browser Origin is this site. "null" (sandboxed frames) and anything unparseable count as cross-site. */
async function sameSite(origin: string, requestUrl: string) {
  try {
    return new URL(origin).host === new URL(requestUrl).host || origin === (await siteOrigin());
  } catch {
    return false;
  }
}

export async function handleMcpRequest(request: Request) {
  // Browsers can't be used to reach this from another site (DNS rebinding): a cross-site Origin is refused.
  const origin = request.headers.get("origin");
  if (origin && !(await sameSite(origin, request.url))) {
    return errorResponse({ status: 403, code: "forbidden", message: "Cross-site requests to MCP aren't allowed." });
  }

  const auth = await authenticate(request.headers);
  if (!auth.ok) return errorResponse(auth.error, { "WWW-Authenticate": 'Bearer realm="mcp"' });
  if (auth.actor.kind !== "user") {
    return errorResponse({
      status: 403,
      code: "forbidden",
      message: "Workspace API keys can't be used with MCP. Each teammate creates their own MCP key in Settings → API, so an agent only ever has its person's access.",
    });
  }
  const actor = auth.actor;

  const read = await readBodyLimited(request);
  if (!read.ok) return errorResponse(tooLarge);
  let payload: unknown;
  try {
    payload = JSON.parse(read.text);
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: RpcError.parse, message: "The body isn't valid JSON." } }, { status: 400, headers: jsonHeaders });
  }
  const messages = Array.isArray(payload) ? payload : [payload];
  if (messages.length > MAX_BATCH) {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: RpcError.invalidRequest, message: `Send at most ${MAX_BATCH} messages at once.` } }, { status: 400, headers: jsonHeaders });
  }

  // Every tool call counts against the key's limit, so batching can't get around it.
  const toolCalls = messages.filter((m) => !!m && typeof m === "object" && (m as { method?: unknown }).method === "tools/call").length;
  const limit = await rateLimit("api", auth.key.id, { limit: API_RATE_LIMIT, windowMs: 60_000, cost: Math.max(1, toolCalls) });
  if (limit.limited) return errorResponse({ status: 429, code: "rate_limited", message: `This key made over ${API_RATE_LIMIT} requests this minute. Wait a minute.` }, { "Retry-After": "60" });

  const server = serverFor(actor, await siteOrigin());
  // One at a time: a batch never runs more work at once than single requests would.
  const replies: JsonRpcResponse[] = [];
  for (const m of messages) {
    const reply = await handleMessage(server, m);
    if (reply) replies.push(reply);
  }
  // Only notifications (or responses): nothing to say back.
  if (!replies.length) return new Response(null, { status: 202 });
  return new Response(JSON.stringify(Array.isArray(payload) ? replies : replies[0]), { status: 200, headers: jsonHeaders });
}
