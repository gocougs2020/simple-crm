import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Whether a request comes from Vercel Cron (Authorization: Bearer CRON_SECRET).
 * Compares hashes so the check takes the same time however much of the secret
 * matches. Without CRON_SECRET, only local development is let in.
 */
export function cronAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return !process.env.VERCEL;
  const got = createHash("sha256").update(request.headers.get("authorization") ?? "").digest();
  const want = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(got, want);
}
