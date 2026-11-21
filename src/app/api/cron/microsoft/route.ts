import { connection, NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron";
import { microsoftConfigured, syncEveryMinutes } from "@/lib/microsoft/config";
import { microsoftSlotDue, syncAllMailboxes } from "@/lib/microsoft/sync-all";

export const maxDuration = 300;

/**
 * Syncs every connected Microsoft 365 mailbox. The cron dispatcher
 * (/api/cron/tick) runs it on the quarter hours that fit
 * `microsoft.syncEveryMinutes` (every 15, 30 or 60 minutes); calling this by
 * hand does the same, and `?force` syncs whatever the time.
 */
export async function GET(request: Request) {
  await connection();
  if (!cronAuthorized(request)) return new NextResponse("Unauthorized", { status: 401 });
  if (!microsoftConfigured()) return NextResponse.json({ skipped: "Microsoft 365 isn't set up." });
  if (!microsoftSlotDue() && !new URL(request.url).searchParams.has("force")) return NextResponse.json({ skipped: `Syncing every ${syncEveryMinutes()} minutes.` });
  return NextResponse.json(await syncAllMailboxes());
}
