import { phoneConfigured } from "@/lib/twilio/config";
import { el, twiml, twimlResponse } from "@/lib/twilio/twiml";
import { dialFinished } from "@/lib/twilio/voice";
import { readTwilioWebhook } from "@/lib/twilio/webhook";

/** Twilio calls this when a dialed call ends: records how it went, and tells a caller nobody answered. */
export async function POST(request: Request) {
  if (!phoneConfigured()) return new Response("Not configured", { status: 404 });
  const params = await readTwilioWebhook(request);
  if (!params) return new Response("Invalid signature", { status: 403 });
  const callId = new URL(request.url).searchParams.get("call") ?? "";
  try {
    return twimlResponse(await dialFinished(callId, params));
  } catch (err) {
    console.error("[twilio dial]", err);
    return twimlResponse(twiml(el("Hangup")));
  }
}
