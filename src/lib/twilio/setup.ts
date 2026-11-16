import "server-only";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { PhoneSettings } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { getWorkspace } from "@/lib/workspace";
import { twilio, twilioMessaging, TwilioError } from "./client";
import { twilioCredentials, WEBHOOKS } from "./config";

/**
 * The account-level pieces calling needs, and pointing numbers at the CRM.
 * Everything here is done by an admin from Settings → Phone numbers.
 */

type VoiceCredentials = { apiKeySid: string; apiKeySecret: string; twimlAppSid: string };

/** The API key and TwiML app for browser calls: from the environment, else what Settings set up. Null until set up. */
export async function voiceCredentials(): Promise<VoiceCredentials | null> {
  const envSid = process.env.TWILIO_API_KEY_SID?.trim();
  const envSecret = process.env.TWILIO_API_KEY_SECRET?.trim();
  const envApp = process.env.TWILIO_TWIML_APP_SID?.trim();
  const stored = (await getWorkspace()).phone;
  const apiKeySid = envSid || stored.apiKeySid;
  let apiKeySecret = envSecret;
  if (!apiKeySecret && stored.apiKeySecret) {
    try {
      apiKeySecret = decryptSecret(stored.apiKeySecret);
    } catch {
      return null;
    }
  }
  const twimlAppSid = envApp || stored.twimlAppSid;
  return apiKeySid && apiKeySecret && twimlAppSid ? { apiKeySid, apiKeySecret, twimlAppSid } : null;
}

async function savePhoneSettings(patch: Partial<PhoneSettings>) {
  const ws = await getWorkspace();
  const db = await getDb();
  await db
    .update(schema.workspace)
    .set({ phone: { ...ws.phone, ...patch }, updatedAt: new Date() })
    .where(eq(schema.workspace.id, ws.id));
}

/**
 * Creates (or points at this deployment) what browser calls need: a TwiML app
 * whose voice URL is the CRM's webhook, and an API key to sign call tokens.
 * The key is only created when the deployment has none (TWILIO_API_KEY_SID),
 * which can only happen on the legacy auth-token setup: API keys can't make
 * keys. Safe to run again: it reuses what exists and only updates the URLs.
 */
export async function setUpCalling(origin: string) {
  const ws = await getWorkspace();
  const voiceUrl = `${origin}${WEBHOOKS.voice}`;
  let appSid = process.env.TWILIO_TWIML_APP_SID?.trim() || ws.phone.twimlAppSid;
  if (appSid) {
    try {
      await twilio("POST", `/Applications/${appSid}`, { VoiceUrl: voiceUrl, VoiceMethod: "POST" });
    } catch (err) {
      if (!(err instanceof TwilioError && err.status === 404)) throw err;
      appSid = undefined;
    }
  }
  if (!appSid) {
    const app = await twilio<{ sid: string }>("POST", "/Applications", { FriendlyName: `${ws.name} CRM calls`.slice(0, 64), VoiceUrl: voiceUrl, VoiceMethod: "POST" });
    appSid = app.sid;
  }
  const patch: Partial<PhoneSettings> = { twimlAppSid: appSid, webhookOrigin: origin };
  if (!process.env.TWILIO_API_KEY_SID?.trim() && !ws.phone.apiKeySid) {
    const key = await twilio<{ sid: string; secret: string }>("POST", "/Keys", { FriendlyName: `${ws.name} CRM calls`.slice(0, 64) });
    patch.apiKeySid = key.sid;
    patch.apiKeySecret = encryptSecret(key.secret);
  }
  await savePhoneSettings(patch);
}

/** How long a browser's calling token lasts. The page asks for a new one before it runs out. */
const TOKEN_SECONDS = 3600;

/**
 * A Voice access token for one teammate's browser: it can place calls through
 * the TwiML app, and can't receive any (incoming calls ring cell phones).
 */
