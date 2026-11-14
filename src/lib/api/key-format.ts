import { createHash, randomBytes } from "node:crypto";
import type { ApiKeyKind } from "@/lib/constants";

/**
 * API key format: a kind prefix and 32 random bytes in base64url, like
 * `crm_pk_3q2+…`. The prefix says what the key is at a glance (and lets
 * secret scanners spot one in a commit); only the SHA-256 hash is stored.
 */
export const keyPrefixes: Record<ApiKeyKind, string> = { workspace: "crm_ws_", personal: "crm_pk_" };
const pattern = /^crm_(ws|pk)_[A-Za-z0-9_-]{43}$/;

export function generateKey(kind: ApiKeyKind) {
  const token = keyPrefixes[kind] + randomBytes(32).toString("base64url");
  return { token, prefix: displayPrefix(token), hash: hashKey(token) };
}

/** What a key looks like in lists: its kind prefix and a few characters, never enough to use. */
export const displayPrefix = (token: string) => token.slice(0, 12);

export function hashKey(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/** The kind a well-formed key claims to be, or null for anything that isn't one of our keys. */
export function keyKind(token: string): ApiKeyKind | null {
  const m = pattern.exec(token);
  if (!m) return null;
  return m[1] === "ws" ? "workspace" : "personal";
}

/** The key in a request: `Authorization: Bearer <key>`, or `X-API-Key: <key>` for tools that can't set a bearer token. */
export function keyFromHeaders(headers: Headers) {
  const auth = headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
    return m ? m[1] : null;
  }
  return headers.get("x-api-key")?.trim() || null;
}
