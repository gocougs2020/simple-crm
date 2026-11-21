import "server-only";
import { and, inArray, isNotNull, lt, ne, or } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { pruneForwards } from "@/lib/forwarding/inbound";

const DAY_MS = 86_400_000;

/** Sent notifications are kept this long: they're only there to stop a push or agenda email going out twice. */
export const NOTIFICATION_DAYS = 90;
/** Rate-limit counters from windows that ended this long ago are dropped (the longest window is a day). */
export const RATE_LIMIT_DAYS = 2;
/** A finished background run's request and answer text are cleared this long after it left the agent panel. The row and its cost stay: history refers to it. */
export const RUN_TEXT_DAYS = 90;

/**
 * Housekeeping, once a day from the cron dispatcher (src/lib/cron-tick.ts):
 * old notifications, expired invite and reset links, expired sessions,
 * finished rate-limit windows, old forwarded-email text (pruneForwards) and
 * old background runs' text. Never history (`events`): that's the product.
 */
export async function pruneDaily(now = new Date()) {
  const db = await getDb();
  const before = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const run = async <T>(what: string, work: () => Promise<T>) =>
    work().catch((err) => {
      console.error(`[prune] ${what}`, err);
      return null;
    });
  const [notifications, tokens, sessions, rateLimits, forwards, runs] = await Promise.all([
    run("notifications", async () => (await db.delete(schema.notifications).where(lt(schema.notifications.createdAt, before(NOTIFICATION_DAYS))).returning({ id: schema.notifications.id })).length),
    run("auth tokens", async () => (await db.delete(schema.authTokens).where(lt(schema.authTokens.expiresAt, now)).returning({ id: schema.authTokens.tokenHash })).length),
    run("sessions", async () => (await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, now)).returning({ id: schema.sessions.id })).length),
    run("rate limits", async () => (await db.delete(schema.rateLimits).where(lt(schema.rateLimits.windowStart, before(RATE_LIMIT_DAYS))).returning({ key: schema.rateLimits.key })).length),
    run("forwards", async () => (await pruneForwards(now)).cleared),
    run("agent runs", async () => {
      const r = schema.agentRuns;
      const cleared = await db
        .update(r)
        .set({ prompt: "", result: null })
        .where(and(inArray(r.status, ["done", "failed", "cancelled"]), isNotNull(r.hideAt), lt(r.hideAt, before(RUN_TEXT_DAYS)), or(ne(r.prompt, ""), isNotNull(r.result))))
        .returning({ id: r.id });
      return cleared.length;
    }),
  ]);
  return { notifications, tokens, sessions, rateLimits, forwardsCleared: forwards, runsCleared: runs };
}
