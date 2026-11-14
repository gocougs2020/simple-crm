import "server-only";
import { readBodyLimited } from "@/lib/api/body";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { OAuthError } from "./server";

/**
 * HTTP plumbing for the OAuth endpoints. They take no cookies, so any origin
 * may call them (browser-based MCP clients do); answers are never cached.
 */
export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};
const noStore = { "Cache-Control": "no-store", Pragma: "no-cache" };

export const preflight = () => new Response(null, { status: 204, headers: cors });

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { ...cors, ...noStore, ...headers } });
}

export function oauthError(err: unknown) {
  if (err instanceof OAuthError) {
    const headers: Record<string, string> = err.status === 401 ? { "WWW-Authenticate": 'Basic realm="oauth"' } : {};
    return json({ error: err.error, error_description: err.description }, err.status, headers);
  }
  console.error("[oauth]", err);
  return json({ error: "server_error", error_description: "Something went wrong on our side. Try again in a moment." }, 500);
}

/** The body as form parameters. Token requests are form-encoded by the spec; JSON is accepted too, for lenient clients. */
export async function readForm(request: Request): Promise<URLSearchParams> {
  const read = await readBodyLimited(request, 64 * 1024);
  if (!read.ok) throw new OAuthError("invalid_request", "The request body is too large.");
  if (/^application\/json/i.test(request.headers.get("content-type") ?? "")) {
    try {
      const obj = JSON.parse(read.text) as Record<string, unknown>;
      return new URLSearchParams(Object.entries(obj).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])));
    } catch {
      throw new OAuthError("invalid_request", "The body isn't valid JSON.");
    }
  }
  return new URLSearchParams(read.text);
}

export async function readJson(request: Request): Promise<unknown> {
  const read = await readBodyLimited(request, 64 * 1024);
  if (!read.ok) throw new OAuthError("invalid_request", "The request body is too large.");
  try {
    return JSON.parse(read.text);
  } catch {
    throw new OAuthError("invalid_client_metadata", "Send the registration as JSON.");
  }
}

/** Throttles by IP; throws an OAuth error over the limit. */
export async function throttle(bucket: string, limit: number, windowMs: number) {
  const r = await rateLimit(bucket, await clientIp(), { limit, windowMs });
  if (r.limited) throw new OAuthError("slow_down", "Too many requests. Wait a minute and try again.", 429);
}
