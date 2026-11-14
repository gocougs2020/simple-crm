import { operationList, type OperationId } from "./operations";
import type { HttpMethod } from "./spec";

/**
 * Finds the operation for a request path under /api/v1. Pure, so it's tested
 * directly. Literal segments win over {params}, so /people/{id}/restore and
 * /people/{id} never clash.
 */
type Compiled = { id: OperationId; method: HttpMethod; parts: string[] };
const compiled: Compiled[] = operationList.map((o) => ({ id: o.id, method: o.method, parts: o.path.split("/").filter(Boolean) }));

export type Match = { ok: true; id: OperationId; params: Record<string, string> } | { ok: false; status: 404 } | { ok: false; status: 405; allow: HttpMethod[] };

function matchParts(parts: string[], segments: string[]) {
  if (parts.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.startsWith("{") && p.endsWith("}")) params[p.slice(1, -1)] = segments[i];
    else if (p !== segments[i]) return null;
  }
  return params;
}

export function matchRoute(method: string, segments: string[]): Match {
  const candidates = compiled
    .map((c) => ({ c, params: matchParts(c.parts, segments) }))
    .filter((x): x is { c: Compiled; params: Record<string, string> } => x.params !== null)
    // Fewer path parameters means a more specific route.
    .sort((a, b) => Object.keys(a.params).length - Object.keys(b.params).length);
  if (!candidates.length) return { ok: false, status: 404 };
  const hit = candidates.find((x) => x.c.method === method);
  if (hit) return { ok: true, id: hit.c.id, params: hit.params };
  return { ok: false, status: 405, allow: [...new Set(candidates.map((x) => x.c.method))] };
}
