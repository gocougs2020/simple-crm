import "server-only";
import { appConfig } from "@/app.config";

/**
 * Twilio: calling from the browser, forwarding incoming calls, and texting
 * (docs/PHONE.md).
 *
 * - TWILIO_ACCOUNT_SID: the account.
 * - TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET: a Standard API key. Every call
 *   to Twilio's API is made with it, and it signs browser-call tokens.
 * - TWILIO_WEBHOOK_SECRET: the secret of a webhook signing key (a Twilio
 *   SharedKey), to verify Twilio's webhooks. A comma-separated list while a
 *   key is being rotated.
 * - TWILIO_AUTH_TOKEN (legacy): works instead of the API key, and verifies
 *   webhooks Twilio signs with it (all of them until a signing key is set up).
 * - TWILIO_TWIML_APP_SID (optional): Settings → Phone numbers → Set up
 *   calling creates the TwiML app (and, with only an auth token, a key) and
 *   stores them when unset.
 */
export function twilioCredentials() {
  const accountSid = env("TWILIO_ACCOUNT_SID");
  if (!accountSid) return null;
  const keySid = env("TWILIO_API_KEY_SID");
  const keySecret = env("TWILIO_API_KEY_SECRET");
  if (keySid && keySecret) return { accountSid, username: keySid, password: keySecret, via: "api-key" as const };
  const authToken = env("TWILIO_AUTH_TOKEN");
  if (authToken) return { accountSid, username: accountSid, password: authToken, via: "auth-token" as const };
  return null;
}

/**
 * What can verify Twilio's webhook signatures: signing-key secrets (for
 * webhooks Twilio signs with a SharedKey) and the auth token (for the rest).
 * Neither is ever sent anywhere.
 */
export function webhookSecrets() {
  const sharedKeys = (env("TWILIO_WEBHOOK_SECRET") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { sharedKeys, authToken: env("TWILIO_AUTH_TOKEN") };
}

/** Whether the team can call and text here: switched on (`phone.enabled`) and a Twilio account set up. */
export function phoneConfigured() {
  return appConfig.phone.enabled && !!twilioCredentials();
}

/** Whether anything can verify Twilio's webhooks. Without it every webhook is refused, so incoming calls and texts don't arrive. */
export function webhooksVerifiable() {
  const s = webhookSecrets();
  return s.sharedKeys.length > 0 || !!s.authToken;
}

const env = (name: string) => process.env[name]?.trim() || undefined;

export const WEBHOOKS = {
  voice: "/api/webhooks/twilio/voice",
  voiceStatus: "/api/webhooks/twilio/voice/status",
  dial: "/api/webhooks/twilio/voice/dial",
  sms: "/api/webhooks/twilio/sms",
  smsStatus: "/api/webhooks/twilio/sms/status",
} as const;
