import { z } from "zod";
import { permissionLabels } from "./docs-text";
import { models } from "./models";
import { operationList, tags } from "./operations";
import type { Operation } from "./spec";

/**
 * The OpenAPI 3.1 document, generated from the operations and models. Pure,
 * so it can be built at request time, in tests, and for the docs page. Import
 * it into Postman, Insomnia or any OpenAPI tool, or generate a client from it.
 */

type Json = Record<string, unknown>;

/**
 * JSON Schema for a zod schema, without the $schema header OpenAPI doesn't
 * want, and without the long regexes zod adds next to `format` (uuid,
 * date-time): the format says the same thing in a word, which keeps the
 * document readable and MCP tool lists small.
 */
export function jsonSchema(schema: z.ZodType, io: "input" | "output" = "input"): Json {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: "any", target: "draft-2020-12" }) as Json;
  void _drop;
  return slim(rest) as Json;
}

function slim(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(slim);
  if (!node || typeof node !== "object") return node;
  const out: Json = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "pattern" && "format" in node) continue;
    out[k] = slim(v);
  }
  return out;
}

type Param = { name: string; in: "path" | "query"; required: boolean; description?: string; schema: Json; style?: string; explode?: boolean };

/** Path and query parameters of an operation, one entry each. */
export function parametersOf(op: Pick<Operation, "params" | "query">): Param[] {
  const out: Param[] = [];
  for (const [where, schema] of [
    ["path", op.params],
    ["query", op.query],
  ] as const) {
    if (!schema) continue;
    const js = jsonSchema(schema) as { properties?: Record<string, Json>; required?: string[] };
    for (const [name, prop] of Object.entries(js.properties ?? {})) {
      const { description, ...rest } = prop as Json & { description?: string };
      const isArray = JSON.stringify(rest).includes('"type":"array"');
      out.push({ name, in: where, required: where === "path" || (js.required ?? []).includes(name), ...(description ? { description } : {}), schema: rest, ...(isArray ? { style: "form", explode: true } : {}) });
    }
  }
  return out;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

export function responseSchema(op: Pick<Operation, "response" | "list">): Json {
  return op.list
    ? { type: "object", properties: { data: { type: "array", items: ref(op.response) }, nextCursor: { type: ["string", "null"], description: "Pass as cursor for the next page. Null on the last page." } }, required: ["data", "nextCursor"] }
    : { type: "object", properties: { data: ref(op.response) }, required: ["data"] };
}

const errorSchema = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        code: { type: "string", examples: ["validation_error", "not_found", "forbidden", "conflict", "unauthorized", "rate_limited"] },
        message: { type: "string", description: "A sentence that says what went wrong and what to do." },
        issues: { type: "array", items: { type: "object", properties: { path: { type: "string" }, message: { type: "string" } } } },
        existingId: { type: "string", description: "On 409: the record that already exists." },
      },
      required: ["code", "message"],
    },
  },
  required: ["error"],
};

export function buildOpenApi({ title, serverUrl, description }: { title: string; serverUrl: string; description?: string }) {
  const paths: Record<string, Record<string, Json>> = {};
  for (const op of operationList) {
    const entry: Json = {
      operationId: op.id,
      summary: op.summary,
      description: [op.description, `Needs: ${permissionLabels[op.permission]}.`].filter(Boolean).join("\n\n"),
      tags: [op.tag],
      parameters: parametersOf(op),
      responses: {
        [String(op.status ?? 200)]: { description: op.summary, content: { "application/json": { schema: responseSchema(op) } } },
        "4XX": { description: "The request couldn't be done. The message says why.", content: { "application/json": { schema: ref("Error") } } },
      },
    };
    if (op.body) entry.requestBody = { required: true, content: { "application/json": { schema: jsonSchema(op.body) } } };
    if (op.tool) entry["x-mcp-tool"] = op.tool;
    (paths[op.path] ??= {})[op.method.toLowerCase()] = entry;
  }
  return {
    openapi: "3.1.0",
    info: { title, version: "1.0.0", ...(description ? { description } : {}) },
    servers: [{ url: serverUrl }],
    security: [{ apiKey: [] }],
    tags: tags.map((t) => ({ ...t })),
    paths,
    components: {
      securitySchemes: {
        apiKey: { type: "http", scheme: "bearer", description: "A workspace key (crm_ws_…) or a personal key (crm_pk_…) from Settings → API." },
      },
      schemas: { ...Object.fromEntries(Object.entries(models).map(([name, s]) => [name, jsonSchema(s, "output")])), Error: errorSchema },
    },
  };
}
