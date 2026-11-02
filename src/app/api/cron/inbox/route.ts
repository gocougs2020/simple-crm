import { createHash, timingSafeEqual } from "node:crypto";
import { connection, NextResponse } from "next/server";
import { getResend } from "@/lib/email";
import { syncAllInboxes } from "@/lib/email/inbox";

export const maxDuration = 300;

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return !process.env.VERCEL;
  const got = createHash("sha256").update(request.headers.get("authorization") ?? "").digest();
  const want = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(got, want);
}

/** Vercel Cron, every 15 minutes: catches anything the webhook missed (a deploy mid-delivery, a webhook not yet connected). */
export async function GET(request: Request) {
  // Always at request time; never a build-time snapshot.
  await connection();
  if (!authorized(request)) return new NextResponse("Unauthorized", { status: 401 });
  if (!getResend()) return NextResponse.json({ skipped: "Email isn't connected." });
  return NextResponse.json(await syncAllInboxes(25));
}
