import { phoneConfigured } from "@/lib/twilio/config";
import { receiveText } from "@/lib/twilio/texts";
import { twiml, twimlResponse } from "@/lib/twilio/twiml";
import { readTwilioWebhook } from "@/lib/twilio/webhook";

/** A text to one of the numbers. Saved on whoever sent it; no automatic reply (Twilio answers STOP and HELP itself). */
export async function POST(request: Request) {
  if (!phoneConfigured()) return new Response("Not configured", { status: 404 });
  const params = await readTwilioWebhook(request);
  if (!params) return new Response("Invalid signature", { status: 403 });
  try {
    await receiveText(params);
  } catch (err) {
    // A 5xx makes Twilio retry, which is right if the database hiccups; the insert is idempotent.
    console.error("[twilio sms]", err);
    return new Response("Couldn't save the text", { status: 500 });
  }
  return twimlResponse(twiml());
}
