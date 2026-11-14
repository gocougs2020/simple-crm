import "server-only";
import { timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import {
  ACCESS_TOKEN_SECONDS,
  challengePattern,
  CODE_SECONDS,
  isMetadataDocumentUrl,
  metadataUrlProblem,
  opaque,
  redirectLabel,
  redirectMatches,
  redirectUriProblem,
  REFRESH_TOKEN_DAYS,
  requestedAccess,
  scopeFor,
  sha256,
  tokenPrefixes,
  verifyPkce,
} from "./core";
import { fetchPublicText, PublicFetchError } from "./fetch-public";

/**
 * The OAuth authorization server behind MCP: app registration, codes,
 * tokens and revocation. A teammate approving an app creates a grant: an
 * `api_keys` row of kind "oauth", so connected apps share the key machinery
 * (history says "Sam via ChatGPT", Settings lists and revokes them, the
 * teammate's deactivation stops them). Access tokens last an hour; refresh
 * tokens rotate on every use and a replayed one revokes the grant's tokens.
 */

const { oauthClients, oauthCodes, oauthTokens, apiKeys, users } = schema;

export type OAuthClient = typeof oauthClients.$inferSelect;

/** An error in RFC 6749 form: `{ error, error_description }`. */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

// ─── Clients ─────────────────────────────────────────────────────────────

const authMethods = ["none", "client_secret_post", "client_secret_basic"] as const;

const registration = z.object({
  redirect_uris: z.array(z.string().max(2000)).min(1, "Register at least one redirect URI.").max(20),
  client_name: z.string().trim().max(100).optional(),
  client_uri: z.string().max(500).optional(),
  token_endpoint_auth_method: z.enum(authMethods).optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  scope: z.string().max(200).optional(),
});

const httpsUrl = (v: string | undefined) => (v && /^https:\/\//i.test(v) ? v : null);

function checkRedirects(uris: string[]) {
  for (const uri of uris) {
    const problem = redirectUriProblem(uri);
    if (problem) throw new OAuthError("invalid_redirect_uri", problem);
  }
}

/** Dynamic client registration (RFC 7591). Open, as MCP clients expect: registering grants nothing until a teammate approves the app. */
export async function registerClient(body: unknown) {
  const parsed = registration.safeParse(body);
  if (!parsed.success) throw new OAuthError("invalid_client_metadata", parsed.error.issues[0]?.message ?? "Check the registration.");
  const data = parsed.data;
  checkRedirects(data.redirect_uris);
  const grants = data.grant_types ?? ["authorization_code", "refresh_token"];
  if (grants.some((g) => g !== "authorization_code" && g !== "refresh_token")) throw new OAuthError("invalid_client_metadata", "Only the authorization_code and refresh_token grants are supported.");
  if ((data.response_types ?? ["code"]).some((r) => r !== "code")) throw new OAuthError("invalid_client_metadata", "Only the code response type is supported.");
  const method = data.token_endpoint_auth_method ?? "none";
  const secret = method === "none" ? null : opaque(tokenPrefixes.secret);
  const id = opaque(tokenPrefixes.client).slice(0, 32);
  const name = data.client_name || redirectLabel(data.redirect_uris[0]);
  const db = await getDb();
  const [row] = await db
    .insert(oauthClients)
    .values({ id, name, redirectUris: data.redirect_uris, tokenEndpointAuthMethod: method, secretHash: secret ? sha256(secret) : null, clientUri: httpsUrl(data.client_uri), source: "registered" })
    .returning();
  after(() => pruneUnusedClients().catch((err) => console.error("[oauth] prune", err)));
  return {
    client_id: row.id,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(row.createdAt.getTime() / 1000),
    client_name: row.name,
    redirect_uris: row.redirectUris,
    grant_types: grants,
    response_types: ["code"],
    token_endpoint_auth_method: method,
    ...(row.clientUri ? { client_uri: row.clientUri } : {}),
  };
}

const METADATA_MAX_AGE_MS = 24 * 3600_000;
const metadataDocument = z.object({
  client_id: z.string(),
  client_name: z.string().trim().max(100).optional(),
  client_uri: z.string().max(500).optional(),
  redirect_uris: z.array(z.string().max(2000)).min(1).max(20),
  token_endpoint_auth_method: z.string().optional(),
});

/**
 * An app identified by a URL to its metadata document. Only fetched for a
 * signed-in teammate on the consent page; the document comes through
 * fetchPublicText (public addresses only, checked at connect time, no
 * redirects, 5 seconds, 64 KB). Every failure reads the same, so the fetch
 * can't be used to probe what's out there.
 */
async function metadataClient(url: string): Promise<OAuthClient> {
  const problem = metadataUrlProblem(url);
  if (problem) throw new OAuthError("invalid_client", problem);
  const db = await getDb();
  const [cached] = await db.select().from(oauthClients).where(eq(oauthClients.id, url));
  if (cached?.metadataFetchedAt && Date.now() - cached.metadataFetchedAt.getTime() < METADATA_MAX_AGE_MS) return cached;

  const unreadable = new OAuthError("invalid_client", "The app's metadata document couldn't be read. Check the app's client_id URL.");
  let text: string;
  try {
    text = await fetchPublicText(url);
  } catch (err) {
    if (err instanceof PublicFetchError) throw unreadable;
    throw err;
  }
  let doc: z.infer<typeof metadataDocument>;
  try {
    doc = metadataDocument.parse(JSON.parse(text));
  } catch {
    throw unreadable;
  }
  if (doc.client_id !== url) throw new OAuthError("invalid_client", "The app's metadata document names a different client_id.");
  if (doc.token_endpoint_auth_method && doc.token_endpoint_auth_method !== "none") throw new OAuthError("invalid_client", "Apps described by a metadata document must be public clients.");
  checkRedirects(doc.redirect_uris);
  const values = { name: doc.client_name || new URL(url).hostname, redirectUris: doc.redirect_uris, clientUri: httpsUrl(doc.client_uri), metadataFetchedAt: new Date() };
  const [row] = await db
    .insert(oauthClients)
    .values({ id: url, source: "metadata_document", tokenEndpointAuthMethod: "none", ...values })
    .onConflictDoUpdate({ target: oauthClients.id, set: values })
    .returning();
  return row;
}

/**
 * The app behind a client_id. Metadata documents are only fetched when
 * `fetchMetadata` is set (the consent page, for a signed-in teammate); the
 * unauthenticated token endpoints use what was stored then, so they can't be
 * used to make this server fetch URLs.
 */
export async function getClient(clientId: string | null | undefined, { fetchMetadata = false } = {}): Promise<OAuthClient | null> {
  if (!clientId || clientId.length > 500) return null;
  if (fetchMetadata && isMetadataDocumentUrl(clientId)) return metadataClient(clientId);
  const db = await getDb();
  const [row] = await db.select().from(oauthClients).where(eq(oauthClients.id, clientId));
  return row ?? null;
}

/** Checks a confidential app's secret. Public apps (most MCP clients) prove themselves with PKCE instead. */
function authenticateClient(client: OAuthClient, secret: string | null) {
  if (client.tokenEndpointAuthMethod === "none") return;
  if (!secret || !client.secretHash) throw new OAuthError("invalid_client", "This app must authenticate with its client secret.", 401);
  const a = Buffer.from(sha256(secret));
  const b = Buffer.from(client.secretHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new OAuthError("invalid_client", "The client secret is wrong.", 401);
}

// ─── Authorization requests ──────────────────────────────────────────────

export type AuthorizationRequest = {
  client: OAuthClient;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  readOnly: boolean;
  resource: string | null;
};

/**
 * Checks an authorization request. Every problem is shown to the person on
 * this site, never sent back to the app's redirect URI: anyone can register
 * an app, so redirecting errors would let a crafted link bounce people from
 * this trusted address to anywhere (RFC 9700 §4.11.2). The app only hears
 * back after the person has seen the consent screen and decided.
 */
export async function checkAuthorizationRequest(params: Record<string, string | undefined>, origin: string): Promise<{ ok: true; request: AuthorizationRequest } | { ok: false; message: string }> {
  let client: OAuthClient | null;
  try {
    client = await getClient(params.client_id, { fetchMetadata: true });
  } catch (err) {
    if (err instanceof OAuthError) return { ok: false, message: err.description };
    throw err;
  }
  const retry = "Start connecting again from the app.";
  if (!client) return { ok: false, message: `This app isn't registered with this CRM. ${retry}` };
  const redirectUri = params.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri)) return { ok: false, message: `The app sent a return address it didn't register. ${retry}` };
  if (params.response_type !== "code") return { ok: false, message: `The app asked for a kind of sign-in this CRM doesn't support (response_type must be code). ${retry}` };
  if (!params.code_challenge || !challengePattern.test(params.code_challenge) || params.code_challenge_method !== "S256") {
    return { ok: false, message: `The app didn't send the security check this CRM requires (PKCE with S256). ${retry}` };
  }
  let resource: string | null = null;
  if (params.resource) {
    if (!sameOrigin(params.resource, origin)) return { ok: false, message: `The app asked for access to a different server. ${retry}` };
    resource = params.resource;
  }
  return { ok: true, request: { client, redirectUri, state: params.state ?? null, codeChallenge: params.code_challenge, resource, ...requestedAccess(params.scope) } };
}

/** After the teammate approves: a single-use code bound to the app, redirect URI and PKCE challenge. */
export async function issueCode(req: AuthorizationRequest, userId: string, readOnly: boolean) {
  const code = opaque(tokenPrefixes.code);
  const db = await getDb();
  await db.insert(oauthCodes).values({
    codeHash: sha256(code),
    clientId: req.client.id,
    userId,
    redirectUri: req.redirectUri,
    codeChallenge: req.codeChallenge,
    readOnly,
    resource: req.resource,
    expiresAt: new Date(Date.now() + CODE_SECONDS * 1000),
  });
  return code;
}

// ─── Grants and tokens ───────────────────────────────────────────────────

/** One grant per teammate and app: approving again updates its access instead of piling up connections. */
async function grantFor(client: OAuthClient, userId: string, readOnly: boolean, redirectUri: string) {
  const db = await getDb();
  const where = and(eq(apiKeys.kind, "oauth"), eq(apiKeys.userId, userId), eq(apiKeys.oauthClientId, client.id), isNull(apiKeys.revokedAt));
  const [existing] = await db.select().from(apiKeys).where(where).limit(1);
  if (existing) {
    await db.update(apiKeys).set({ readOnly, name: client.name }).where(eq(apiKeys.id, existing.id));
    return existing.id;
  }
  // Some apps register afresh each time they connect. The same app on the same website replaces its older connection
  // rather than piling up; desktop apps (loopback, app schemes) are left alone, since one per computer is expected.
  const label = redirectLabel(redirectUri);
  if (/^https:\/\//i.test(redirectUri)) {
    const stale = await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.kind, "oauth"), eq(apiKeys.userId, userId), eq(apiKeys.name, client.name), eq(apiKeys.prefix, label.slice(0, 60)), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    for (const g of stale) await revokeGrantTokens(g.id);
  }
  const [row] = await db
    .insert(apiKeys)
    .values({
      name: client.name,
      kind: "oauth",
      userId,
      // Shown in lists as where the app lives. The hash is of a throwaway value: grants are only ever used through their tokens.
      prefix: label.slice(0, 60),
      tokenHash: sha256(opaque("unused_")),
      createdBy: userId,
      readOnly,
      oauthClientId: client.id,
    })
    .returning({ id: apiKeys.id });
  return row.id;
}

