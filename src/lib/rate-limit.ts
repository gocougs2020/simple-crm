import "server-only";
import { headers } from "next/headers";
import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { hashToken } from "./auth";

const DAY_MS = 86400_000;

/** The visitor's IP. On Vercel the platform sets these headers, so clients can't spoof them. */
export async function clientIp() {
  const h = await headers();
  return h.get("x-real-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

type Limit = { bucket: string; id: string; limit: number; windowMs?: number; cost?: number };

/**
 * Counts one request against several fixed windows in one statement (an
 * upsert per window) and reports, for each, whether the caller is over its
 * limit. Each limit behaves exactly as `rateLimit` alone would.
 * Counters from finished windows are dropped by the daily prune (src/lib/daily-prune.ts).
 */
export async function rateLimits(limits: Limit[]) {
  const db = await getDb();
  const now = Date.now();
  const rows = await Promise.all(
    limits.map(async (l) => {
      const windowMs = l.windowMs ?? DAY_MS;
      return { key: `${l.bucket}:${await hashToken(l.id)}`, windowStart: new Date(Math.floor(now / windowMs) * windowMs), count: l.cost ?? 1 };
    }),
  );
  const counted = await db
    .insert(schema.rateLimits)
    .values(rows)
    // `excluded.count` is this request's cost for that window.
    .onConflictDoUpdate({ target: [schema.rateLimits.key, schema.rateLimits.windowStart], set: { count: sql`${schema.rateLimits.count} + excluded.count` } })
    .returning({ key: schema.rateLimits.key, count: schema.rateLimits.count });
  return limits.map((l, i) => {
    const count = counted.find((c) => c.key === rows[i].key)?.count ?? rows[i].count;
    return { limited: count > l.limit, count };
  });
}

/**
 * Counts one request against a fixed window and reports whether the caller is over the limit.
 * Counters live in Postgres because Vercel Firewall rate-limit windows top out at one hour.
 * Daily windows reset at midnight UTC. `cost` counts one request as several (an MCP batch of tool calls).
 */
export async function rateLimit(bucket: string, id: string, { limit, windowMs = DAY_MS, cost = 1 }: { limit: number; windowMs?: number; cost?: number }) {
  const [r] = await rateLimits([{ bucket, id, limit, windowMs, cost }]);
  return r;
}

/**
 * Sign-in attempts: 30 per IP per 15 minutes (a shared office stays well
 * under that), and 10 per email per 15 minutes, so nobody can guess one
 * teammate's password from many IPs. Returns the message to show, or null.
 */
export async function signInLimitError(email: string) {
  const window = { windowMs: 15 * 60_000 };
  const [ip, account] = await Promise.all([
    rateLimit("sign-in-ip", await clientIp(), { limit: 30, ...window }),
    rateLimit("sign-in-email", email, { limit: 10, ...window }),
  ]);
  return ip.limited || account.limited ? "Too many sign-in attempts. Wait 15 minutes, or reset your password." : null;
}

/** Password-reset emails: 5 per address and 20 per IP per day, so nobody can flood an inbox. */
export async function resetLimitError(email: string) {
  const [ip, account] = await Promise.all([rateLimit("reset-ip", await clientIp(), { limit: 20 }), rateLimit("reset-email", email, { limit: 5 })]);
  return ip.limited || account.limited ? "Too many reset requests today. Try again tomorrow, or ask an admin to send you a new invite." : null;
}
