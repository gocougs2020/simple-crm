import "server-only";
import { headers } from "next/headers";

/** Absolute origin for links in emails. Prefers the request host so preview deployments link to themselves. */
export async function siteOrigin() {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  try {
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    if (host) return `${h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https")}://${host}`;
  } catch {
    // Outside a request (cron jobs): fall through.
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return "http://localhost:3200";
}

/**
 * This deployment's own origin, for calls it makes to itself or hands to its
 * background agent (src/lib/agent/runs.ts). Never taken from a request's Host
 * header outside local development: a forged header must not be able to point
 * signed tokens, or the deployment-protection bypass, at another server.
 */
export async function internalOrigin() {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  if (process.env.VERCEL) {
    const host = process.env.VERCEL_ENV === "production" ? (process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL) : process.env.VERCEL_URL;
    if (host) return `https://${host}`;
    throw new Error("Set NEXT_PUBLIC_SITE_URL so the deployment knows its own address.");
  }
  try {
    const host = (await headers()).get("host");
    if (host && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return `http://${host}`;
  } catch {
    // Outside a request: fall through.
  }
  return `http://localhost:${process.env.PORT ?? 3200}`;
}
