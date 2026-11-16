import "server-only";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { PhoneSettings } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { getWorkspace } from "@/lib/workspace";
import { twilio, TwilioError } from "./client";
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
 * Safe to run again: it reuses what exists and only updates the URLs.
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

export type AccountNumber = { sid: string; number: string; friendlyName: string; voice: boolean; sms: boolean; voiceUrl: string | null; smsUrl: string | null };

/** The numbers in the Twilio account, for picking which ones the CRM uses. */
export async function listAccountNumbers(): Promise<AccountNumber[]> {
  const out: AccountNumber[] = [];
  let page: { incoming_phone_numbers: Record<string, unknown>[]; next_page_uri: string | null } = await twilio("GET", "/IncomingPhoneNumbers", { PageSize: 100 });
  for (let i = 0; i < 5; i++) {
    for (const n of page.incoming_phone_numbers) {
      const caps = (n.capabilities ?? {}) as { voice?: boolean; sms?: boolean };
      out.push({ sid: String(n.sid), number: String(n.phone_number), friendlyName: String(n.friendly_name ?? n.phone_number), voice: !!caps.voice, sms: !!caps.sms, voiceUrl: (n.voice_url as string) || null, smsUrl: (n.sms_url as string) || null });
    }
    if (!page.next_page_uri) break;
    const next = new URL(`https://api.twilio.com${page.next_page_uri}`);
    page = await twilio("GET", "/IncomingPhoneNumbers", Object.fromEntries(next.searchParams));
  }
  return out;
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

/** Stops sending a number's calls and texts to the CRM (when it's removed here). */
export async function disconnectNumber(sid: string) {
  await twilio("POST", `/IncomingPhoneNumbers/${sid}`, { VoiceUrl: "", SmsUrl: "", StatusCallback: "" }).catch((err) => {
    if (!(err instanceof TwilioError && err.status === 404)) throw err;
  });
}
