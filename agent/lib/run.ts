import { RUN_TOKEN_PREFIX, signRunToken, type RunAudience, type RunClaims } from "../../src/lib/agent/run-token";

/**
 * The background run a session belongs to, read from the caller the channel
 * accepted (agent/channels/eve.ts). Null for a session nobody started through
 * the CRM, such as one from the eve terminal in development.
 */
type Caller = { readonly principalId: string; readonly attributes: Readonly<Record<string, string | readonly string[]>> } | null | undefined;

export function runOf(caller: Caller): RunClaims | null {
  const runId = caller?.attributes.runId;
  const origin = caller?.attributes.origin;
  if (!caller || typeof runId !== "string" || typeof origin !== "string") return null;
  return { userId: caller.principalId, runId, origin };
}

/** A fresh bearer token for calling the CRM as this run. */
export async function crmToken(run: RunClaims, audience: Extract<RunAudience, "crm" | "report">, ttlSeconds = 600) {
  return `${RUN_TOKEN_PREFIX}${await signRunToken(audience, run, ttlSeconds)}`;
}

/** Lets the agent reach a preview deployment behind Vercel's Deployment Protection. */
export function protectionBypass(): Record<string, string> {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  return secret ? { "x-vercel-protection-bypass": secret } : {};
}
