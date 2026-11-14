import "server-only";
import { after } from "next/server";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { Actor } from "@/lib/crm/actor";
import { tokenPrefixes } from "@/lib/oauth/core";
import { accessTokenGrant } from "@/lib/oauth/server";
import { hashKey, keyFromHeaders, keyKind } from "./key-format";

/**
 * Turns a request's API key into the actor it acts as. Checks the key on
 * every request (revoked, expired, teammate deactivated), so revoking takes
 * effect at once, and a teammate's role change applies to their keys
 * immediately.
 */

export type ApiKey = typeof schema.apiKeys.$inferSelect;
/** `tokenPresented` is true when a credential was sent but didn't work, so MCP can answer `error="invalid_token"` and the client refreshes or reconnects. */
export type AuthFailure = { status: 401; code: "unauthorized"; message: string; tokenPresented?: boolean };
export type AuthResult = { ok: true; actor: Actor; key: ApiKey } | { ok: false; error: AuthFailure };

const fail = (message: string, tokenPresented = true): AuthResult => ({ ok: false, error: { status: 401, code: "unauthorized", message, tokenPresented } });

export async function authenticate(headers: Headers): Promise<AuthResult> {
  const token = keyFromHeaders(headers);
  if (!token) return fail("Add your API key as `Authorization: Bearer <key>`, or connect through OAuth. Create a key in Settings → API and MCP.", false);
  const db = await getDb();

  // An OAuth access token from a connected app: acts as the teammate who approved it.
  if (token.startsWith(tokenPrefixes.access)) {
    const found = await accessTokenGrant(token);
    if (!found.ok) return fail(found.message);
    touch(found.grant);
    return { ok: true, actor: { kind: "user", user: found.user, keyId: found.grant.id, readOnly: found.grant.readOnly }, key: found.grant };
  }

  const kind = keyKind(token);
  if (!kind) return fail("That isn't a valid API key. Keys start with crm_ws_ or crm_pk_.");
  const [row] = await db
    .select({ key: schema.apiKeys, user: schema.users })
    .from(schema.apiKeys)
    .leftJoin(schema.users, eq(schema.users.id, schema.apiKeys.userId))
    .where(eq(schema.apiKeys.tokenHash, hashKey(token)))
    .limit(1);
  if (!row || row.key.kind !== kind) return fail("That API key doesn't exist. It may have been deleted.");
  const { key, user } = row;
  if (key.revokedAt) return fail("That API key was revoked. Create a new one in Settings → API.");
  if (key.expiresAt && key.expiresAt <= new Date()) return fail("That API key has expired. Create a new one in Settings → API.");

  let actor: Actor;
  if (key.kind === "workspace") actor = { kind: "workspace", keyId: key.id, keyName: key.name };
  else {
    if (!user || user.deactivatedAt) return fail("The teammate this key belongs to was deactivated, so the key no longer works.");
    actor = { kind: "user", user, keyId: key.id, readOnly: key.readOnly };
  }
  touch(key);
  return { ok: true, actor, key };
}

/** Remembers when a key or connected app was last used, at most once a minute, after the response. */
function touch(key: ApiKey) {
  const minuteAgo = new Date(Date.now() - 60_000);
  if (key.lastUsedAt && key.lastUsedAt >= minuteAgo) return;
  after(async () => {
    const db = await getDb();
    await db
      .update(schema.apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(and(eq(schema.apiKeys.id, key.id), or(isNull(schema.apiKeys.lastUsedAt), lt(schema.apiKeys.lastUsedAt, minuteAgo))))
      .catch((err) => console.error("[api] last used", err));
  });
}
