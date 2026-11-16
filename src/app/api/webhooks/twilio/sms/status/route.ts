import { phoneConfigured } from "@/lib/twilio/config";
import { recordTextStatus } from "@/lib/twilio/texts";
import { readTwilioWebhook } from "@/lib/twilio/webhook";

/** Delivery reports for texts the CRM sent: sent, delivered, undelivered, failed. */
export async function POST(request: Request) {
  if (!phoneConfigured()) return new Response("Not configured", { status: 404 });
  const params = await readTwilioWebhook(request);
  if (!params) return new Response("Invalid signature", { status: 403 });
  try {
    const { retryLater } = await recordTextStatus(params);
    if (retryLater) return new Response("That text isn't recorded yet. Retry later.", { status: 503 });
  } catch (err) {
    console.error("[twilio sms status]", err);
    return new Response("Couldn't record the status", { status: 500 });
  }
  return new Response(null, { status: 204 });
}
