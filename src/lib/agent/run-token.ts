import { hkdfSync } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

/**
 * Tokens that tie a background run (docs/AGENT.md) to the teammate who asked
 * for it. The CRM and the eve agent (agent/) are two services of one
 * deployment and share one secret, so each can check what the other sends:
 *
 * - "eve": the CRM starts a run. The agent's channel accepts it and runs the
 *   session as that teammate.
 * - "crm": the agent calls the CRM's MCP endpoint during the run. The CRM
 *   turns it into "the teammate, via Assistant", with the teammate's role as
 *   it is at that moment.
 * - "report": the agent tells the CRM how a run ended and what it cost.
 *
 * Tokens are short-lived and name one run, so they stop working when the run
 * is cancelled or finished. No server-only import: the agent bundles this file.
 */

export type RunAudience = "eve" | "crm" | "report";
export type RunClaims = {
  /** The teammate the run acts as. */
  userId: string;
  runId: string;
  /** The CRM's origin, so the agent calls back the deployment that started it. */
  origin: string;
};

/** What a run token starts with when it's sent to the CRM as a bearer credential. */
export const RUN_TOKEN_PREFIX = "crm_run_";
const ISSUER = "simple-crm";

function secret() {
  const base = process.env.AGENT_RUN_SECRET?.trim() || process.env.AUTH_SECRET?.trim();
  if (!base) {
    if (process.env.VERCEL) throw new Error("Set AUTH_SECRET (or AGENT_RUN_SECRET) so background runs can be signed.");
    return new Uint8Array(hkdfSync("sha256", "local-development-secret-change-me", "simple-crm", "agent-run", 32));
  }
  return new Uint8Array(hkdfSync("sha256", base, "simple-crm", "agent-run", 32));
}

export async function signRunToken(audience: RunAudience, claims: RunClaims, ttlSeconds: number) {
  return new SignJWT({ run: claims.runId, origin: claims.origin })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(secret());
}

/** The claims of a valid, unexpired token for this audience, or null. */
export async function verifyRunToken(audience: RunAudience, token: string | null | undefined): Promise<RunClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { issuer: ISSUER, audience, algorithms: ["HS256"] });
    if (typeof payload.sub !== "string" || typeof payload.run !== "string" || typeof payload.origin !== "string") return null;
    return { userId: payload.sub, runId: payload.run, origin: payload.origin };
  } catch {
    return null;
  }
}
