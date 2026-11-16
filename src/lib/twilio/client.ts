import "server-only";
import { twilioCredentials } from "./config";

/** Something Twilio refused, in its words. `code` is Twilio's error code (21610: the recipient opted out). */
export class TwilioError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
  }
}

const API = "https://api.twilio.com/2010-04-01";
const MESSAGING_API = "https://messaging.twilio.com/v1";

const notSetUp = () => new TwilioError("Calling and texting aren't set up. Add TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET.", 404);

/** Twilio's API takes an API key (key SID and secret) or the account SID and auth token, as Basic auth. The account SID stays in the URL either way. */
const basicAuth = (creds: { username: string; password: string }) => `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString("base64")}`;

/**
 * One call to Twilio's REST API, for the account. `path` is under the account
 * (`/Messages`); `.json` is added. Parameters are form-encoded, the way
 * Twilio takes them.
 */
export async function twilio<T = Record<string, unknown>>(method: "GET" | "POST" | "DELETE", path: string, params?: Record<string, string | number | boolean | undefined | null>): Promise<T> {
  const creds = twilioCredentials();
  if (!creds) throw notSetUp();
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null) form.set(k, String(v));
  const url = `${API}/Accounts/${creds.accountSid}${path}.json${method === "GET" && params ? `?${form}` : ""}`;
  const res = await fetch(url, {
    method,
    headers: { authorization: basicAuth(creds), ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body: method === "POST" ? form : undefined,
    cache: "no-store",
  });
  if (res.status === 204) return null as T;
  const body = (await res.json().catch(() => null)) as (T & { message?: string; code?: number }) | null;
  if (!res.ok) throw new TwilioError(`Twilio: ${body?.message ?? `HTTP ${res.status}`}`, res.status, body?.code);
  return body as T;
}

/** One call to Twilio's Messaging API (messaging services), for the account. `path` is under /v1. */
export async function twilioMessaging<T = Record<string, unknown>>(method: "POST" | "DELETE", path: string, params?: Record<string, string>): Promise<T> {
  const creds = twilioCredentials();
  if (!creds) throw notSetUp();
  const res = await fetch(`${MESSAGING_API}${path}`, {
    method,
    headers: { authorization: basicAuth(creds), ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body: method === "POST" ? new URLSearchParams(params ?? {}) : undefined,
    cache: "no-store",
  });
  if (res.status === 204) return null as T;
  const body = (await res.json().catch(() => null)) as (T & { message?: string; code?: number }) | null;
  if (!res.ok) throw new TwilioError(`Twilio: ${body?.message ?? `HTTP ${res.status}`}`, res.status, body?.code);
  return body as T;
}
