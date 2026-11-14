import "server-only";
import { headers } from "next/headers";
import { siteUrlOrigin } from "./site-url";

/** Absolute origin for links in emails. Prefers the request host so preview deployments link to themselves. */
export async function siteOrigin() {
  const configured = process.env.NEXT_PUBLIC_SITE_URL ? siteUrlOrigin(process.env.NEXT_PUBLIC_SITE_URL) : null;
  if (configured) return configured;
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
