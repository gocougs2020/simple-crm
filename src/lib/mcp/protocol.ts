import { jsonSchema } from "@/lib/api/openapi";
import { operationList, type OperationId } from "@/lib/api/operations";
import { isDestructive, type Operation, type OptionalFeature } from "@/lib/api/spec";
import type { Permission } from "@/lib/permissions";

/**
 * A Model Context Protocol server over Streamable HTTP, without the SDK: the
 * protocol needed for tools is a handful of JSON-RPC methods. Stateless (no
 * sessions, no server-sent events), so it runs on serverless functions. Pure:
 * the transport, auth and tool execution are passed in, so it's tested
 * directly.
 */

export const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LATEST_VERSION = SUPPORTED_VERSIONS[0];

export type JsonRpcId = string | number | null;
export type JsonRpcRequest = { jsonrpc: "2.0"; id?: JsonRpcId; method: string; params?: Record<string, unknown> };
export type JsonRpcResponse = { jsonrpc: "2.0"; id: JsonRpcId; result: unknown } | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string; data?: unknown } };

export const RpcError = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603 } as const;

export type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: false };
};

export type ToolCallResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

export type McpServer = {
  info: { name: string; title: string; version: string };
  instructions: string;
  /** The tools this caller may use. */
  tools: Tool[];
  /** Runs a tool. Errors a person or agent can act on come back as `{ isError: true }`, not thrown. */
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolCallResult>;
};

// ─── Tools from API operations ───────────────────────────────────────────

type ToolOp = Operation & { id: OperationId; tool: string };

export const toolOperations = operationList.filter((o): o is ToolOp => !!o.tool);

type Js = Record<string, unknown>;
const isJs = (v: unknown): v is Js => !!v && typeof v === "object" && !Array.isArray(v);
const words = (s: string) =>
  s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !["the", "a", "an", "its", "their", "this", "record", "records", "s"].includes(w));

/**
 * A schema as tools send it to a model, smaller and saying the same thing:
 * - no `maxLength` (the server checks every length and says what's too long);
 * - "a string or null" as `type: ["string", "null"]` instead of a two-branch `anyOf`;
 * - no description that only repeats the property's name ("The record's id." on `id`).
 * The REST docs and OpenAPI are built from the operations directly and keep every detail.
 */
export function modelSchema(schema: unknown, name?: string): unknown {
  if (Array.isArray(schema)) return schema.map((x) => modelSchema(x));
  if (!isJs(schema)) return schema;
  let out: Js = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "maxLength") continue;
    if (k === "properties" && isJs(v)) out.properties = Object.fromEntries(Object.entries(v).map(([p, ps]) => [p, modelSchema(ps, p)]));
    else out[k] = modelSchema(v);
  }
  const branches = out.anyOf;
  if (Array.isArray(branches) && branches.length === 2) {
    const nul = branches.findIndex((b) => isJs(b) && b.type === "null" && Object.keys(b).length === 1);
    const other = branches[1 - nul];
    if (nul >= 0 && isJs(other) && typeof other.type === "string" && !("anyOf" in other)) {
      const { anyOf: _anyOf, ...rest } = out;
      void _anyOf;
      out = { ...rest, ...other, type: [other.type, "null"], ...(Array.isArray(other.enum) ? { enum: [...other.enum, null] } : {}) };
    }
  }
  if (name && typeof out.description === "string" && words(out.description).join(" ") === words(name).join(" ")) delete out.description;
  return out;
}

/** Each tool takes one object: the operation's path parameters, query parameters and body fields together. */
export function toolInputSchema(op: Pick<Operation, "params" | "query" | "body">) {
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();
  for (const part of [op.params, op.query, op.body]) {
    if (!part) continue;
    const js = jsonSchema(part) as { properties?: Record<string, unknown>; required?: string[] };
    for (const [k, v] of Object.entries(js.properties ?? {})) properties[k] = modelSchema(v, k);
    for (const r of js.required ?? []) required.add(r);
  }
  return { type: "object", properties, ...(required.size ? { required: [...required] } : {}), additionalProperties: false };
}

