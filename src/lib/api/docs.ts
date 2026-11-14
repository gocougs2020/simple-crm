import type { z } from "zod";
import { jsonSchema } from "./openapi";
import type { Operation } from "./spec";

/** Helpers for the docs page: field tables and examples from the same schemas the API validates with. Pure. */

type Js = {
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  const?: unknown;
  items?: Js;
  anyOf?: Js[];
  oneOf?: Js[];
  properties?: Record<string, Js>;
  required?: string[];
  description?: string;
};

export type FieldDoc = { name: string; type: string; required: boolean; description: string | null };

/** A short type label, like `string (uuid) or null`, `"open" | "done"`, or `string[]`. */
export function typeLabel(s: Js): string {
  const union = s.anyOf ?? s.oneOf;
  if (union) {
    const parts = union.filter((x) => x.type !== "null").map(typeLabel);
    const nullable = union.some((x) => x.type === "null");
    return [...new Set(parts)].join(" | ") + (nullable ? " or null" : "");
  }
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (Array.isArray(s.type)) return s.type.filter((t) => t !== "null").join(" | ") + (s.type.includes("null") ? " or null" : "");
  if (s.type === "array") return `${s.items ? typeLabel(s.items) : "any"}[]`;
  if (s.type === "string" && s.format) return `string (${s.format})`;
  return s.type ?? "any";
}

function fields(js: Js): FieldDoc[] {
  const required = new Set(js.required ?? []);
  return Object.entries(js.properties ?? {}).map(([name, p]) => ({ name, type: p.type === "object" && p.properties ? "object" : typeLabel(p), required: required.has(name), description: p.description ?? null }));
}

/** Parameters or body fields of an operation. */
export function fieldsOf(schema: z.ZodType | undefined): FieldDoc[] {
  return schema ? fields(jsonSchema(schema, "input") as Js) : [];
}

/** Fields of a response model, one level deep. */
export function modelFields(schema: z.ZodType): FieldDoc[] {
  return fields(jsonSchema(schema, "output") as Js);
}

function sample(name: string, s: Js): unknown {
  const union = s.anyOf ?? s.oneOf;
  if (union) return sample(name, union.find((x) => x.type !== "null") ?? {});
  if (s.enum) return s.enum[0];
  if (s.type === "boolean") return true;
  if (s.type === "integer" || s.type === "number") return 1;
  if (s.type === "array") return [sample(name, s.items ?? {})];
  if (s.format === "uuid") return "3f6c…";
  if (s.format === "date-time") return "2026-11-20T09:00:00-07:00";
  if (/date|On$|period/i.test(name)) return "2026-11-20";
  return "…";
}

/** The docs' example body: the operation's own example, or its required fields. */
export function exampleBody(op: Pick<Operation, "body" | "example">) {
  if (op.example) return op.example;
  if (!op.body) return null;
  const js = jsonSchema(op.body) as Js;
  const required = js.required ?? [];
  const keys = required.length ? required : Object.keys(js.properties ?? {}).slice(0, 2);
  return Object.fromEntries(keys.map((k) => [k, sample(k, js.properties?.[k] ?? {})]));
}

/** A copy-paste curl command. Reads the site and key from $CRM_URL and $CRM_KEY; path ids become $ID-style variables. */
export function curlFor(op: Pick<Operation, "method" | "path" | "body" | "example">) {
  const path = op.path.replace(/\{(\w+)\}/g, (_m, p: string) => `$${p.replace(/([A-Z])/g, "_$1").toUpperCase()}`);
  const lines = [`curl${op.method === "GET" ? "" : ` -X ${op.method}`} "$CRM_URL/api/v1${path}"`, `  -H "Authorization: Bearer $CRM_KEY"`];
  const body = exampleBody(op);
  if (body) lines.push(`  -H "Content-Type: application/json"`, `  -d '${JSON.stringify(body, null, 2).replace(/\n/g, "\n  ")}'`);
  return lines.join(" \\\n");
}
