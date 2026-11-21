import { connection, NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron";
import { getResend } from "@/lib/email";
import { syncAllInboxes } from "@/lib/email/inbox";

export const maxDuration = 300;

/** Catches anything the webhook missed (a deploy mid-delivery, a webhook not yet connected). The cron dispatcher (/api/cron/tick) runs it hourly; also callable by hand. */
export async function GET(request: Request) {
  // Always at request time; never a build-time snapshot.
  await connection();
  if (!cronAuthorized(request)) return new NextResponse("Unauthorized", { status: 401 });
  if (!getResend()) return NextResponse.json({ skipped: "Email isn't connected." });
  return NextResponse.json(await syncAllInboxes(25));
}
