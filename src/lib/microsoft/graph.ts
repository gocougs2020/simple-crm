import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { GRAPH, MICROSOFT_SCOPES, microsoftCredentials } from "./config";

/**
 * Calls Microsoft Graph as a teammate: refreshes their access token when it's
 * about to expire, and marks the connection for reconnecting when Microsoft
 * refuses the refresh token (password changed, access revoked by an admin).
 */

export type ConnectedAccount = typeof schema.connectedAccounts.$inferSelect;

/** Something Graph said no to, in a sentence. `status` is Graph's HTTP status. */
export class GraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** The connection needs the teammate to sign in to Microsoft again. */
export class ReconnectError extends GraphError {}

type TokenResponse = { access_token: string; refresh_token?: string; expires_in: number; scope?: string; error?: string; error_description?: string };

/** Asks Microsoft's token endpoint for tokens: an authorization code (first connect) or a refresh token. */
export async function requestTokens(params: Record<string, string>): Promise<TokenResponse> {
  const creds = microsoftCredentials();
  if (!creds) throw new GraphError("Microsoft 365 isn't set up on this deployment.", 404);
  const res = await fetch(`${creds.authority}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, scope: MICROSOFT_SCOPES.join(" "), ...params }),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.access_token) {
    const message = body.error_description?.split("\r\n")[0] ?? body.error ?? `HTTP ${res.status}`;
    if (body.error === "invalid_grant" || body.error === "interaction_required") throw new ReconnectError("Microsoft asked for you to sign in again. Reconnect your account.", 401, body.error);
    throw new GraphError(`Microsoft didn't accept the sign-in: ${message}`, res.status, body.error);
  }
  return body;
}

/** The fields to store after getting tokens, encrypted. */
export function tokenColumns(t: TokenResponse, previousRefresh?: string | null) {
  return {
    accessToken: encryptSecret(t.access_token),
    // Microsoft usually sends a new refresh token; if it doesn't, the old one stays good.
    refreshToken: t.refresh_token ? encryptSecret(t.refresh_token) : (previousRefresh ?? null),
    expiresAt: new Date(Date.now() + Math.max(60, t.expires_in - 120) * 1000),
    ...(t.scope ? { scopes: t.scope.split(" ").filter(Boolean) } : {}),
  };
}

async function refresh(account: ConnectedAccount): Promise<string> {
  const db = await getDb();
  if (!account.refreshToken) {
    await markReconnect(account.id, "Microsoft didn't give the CRM lasting access. Reconnect your account.");
    throw new ReconnectError("Reconnect your Microsoft account.", 401);
  }
  try {
    const t = await requestTokens({ grant_type: "refresh_token", refresh_token: decryptSecret(account.refreshToken) });
    const cols = tokenColumns(t, account.refreshToken);
    await db
      .update(schema.connectedAccounts)
      .set({ ...cols, status: "active", updatedAt: new Date() })
      .where(eq(schema.connectedAccounts.id, account.id));
    Object.assign(account, cols, { status: "active" });
    return t.access_token;
  } catch (err) {
    if (err instanceof ReconnectError) await markReconnect(account.id, err.message);
    throw err;
  }
}

export async function markReconnect(accountId: string, reason: string) {
  const db = await getDb();
  await db
    .update(schema.connectedAccounts)
    .set({ status: "reconnect", lastError: reason, updatedAt: new Date() })
    .where(and(eq(schema.connectedAccounts.id, accountId)));
}

/** A current access token for the account, refreshed if it expires within two minutes. */
export async function accessToken(account: ConnectedAccount): Promise<string> {
  if (account.status === "reconnect") throw new ReconnectError("Reconnect your Microsoft account in Settings → Email and calendar.", 401);
  if (account.expiresAt.getTime() > Date.now() + 120_000) {
    try {
      return decryptSecret(account.accessToken);
    } catch {
      // The encryption key changed: the refresh token can't be read either.
      await markReconnect(account.id, "The CRM's encryption key changed. Reconnect your account.");
      throw new ReconnectError("Reconnect your Microsoft account.", 401);
    }
  }
  return refresh(account);
}

/**
 * One Graph request. `path` is relative to v1.0 (`/me/messages`) or a full
 * nextLink. Retries once with a fresh token on 401, and once after Graph's
 * Retry-After on 429/503. Returns null for 202/204.
 */
export async function graph<T = unknown>(account: ConnectedAccount, path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const url = path.startsWith("https://") ? path : `${GRAPH}${path}`;
  if (!url.startsWith(GRAPH)) throw new Error("Refusing to send a Graph token outside Microsoft Graph.");
  const { json, headers, ...rest } = init;
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken(account);
    const res = await fetch(url, {
      ...rest,
      headers: { authorization: `Bearer ${token}`, ...(json !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
      cache: "no-store",
    });
    if (res.status === 401 && attempt === 0) {
      // Revoked early, or the clock is off: one refresh, then give up.
      account.expiresAt = new Date(0);
      continue;
    }
    if ((res.status === 429 || res.status === 503) && attempt === 0) {
      const wait = Math.min(Number(res.headers.get("retry-after") ?? 2), 10);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (res.status === 202 || res.status === 204) return null as T;
    const body = (await res.json().catch(() => null)) as (T & { error?: { code?: string; message?: string } }) | null;
    if (!res.ok) {
      const message = body?.error?.message ?? `HTTP ${res.status}`;
      if (res.status === 401) throw new ReconnectError(`Microsoft refused the request: ${message}`, 401, body?.error?.code);
      if (res.status === 403) throw new GraphError(`Microsoft didn't allow it (${message}). Reconnect to grant the CRM access, or ask your Microsoft admin.`, 403, body?.error?.code);
      throw new GraphError(`Microsoft Graph: ${message}`, res.status, body?.error?.code);
    }
    return body as T;
  }
}

/** Every page of a Graph list, up to `maxPages`. */
export async function graphPages<T>(account: ConnectedAccount, path: string, init: RequestInit = {}, maxPages = 5): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = path;
  for (let page = 0; next && page < maxPages; page++) {
    const res: { value: T[]; "@odata.nextLink"?: string } = await graph(account, next, init);
    out.push(...(res?.value ?? []));
    next = res?.["@odata.nextLink"];
  }
  return out;
}

/** The signed-in teammate's connected Microsoft account, if any. */
export async function accountOf(userId: string): Promise<ConnectedAccount | null> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(schema.connectedAccounts)
    .where(and(eq(schema.connectedAccounts.userId, userId), eq(schema.connectedAccounts.provider, "microsoft")));
  return row ?? null;
}
