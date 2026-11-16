import { phoneConfigured } from "@/lib/twilio/config";
import { recordCallStatus } from "@/lib/twilio/voice";
import { readTwilioWebhook } from "@/lib/twilio/webhook";

/** Status reports for a dialed call (answered, completed with its length), so the timeline shows how it went. */
export async function POST(request: Request) {
  if (!phoneConfigured()) return new Response("Not configured", { status: 404 });
  const params = await readTwilioWebhook(request);
  if (!params) return new Response("Invalid signature", { status: 403 });
  const callId = new URL(request.url).searchParams.get("call");
  // A number's own status reports (no call id) are about the incoming leg; the dialed leg's reports carry the id.
  if (callId) await recordCallStatus(callId, params);
  return new Response(null, { status: 204 });
}
