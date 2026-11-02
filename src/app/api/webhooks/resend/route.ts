import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getResend } from "@/lib/email";
import { syncThread } from "@/lib/email/inbox";

export const maxDuration = 60;

/**
 * Resend calls this when mail arrives in (or leaves) a connected inbox. The
 * signature is checked against the secret saved when the webhook was
 * connected (or RESEND_WEBHOOK_SECRET), then the thread is synced. Anything
 * we can't verify is refused, so this can't be used to inject mail.
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
