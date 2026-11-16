import "server-only";
import { appConfig } from "@/app.config";

/**
 * Twilio: calling from the browser, forwarding incoming calls, and texting
 * (docs/PHONE.md).
 *
 * - TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN: the account. The auth token also
 *   checks Twilio's webhook signatures.
 * - TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_TWIML_APP_SID
 *   (optional): for browser calls. Settings → Phone numbers → Set up calling
 *   creates them and stores them (the secret encrypted) when these are unset.
 */
export function twilioCredentials() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!accountSid || !authToken) return null;
  return { accountSid, authToken };
}

/** Whether the team can call and text here: switched on (`phone.enabled`) and a Twilio account set up. */
export function phoneConfigured() {
  return appConfig.phone.enabled && !!twilioCredentials();
}

export const WEBHOOKS = {
  voice: "/api/webhooks/twilio/voice",
  voiceStatus: "/api/webhooks/twilio/voice/status",
  dial: "/api/webhooks/twilio/voice/dial",
  sms: "/api/webhooks/twilio/sms",
  smsStatus: "/api/webhooks/twilio/sms/status",
} as const;