async function issueTokens(grantId: string, readOnly: boolean) {
  const access = opaque(tokenPrefixes.access);
  const refresh = opaque(tokenPrefixes.refresh);
  const now = Date.now();
  const db = await getDb();
  await db.insert(oauthTokens).values([
    { tokenHash: sha256(access), kind: "access", grantId, expiresAt: new Date(now + ACCESS_TOKEN_SECONDS * 1000) },
    { tokenHash: sha256(refresh), kind: "refresh", grantId, expiresAt: new Date(now + REFRESH_TOKEN_DAYS * 86400_000) },
  ]);
  housekeeping();
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TOKEN_SECONDS, refresh_token: refresh, scope: scopeFor(readOnly) };
}

async function revokeGrantTokens(grantId: string) {
  const db = await getDb();
  await db
    .update(oauthTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(oauthTokens.grantId, grantId), isNull(oauthTokens.revokedAt)));
}

/** Drops expired codes and tokens a day after they expire, after the response. */
function housekeeping() {
  after(async () => {
    const db = await getDb();
    const dayAgo = new Date(Date.now() - 86400_000);
    await db.delete(oauthCodes).where(lt(oauthCodes.expiresAt, dayAgo));
    await db.delete(oauthTokens).where(lt(oauthTokens.expiresAt, dayAgo));
  });
}

