import { siteOrigin } from "@/lib/origin";
import { phoneConfigured } from "@/lib/twilio/config";
import { el, twiml, twimlResponse } from "@/lib/twilio/twiml";
import { browserCallTwiml, inboundCallTwiml } from "@/lib/twilio/voice";
import { readTwilioWebhook } from "@/lib/twilio/webhook";

export const maxDuration = 30;

/**
 * Twilio asks here what to do with a call: one a teammate is placing from the
 * browser (From is their client identity), or one ringing one of the numbers.
 * Unsigned requests are refused.
 */
export async function POST(request: Request) {
  if (!phoneConfigured()) return new Response("Not configured", { status: 404 });
  const params = await readTwilioWebhook(request);
  if (!params) return new Response("Invalid signature", { status: 403 });
  const origin = await siteOrigin();
  try {
    const xml = params.From?.startsWith("client:") ? await browserCallTwiml(origin, params) : await inboundCallTwiml(origin, params);
    return twimlResponse(xml);
  } catch (err) {
    console.error("[twilio voice]", err);
    return twimlResponse(twiml(el("Say", undefined, "Sorry, something went wrong. Please try again."), el("Hangup")));
  }
}
