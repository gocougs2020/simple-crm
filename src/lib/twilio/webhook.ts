import "server-only";
import { siteOrigin } from "@/lib/origin";
import { webhookSecrets } from "./config";
import { signingKeyAlgorithm, validTwilioSignature } from "./signature";

/**
 * Reads and verifies a Twilio webhook. Twilio signs the URL it was given, so
 * the check tries the deployment's public origin and the origin the request
 * arrived on (they differ on preview deployments and behind proxies). A
 * webhook signed with a signing key is checked with TWILIO_WEBHOOK_SECRET;
 * any other with the auth token. Returns null when it isn't really from Twilio.
 */
export async function readTwilioWebhook(request: Request): Promise<Record<string, string> | null> {
  const secrets = webhookSecrets();
  const algorithm = signingKeyAlgorithm(request.headers.get("x-twilio-webhooks-signature-settings"));
  const keys = algorithm ? secrets.sharedKeys : secrets.authToken ? [secrets.authToken] : [];
  if (algorithm === "unknown" || !keys.length) {
    console.warn(
      algorithm === "unknown"
        ? "[twilio] webhook refused: signed with an algorithm the CRM doesn't check (use HMAC_SHA256 or HMAC_SHA1)"
        : algorithm
          ? "[twilio] webhook refused: signed with a signing key, but TWILIO_WEBHOOK_SECRET isn't set"
          : "[twilio] webhook refused: signed with the auth token, but TWILIO_AUTH_TOKEN isn't set (set up a webhook signing key, see docs/PHONE.md)",
    );
    return null;
  }
  const form = await request.formData().catch(() => null);
  if (!form) return null;
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") params[k] = v;
  const url = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto") ?? "https";
  const tail = `${url.pathname}${url.search}`;
  const candidates = [...new Set([`${await siteOrigin()}${tail}`, forwardedHost ? `${forwardedProto}://${forwardedHost}${tail}` : null, request.url].filter((x): x is string => !!x))];
  return validTwilioSignature(keys, request.headers.get("x-twilio-signature"), candidates, params, algorithm ?? "sha1") ? params : null;
}