function sameOrigin(url: string, origin: string) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

type ClientCredentials = { clientId: string | null; secret: string | null };

async function activeUser(userId: string | null) {
  if (!userId) return null;
  const db = await getDb();
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  return u && !u.deactivatedAt ? u : null;
}

/** authorization_code grant: checks the code, the app, the redirect URI, the PKCE verifier and the resource, once. */
export async function exchangeCode(form: URLSearchParams, creds: ClientCredentials, origin: string) {
  const code = form.get("code");
  if (!code || !creds.clientId) throw new OAuthError("invalid_request", "Send code and client_id.");
  const client = await getClient(creds.clientId);
  if (!client) throw new OAuthError("invalid_client", "This app isn't registered.", 401);
  authenticateClient(client, creds.secret);

  const db = await getDb();
  const hash = sha256(code);
  const [row] = await db
    .update(oauthCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(oauthCodes.codeHash, hash), isNull(oauthCodes.usedAt)))
    .returning();
  if (!row) {
    // A code used twice may have been stolen: revoke what it was exchanged for.
    const [used] = await db.select({ grantId: oauthCodes.grantId }).from(oauthCodes).where(eq(oauthCodes.codeHash, hash));
    if (used?.grantId) await revokeGrantTokens(used.grantId);
    throw new OAuthError("invalid_grant", "This code was already used or doesn't exist. Connect again.");
  }
  if (row.clientId !== client.id) throw new OAuthError("invalid_grant", "This code was issued to another app.");
  if (row.expiresAt <= new Date()) throw new OAuthError("invalid_grant", "This code expired. Connect again.");
  if (form.get("redirect_uri") && form.get("redirect_uri") !== row.redirectUri) throw new OAuthError("invalid_grant", "The redirect_uri doesn't match the one used to get the code.");
  if (!verifyPkce(form.get("code_verifier"), row.codeChallenge)) throw new OAuthError("invalid_grant", "The code_verifier doesn't match the code_challenge.");
  const resource = form.get("resource");
  if (resource && ((row.resource && resource !== row.resource) || !sameOrigin(resource, origin))) throw new OAuthError("invalid_target", "Tokens can only be issued for this server.");
  if (!(await activeUser(row.userId))) throw new OAuthError("invalid_grant", "The teammate who approved this app was deactivated.");

  const grantId = await grantFor(client, row.userId, row.readOnly, row.redirectUri);
  await db.update(oauthCodes).set({ grantId }).where(eq(oauthCodes.codeHash, hash));
  return issueTokens(grantId, row.readOnly);
}

