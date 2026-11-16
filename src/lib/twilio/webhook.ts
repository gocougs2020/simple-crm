import "server-only";
import { siteOrigin } from "@/lib/origin";
import { twilioCredentials } from "./config";
import { validTwilioSignature } from "./signature";

/**
 * Reads and verifies a Twilio webhook. Twilio signs the URL it was given, so
 * the check tries the deployment's public origin and the origin the request
 * arrived on (they differ on preview deployments and behind proxies).
 * Returns null when it isn't really from Twilio.
 */
export async function readTwilioWebhook(request: Request): Promise<Record<string, string> | null> {
  const creds = twilioCredentials();
  if (!creds) return null;
  const form = await request.formData().catch(() => null);
  if (!form) return null;
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") params[k] = v;
  const url = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto") ?? "https";
  const tail = `${url.pathname}${url.search}`;
  const candidates = [...new Set([`${await siteOrigin()}${tail}`, forwardedHost ? `${forwardedProto}://${forwardedHost}${tail}` : null, request.url].filter((x): x is string => !!x))];
  return validTwilioSignature(creds.authToken, request.headers.get("x-twilio-signature"), candidates, params) ? params : null;
}