/** Splits a tool's arguments back into the operation's params, query and body. */
export function splitArguments(op: Pick<Operation, "params" | "query" | "body">, args: Record<string, unknown>) {
  const pick = (schema: Operation["params"]) => (schema ? Object.fromEntries(Object.keys(schema.shape).filter((k) => k in args).map((k) => [k, args[k]])) : undefined);
  return { params: pick(op.params), query: pick(op.query), body: pick(op.body) };
}

const toolCache = new Map<string, Tool>();

/** A tool's definition from its operation. Built once per operation and kept: the schema never changes while the server runs. */
export function toolFor(op: ToolOp): Tool {
  const cached = toolCache.get(op.tool);
  if (cached) return cached;
  const built = buildTool(op);
  toolCache.set(op.tool, built);
  return built;
}

function buildTool(op: ToolOp): Tool {
  const description = op.toolDescription ?? [op.summary + ".", op.description].filter(Boolean).join(" ");
  return {
    name: op.tool,
    title: op.summary,
    description,
    inputSchema: toolInputSchema(op),
    annotations: {
      title: op.summary,
      readOnlyHint: op.method === "GET",
      destructiveHint: isDestructive(op),
      idempotentHint: op.method !== "POST",
      openWorldHint: false,
    },
  };
}

/** Whether a tool is offered on this deployment: optional features (a knowledge source) only where they're set up. */
export const offered = (op: Pick<Operation, "feature">, features: readonly OptionalFeature[]) => !op.feature || features.includes(op.feature);

/** The tools a caller with these permissions may see: a read-only teammate's agent only gets read tools. */
export function toolsFor(allowed: (p: Permission) => boolean, features: readonly OptionalFeature[] = []) {
  return toolOperations.filter((o) => allowed(o.permission) && offered(o, features)).map(toolFor);
}

// ─── JSON-RPC ────────────────────────────────────────────────────────────

const ok = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
const fail = (id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });

function isRequest(m: unknown): m is JsonRpcRequest {
  return !!m && typeof m === "object" && (m as JsonRpcRequest).jsonrpc === "2.0" && typeof (m as JsonRpcRequest).method === "string";
}

/** Handles one JSON-RPC message. Returns null for notifications, which get no reply. */
export async function handleMessage(server: McpServer, message: unknown): Promise<JsonRpcResponse | null> {
  if (!isRequest(message)) {
    const id = message && typeof message === "object" && "id" in message ? ((message as { id: JsonRpcId }).id ?? null) : null;
    // Replies to requests we never send, or garbage: answer only if it carried an id.
    if (message && typeof message === "object" && ("result" in message || "error" in message)) return null;
    return fail(id, RpcError.invalidRequest, "Expected a JSON-RPC 2.0 request.");
  }
  const isNotification = message.id === undefined;
  if (isNotification) return null;
  const id = message.id ?? null;
  const params = message.params ?? {};

  switch (message.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : LATEST_VERSION;
      const protocolVersion = (SUPPORTED_VERSIONS as readonly string[]).includes(asked) ? asked : LATEST_VERSION;
      return ok(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: server.info, instructions: server.instructions });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: server.tools });
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string") return fail(id, RpcError.invalidParams, "Pass the tool's name.");
      if (!server.tools.some((t) => t.name === name)) return fail(id, RpcError.invalidParams, `There's no tool called ${name} for this key. tools/list shows what you can use.`);
      const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
      try {
        return ok(id, await server.callTool(name, args));
      } catch {
        return fail(id, RpcError.internal, "Something went wrong on our side. Try again in a moment.");
      }
    }
    case "resources/list":
      return ok(id, { resources: [] });
    case "resources/templates/list":
      return ok(id, { resourceTemplates: [] });
    case "prompts/list":
      return ok(id, { prompts: [] });
    default:
      return fail(id, RpcError.methodNotFound, `${message.method} isn't supported. This server offers tools.`);
  }
}