/** refresh_token grant, with rotation: each refresh token works once, and a replayed one revokes the grant's tokens. */
export async function refreshTokens(form: URLSearchParams, creds: ClientCredentials) {
  const token = form.get("refresh_token");
  if (!token || !creds.clientId) throw new OAuthError("invalid_request", "Send refresh_token and client_id.");
  const db = await getDb();
  const [row] = await db
    .select({ token: oauthTokens, grant: apiKeys })
    .from(oauthTokens)
    .innerJoin(apiKeys, eq(apiKeys.id, oauthTokens.grantId))
    .where(and(eq(oauthTokens.tokenHash, sha256(token)), eq(oauthTokens.kind, "refresh")));
  if (!row || row.grant.oauthClientId !== creds.clientId) throw new OAuthError("invalid_grant", "This refresh token isn't valid. Connect again.");
  const client = await getClient(creds.clientId);
  if (!client) throw new OAuthError("invalid_client", "This app isn't registered.", 401);
  authenticateClient(client, creds.secret);
  if (row.token.revokedAt) {
    await revokeGrantTokens(row.grant.id);
    throw new OAuthError("invalid_grant", "This refresh token was already used. Connect again.");
  }
  if (row.token.expiresAt <= new Date() || row.grant.revokedAt) throw new OAuthError("invalid_grant", "This connection ended. Connect again.");
  if (!(await activeUser(row.grant.userId))) throw new OAuthError("invalid_grant", "The teammate who approved this app was deactivated.");
  const spent = await db
    .update(oauthTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(oauthTokens.tokenHash, row.token.tokenHash), isNull(oauthTokens.revokedAt)))
    .returning({ hash: oauthTokens.tokenHash });
  if (!spent.length) throw new OAuthError("invalid_grant", "This refresh token was already used. Connect again.");
  return issueTokens(row.grant.id, row.grant.readOnly);
}

