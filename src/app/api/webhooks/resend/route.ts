import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getResend } from "@/lib/email";
import { recordEmailEvent, type EmailEvent } from "@/lib/email/delivery";
import { syncThread } from "@/lib/email/inbox";

export const maxDuration = 60;

/**
 * Resend calls this when mail arrives in (or leaves) a connected inbox, and
 * with delivery reports for email the CRM sent (sent, delivered, delayed,
 * bounced, complained, failed, suppressed). The signature is
 * checked against the secret saved when the webhook was connected (or
 * RESEND_WEBHOOK_SECRET). Anything we can't verify is refused, so this can't
 * be used to inject mail or fake a bounce.
 */
export async function POST(request: Request) {
  const resend = getResend();
  if (!resend) return new NextResponse("Not configured", { status: 404 });
  const db = await getDb();
  const [ws] = await db.select({ email: schema.workspace.email }).from(schema.workspace).limit(1);
  const secret = process.env.RESEND_WEBHOOK_SECRET ?? ws?.email.webhookSecret;
  if (!secret) return new NextResponse("Not configured", { status: 404 });

  const payload = await request.text();
  let event: ReturnType<typeof resend.webhooks.verify>;
  try {
    // Resend signs with Svix; the same values may arrive under the Standard Webhooks names.
    const h = (name: string) => request.headers.get(`svix-${name}`) ?? request.headers.get(`webhook-${name}`) ?? "";
    event = resend.webhooks.verify({ payload, headers: { id: h("id"), timestamp: h("timestamp"), signature: h("signature") }, webhookSecret: secret });
  } catch {
    return new NextResponse("Invalid signature", { status: 401 });
  }

  if (event.type.startsWith("email.")) {
    try {
      const result = await recordEmailEvent(event as EmailEvent);
      // Resend retries anything that isn't a 2xx, which is what a report that beat its row needs.
      if (result.retryLater) return new NextResponse("That email isn't recorded yet. Retry later.", { status: 503 });
      return NextResponse.json({ ok: true, ...result });
    } catch (err) {
      // A 5xx makes Resend retry, which is right if the database hiccups.
      console.error("[resend webhook]", event.type, err);
      return new NextResponse("Couldn't record the event", { status: 500 });
    }
  }

  switch (event.type) {
    case "inbox.email.received":
    case "inbox.email.sent":
    case "inbox.thread.created":
      await syncThread(event.data.inbox_id, event.data.thread_id);
      break;
    case "inbox.thread.folder.updated":
      await db.update(schema.inboxThreads).set({ folder: event.data.to }).where(eq(schema.inboxThreads.resendThreadId, event.data.thread_id));
      break;
    default:
      break;
  }
  return NextResponse.json({ ok: true });
}
