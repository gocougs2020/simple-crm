import "server-only";
import { headers } from "next/headers";
import { after } from "next/server";
import { lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { hashToken } from "./auth";

const DAY_MS = 86400_000;

/** The visitor's IP. On Vercel the platform sets these headers, so clients can't spoof them. */
export async function clientIp() {
  const h = await headers();
  return h.get("x-real-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

/**
 * Counts one request against a fixed window and reports whether the caller is over the limit.
 * Counters live in Postgres because Vercel Firewall rate-limit windows top out at one hour.
 * Daily windows reset at midnight UTC.
 */
export async function rateLimit(bucket: string, id: string, { limit, windowMs = DAY_MS }: { limit: number; windowMs?: number }) {
  const db = await getDb();
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  const key = `${bucket}:${await hashToken(id)}`;
  const [row] = await db
    .insert(schema.rateLimits)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({ target: [schema.rateLimits.key, schema.rateLimits.windowStart], set: { count: sql`${schema.rateLimits.count} + 1` } })
    .returning({ count: schema.rateLimits.count });

  // Housekeeping after the response: drop counters from finished windows.
  after(() =>
    db
      .delete(schema.rateLimits)
      .where(lt(schema.rateLimits.windowStart, new Date(Date.now() - 2 * DAY_MS)))
      .catch((err) => console.error("[rate-limit] cleanup", err)),
  );

  return { limited: row.count > limit, count: row.count };
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
