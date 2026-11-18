import "server-only";
import { getUser, type User } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";

/**
 * The checks every /api/agent route runs first. The agent runs on the
 * teammate's signed-in session (the cookie), so these routes also refuse
 * requests started by another site's pages.
 */

export const agentError = (status: number, message: string, headers?: HeadersInit) => Response.json({ error: status, message }, { status, headers: { "Cache-Control": "no-store", ...headers } });

/** Per teammate: messages, transcriptions and voice tool calls together. Generous for a person, a wall for a runaway script. */
const LIMIT_PER_MINUTE = 40;
const LIMIT_PER_DAY = 2_000;

export async function agentRequest(request: Request, opts: { cost?: number } = {}): Promise<{ ok: true; user: User } | { ok: false; response: Response }> {
  if (request.headers.get("sec-fetch-site") === "cross-site") return { ok: false, response: agentError(403, "Use the agent from inside the CRM.") };
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== new URL(request.url).host && new URL(origin).host !== request.headers.get("x-forwarded-host")) return { ok: false, response: agentError(403, "Use the agent from inside the CRM.") };
    } catch {
      return { ok: false, response: agentError(403, "Use the agent from inside the CRM.") };
    }
  }
  const user = await getUser();
  if (!user) return { ok: false, response: agentError(401, "Your session ended. Sign in again to continue.") };
  const cost = opts.cost ?? 1;
  const [minute, day] = await Promise.all([
    rateLimit("agent-minute", user.id, { limit: LIMIT_PER_MINUTE, windowMs: 60_000, cost }),
    rateLimit("agent-day", user.id, { limit: LIMIT_PER_DAY, cost }),
  ]);
  if (minute.limited) return { ok: false, response: agentError(429, "That's a lot of requests in a minute. Wait a moment and try again.", { "Retry-After": "60" }) };
  if (day.limited) return { ok: false, response: agentError(429, "You've reached today's agent limit. It resets at midnight UTC.") };
  return { ok: true, user };
}

/** Reads a JSON body of at most `max` bytes. */
export async function readJson(request: Request, max = 256_000): Promise<unknown> {
  const text = await request.text();
  if (text.length > max) throw new RangeError("too large");
  return JSON.parse(text);
}
