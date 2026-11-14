import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";

/**
 * OAuth 2.1 for MCP clients (Claude, ChatGPT and any agent that follows the
 * MCP authorization spec): the rules that don't touch the database, so
 * they're tested directly. See docs/API.md.
 */

export const ACCESS_TOKEN_SECONDS = 60 * 60;
export const REFRESH_TOKEN_DAYS = 30;
export const CODE_SECONDS = 5 * 60;

export const SCOPES = { read: "crm:read", write: "crm:write" } as const;
export const scopesSupported = [SCOPES.read, SCOPES.write];

export const tokenPrefixes = { access: "crm_at_", refresh: "crm_rt_", code: "crm_ac_", client: "crmc_", secret: "crm_cs_" } as const;

export const opaque = (prefix: string) => prefix + randomBytes(32).toString("base64url");
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

// ─── PKCE (RFC 7636): S256 only ──────────────────────────────────────────

const verifierPattern = /^[A-Za-z0-9\-._~]{43,128}$/;
export const challengePattern = /^[A-Za-z0-9_-]{43}$/;

export function pkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function verifyPkce(verifier: string | null | undefined, challenge: string) {
  if (!verifier || !verifierPattern.test(verifier)) return false;
  const a = Buffer.from(pkceChallenge(verifier));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ─── Scopes ──────────────────────────────────────────────────────────────

/** What the app asked for: read-only when it asked only for crm:read; otherwise reading and changing (still capped by the teammate's role). */
export function requestedAccess(scope: string | null | undefined) {
  const asked = new Set((scope ?? "").split(/\s+/).filter(Boolean));
  const readOnly = asked.has(SCOPES.read) && !asked.has(SCOPES.write);
  return { readOnly };
}

export const scopeFor = (readOnly: boolean) => (readOnly ? SCOPES.read : `${SCOPES.read} ${SCOPES.write}`);

// ─── Redirect URIs ───────────────────────────────────────────────────────

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Schemes that run code or read local data when navigated to. Never a redirect target. */
const blockedSchemes = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:", "ftp:", "ws:", "wss:", "filesystem:", "view-source:", "chrome:", "intent:"]);

export const isLoopback = (u: URL) => u.protocol === "http:" && loopbackHosts.has(u.hostname);

/**
 * Whether an app may register this redirect URI: https anywhere, http only
 * on the loopback interface (desktop apps and CLIs, RFC 8252), or an app's
 * own scheme (cursor://, vscode://). Returns why not, or null.
 */
export function redirectUriProblem(uri: string): string | null {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return `${uri} isn't a valid URL.`;
  }
  if (u.hash) return "Redirect URIs can't have a fragment.";
  if (u.username || u.password) return "Redirect URIs can't carry credentials.";
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:") return isLoopback(u) ? null : "Use https, or http only on localhost.";
  if (blockedSchemes.has(u.protocol)) return `${u.protocol} redirect URIs aren't allowed.`;
  if (!/^[a-z][a-z0-9+.-]*:$/.test(u.protocol)) return `${uri} isn't a valid redirect URI.`;
  return null;
}

/** Whether a redirect URI in a request matches a registered one: exactly, or for loopback addresses on any port (RFC 8252 §7.3). */
export function redirectMatches(registered: string[], requested: string) {
  if (registered.includes(requested)) return true;
  let r: URL;
  try {
    r = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopback(r)) return false;
  return registered.some((reg) => {
    try {
      const u = new URL(reg);
      return isLoopback(u) && u.hostname === r.hostname && u.pathname === r.pathname && u.search === r.search;
    } catch {
      return false;
    }
  });
}

/** The redirect back to the app, with the code (or error), state and issuer (RFC 9207). */
export function redirectWith(redirectUri: string, params: Record<string, string | undefined | null>) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return u.toString();
}

/** What to show people about where they'll be sent: the host, or the app scheme. */
export function redirectLabel(uri: string) {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:" || u.protocol === "http:") return isLoopback(u) ? "an app on this computer" : u.host;
    return `the ${u.protocol.replace(/:$/, "")} app`;
  } catch {
    return uri;
  }
}

// ─── Client metadata documents ───────────────────────────────────────────

/** A client_id that is a URL to the app's metadata (the MCP 2025-11-25 alternative to registration). */
export function isMetadataDocumentUrl(clientId: string) {
  return clientId.startsWith("https://");
}

/** Whether a metadata document URL is safe to fetch: https, a path, no credentials, and not a private address. Returns why not, or null. */
export function metadataUrlProblem(clientId: string): string | null {
  let u: URL;
  try {
    u = new URL(clientId);
  } catch {
    return "The client_id isn't a valid URL.";
  }
  if (u.protocol !== "https:") return "Client metadata documents must be served over https.";
  if (u.username || u.password || u.hash) return "The client_id URL can't have credentials or a fragment.";
  if (u.pathname === "/" || !u.pathname) return "The client_id URL needs a path.";
  if (u.port && u.port !== "443") return "Client metadata documents must be on the standard https port.";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  // Apps publish metadata on a domain name. IP literals (in any spelling the URL parser accepts) are refused outright.
  if (isIP(host)) return "The client_id must use a domain name, not an IP address.";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local") || !host.includes(".")) {
    return "The client_id can't point at a private address.";
  }
  return null;
}

/**
 * Addresses a server should never fetch for a stranger: loopback, private,
 * link-local, carrier-grade NAT, documentation, multicast and reserved, plus
 * every IPv6 range that wraps an IPv4 address (mapped, compatible, 6to4,
 * NAT64, Teredo), which are blocked whole rather than unwrapped. BlockList
 * parses every spelling of an address (::ffff:7f00:1 is ::ffff:127.0.0.1),
 * so there's no string matching to get around. One list per family: a
 * BlockList checks IPv4 addresses against IPv6 rules as mapped addresses, so
 * a shared list holding ::ffff:0:0/96 would block every IPv4 address.
 */
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [base, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  blockedV4.addSubnet(base, bits, "ipv4");
for (const [base, bits] of [
  ["::", 96], // unspecified, loopback and IPv4-compatible
  ["::ffff:0:0", 96], // IPv4-mapped
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const)
  blockedV6.addSubnet(base, bits, "ipv6");

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return blockedV4.check(ip, "ipv4");
  if (kind === 6) return blockedV6.check(ip, "ipv6");
  // Not an address at all: treat as unsafe.
  return true;
}

// ─── Discovery documents ─────────────────────────────────────────────────

export const mcpResource = (origin: string) => `${origin}/api/mcp`;
export const resourceMetadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource/api/mcp`;

/** RFC 9728: tells an MCP client which authorization server issues tokens for this server. */
export function protectedResourceMetadata(origin: string, name: string) {
  return {
    resource: mcpResource(origin),
    authorization_servers: [origin],
    scopes_supported: scopesSupported,
    bearer_methods_supported: ["header"],
    resource_name: name,
    resource_documentation: `${origin}/developers#mcp`,
  };
}

/** RFC 8414: where to register, send people to approve, and trade codes for tokens. */
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    revocation_endpoint: `${origin}/api/oauth/revoke`,
    scopes_supported: scopesSupported,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
    service_documentation: `${origin}/developers#mcp`,
  };
}