export async function voiceToken(identity: string) {
  const creds = twilioCredentials();
  const voice = await voiceCredentials();
  if (!creds || !voice) throw new TwilioError("Calling from the browser isn't set up yet. An admin can set it up in Settings → Phone numbers.", 404);
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    grants: { identity, voice: { incoming: { allow: false }, outgoing: { application_sid: voice.twimlAppSid } } },
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT", cty: "twilio-fpa;v=1" })
    .setJti(`${voice.apiKeySid}-${now}`)
    .setIssuer(voice.apiKeySid)
    .setSubject(creds.accountSid)
    .setIssuedAt(now)
    .setExpirationTime(now + TOKEN_SECONDS)
    .sign(new TextEncoder().encode(voice.apiKeySecret));
  return { token, expiresAt: new Date((now + TOKEN_SECONDS) * 1000).toISOString() };
}

export type AvailableNumber = { number: string; locality: string | null; region: string | null };

/**
 * Numbers Twilio has for sale in an area code that can do everything the CRM
 * needs: voice, SMS and MMS. Only searches; nothing is bought.
 */
export async function searchAvailableNumbers(areaCode: string, country: string): Promise<AvailableNumber[]> {
  const res = await twilio<{ available_phone_numbers: { phone_number: string; locality?: string | null; region?: string | null }[] }>(
    "GET",
    `/AvailablePhoneNumbers/${encodeURIComponent(country)}/Local`,
    { AreaCode: areaCode, VoiceEnabled: true, SmsEnabled: true, MmsEnabled: true, PageSize: 10 },
  );
  return (res.available_phone_numbers ?? []).map((n) => ({ number: n.phone_number, locality: n.locality || null, region: n.region || null }));
}

/**
 * Buys a number in the Twilio account, already pointed at the CRM, and adds
 * it to TWILIO_MESSAGING_SERVICE_SID when set (for A2P 10DLC texting in the US).
 * Twilio bills the account monthly for it from now on.
 */
export async function buyNumber(phoneNumber: string, label: string, origin: string) {
  const bought = await twilio<{ sid: string; phone_number: string }>("POST", "/IncomingPhoneNumbers", {
    PhoneNumber: phoneNumber,
    FriendlyName: label.slice(0, 64),
    VoiceUrl: `${origin}${WEBHOOKS.voice}`,
    VoiceMethod: "POST",
    StatusCallback: `${origin}${WEBHOOKS.voiceStatus}`,
    StatusCallbackMethod: "POST",
    SmsUrl: `${origin}${WEBHOOKS.sms}`,
    SmsMethod: "POST",
  });
  const service = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  if (service) {
    try {
      await twilioMessaging("POST", `/Services/${encodeURIComponent(service)}/PhoneNumbers`, { PhoneNumberSid: bought.sid });
    } catch (err) {
      // The number is bought either way; say what's missing rather than lose track of it.
      console.error("[twilio] messaging service", err);
      return { sid: bought.sid, number: bought.phone_number, warning: "The number was bought, but Twilio didn't add it to the messaging service. Add it there in the Twilio console so texts can be delivered." };
    }
  }
  return { sid: bought.sid, number: bought.phone_number, warning: null };
}

/** Releases a number from the Twilio account for good: it stops working and stops being billed. Someone else may buy it later. */
export async function releaseNumber(sid: string) {
  await twilio("DELETE", `/IncomingPhoneNumbers/${encodeURIComponent(sid)}`).catch((err) => {
    // Already gone from the account: nothing left to release.
    if (!(err instanceof TwilioError && err.status === 404)) throw err;
  });
}

/** Points a number's calls and texts at the CRM. */
export async function connectNumber(sid: string, origin: string) {
  await twilio("POST", `/IncomingPhoneNumbers/${sid}`, {
    VoiceUrl: `${origin}${WEBHOOKS.voice}`,
    VoiceMethod: "POST",
    StatusCallback: `${origin}${WEBHOOKS.voiceStatus}`,
    StatusCallbackMethod: "POST",
    SmsUrl: `${origin}${WEBHOOKS.sms}`,
    SmsMethod: "POST",
  });
}