/** RFC 7009. Always succeeds from the caller's point of view; revoking a refresh token also ends the access tokens from the same grant. */
export async function revokeToken(token: string | null, creds: ClientCredentials) {
  if (!token) return;
  const db = await getDb();
  const [row] = await db
    .select({ token: oauthTokens, clientId: apiKeys.oauthClientId })
    .from(oauthTokens)
    .innerJoin(apiKeys, eq(apiKeys.id, oauthTokens.grantId))
    .where(eq(oauthTokens.tokenHash, sha256(token)));
  if (!row || (creds.clientId && row.clientId !== creds.clientId)) return;
  if (row.token.kind === "refresh") await revokeGrantTokens(row.token.grantId);
  else await db.update(oauthTokens).set({ revokedAt: new Date() }).where(eq(oauthTokens.tokenHash, row.token.tokenHash));
}

/** The grant and teammate behind an access token, if it's live. */
export async function accessTokenGrant(token: string) {
  const db = await getDb();
  const [row] = await db
    .select({ token: oauthTokens, grant: apiKeys, user: users })
    .from(oauthTokens)
    .innerJoin(apiKeys, eq(apiKeys.id, oauthTokens.grantId))
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(and(eq(oauthTokens.tokenHash, sha256(token)), eq(oauthTokens.kind, "access")))
    .limit(1);
  if (!row) return { ok: false as const, message: "That access token isn't valid. Connect again." };
  if (row.token.revokedAt || row.grant.revokedAt) return { ok: false as const, message: "This connection was ended. Connect again." };
  if (row.token.expiresAt <= new Date()) return { ok: false as const, message: "That access token expired. Refresh it or connect again." };
  if (row.user.deactivatedAt) return { ok: false as const, message: "The teammate this app acts for was deactivated." };
  return { ok: true as const, grant: row.grant, user: row.user };
}

/** Disconnecting an app ends its tokens too (they'd be refused anyway; this keeps the table honest). */
export async function endGrant(grantId: string) {
  await revokeGrantTokens(grantId);
}

/** The client id and secret from HTTP Basic or the form body. */
export function clientCredentials(headers: Headers, form: URLSearchParams): ClientCredentials {
  const auth = headers.get("authorization");
  const basic = auth && /^Basic\s+(.+)$/i.exec(auth);
  if (basic) {
    const decoded = Buffer.from(basic[1], "base64").toString("utf8");
    const i = decoded.indexOf(":");
    if (i > 0) return { clientId: decodeURIComponent(decoded.slice(0, i)), secret: decodeURIComponent(decoded.slice(i + 1)) };
  }
  return { clientId: form.get("client_id"), secret: form.get("client_secret") };
}

/** Removes apps nobody approved within a day of registering, so open registration can't grow the table forever. */
async function pruneUnusedClients() {
  const db = await getDb();
  const dayAgo = new Date(Date.now() - 86400_000);
  await db
    .delete(oauthClients)
    .where(and(lt(oauthClients.createdAt, dayAgo), sql`not exists (select 1 from api_keys k where k.oauth_client_id = ${oauthClients.id})`));
}
