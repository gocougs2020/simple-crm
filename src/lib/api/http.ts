import "server-only";
import type { NextRequest } from "next/server";
import { siteOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { authenticate } from "./auth";
import { MAX_BODY_BYTES, readBodyLimited } from "./body";
import { internalError, toApiError, type ApiError } from "./errors";
import { executeOperation } from "./execute";
import { API_RATE_LIMIT_PER_MINUTE } from "./limits";
import { operations } from "./operations";
import { matchRoute } from "./router";
import type { Operation } from "./spec";

/** Requests per key per minute, shared by the REST API and MCP. */
export const API_RATE_LIMIT = API_RATE_LIMIT_PER_MINUTE;

const baseHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export function errorResponse(e: ApiError, headers: Record<string, string> = {}) {
  const { status, ...error } = e;
  return Response.json({ error }, { status, headers: { ...baseHeaders, ...headers } });
}

/** Query strings as an object; a repeated parameter becomes an array. */
function queryObject(params: URLSearchParams) {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    out[key] = all.length > 1 ? all : all[0];
  }
  return out;
}

export const tooLarge: ApiError = { status: 413, code: "payload_too_large", message: "The request body is over 1 MB. Send less at once." };
const tooLargeFor = (max: number): ApiError => (max === MAX_BODY_BYTES ? tooLarge : { ...tooLarge, message: `The request body is over ${Math.round((max / 1024 / 1024) * 10) / 10} MB. Send a smaller file.` });

async function readBody(request: Request, max = MAX_BODY_BYTES): Promise<{ ok: true; body: unknown } | { ok: false; error: ApiError }> {
  const type = request.headers.get("content-type") ?? "";
  if (type && !/^application\/(.+\+)?json\b/i.test(type)) return { ok: false, error: { status: 415, code: "unsupported_media_type", message: "Send the body as JSON with Content-Type: application/json." } };
  const read = await readBodyLimited(request, max);
  if (!read.ok) return { ok: false, error: tooLargeFor(max) };
  const text = read.text;
  if (!text.trim()) return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, error: { status: 400, code: "invalid_json", message: "The request body isn't valid JSON." } };
  }
}

/** Every /api/v1 request: route, authenticate, rate-limit, validate, run, and answer in JSON. */
export async function handleApiRequest(request: NextRequest, segments: string[]) {
  const match = matchRoute(request.method, segments);
  if (!match.ok) {
    if (match.status === 405) return errorResponse({ status: 405, code: "method_not_allowed", message: `${request.method} isn't supported here. Use ${match.allow.join(" or ")}.` }, { Allow: match.allow.join(", ") });
    return errorResponse({ status: 404, code: "not_found", message: `There's no endpoint at ${request.method} /api/v1/${segments.join("/")}. See /api/v1/openapi.json.` });
  }

  const auth = await authenticate(request.headers);
  if (!auth.ok) return errorResponse(auth.error, { "WWW-Authenticate": 'Bearer realm="api"' });

  const limit = await rateLimit("api", auth.key.id, { limit: API_RATE_LIMIT, windowMs: 60_000 });
  const rate = { "X-RateLimit-Limit": String(API_RATE_LIMIT), "X-RateLimit-Remaining": String(Math.max(0, API_RATE_LIMIT - limit.count)) };
  if (limit.limited) {
    const retry = String(60 - (Math.floor(Date.now() / 1000) % 60));
    return errorResponse({ status: 429, code: "rate_limited", message: `This key made over ${API_RATE_LIMIT} requests this minute. Wait ${retry} seconds.` }, { ...rate, "Retry-After": retry });
  }

  const op = operations[match.id] as Operation;
  let body: unknown;
  if (op.body) {
    const read = await readBody(request, op.maxBodyBytes);
    if (!read.ok) return errorResponse(read.error, rate);
    body = read.body;
  }
  try {
    const result = await executeOperation(auth.actor, match.id, { params: match.params, query: queryObject(request.nextUrl.searchParams), body }, { origin: await siteOrigin() });
    return Response.json(result, { status: op.status ?? 200, headers: { ...baseHeaders, ...rate } });
  } catch (err) {
    const e = toApiError(err);
    if (!e) console.error(`[api] ${request.method} ${request.nextUrl.pathname}`, err);
    return errorResponse(e ?? internalError, rate);
  }
}
