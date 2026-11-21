import { connection, NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron";
import { sendAgendaEmails } from "@/lib/notifications/agenda";
import { sendDueNotifications } from "@/lib/push/due";
import { pushConfigured } from "@/lib/push/vapid";

export const maxDuration = 300;

/**
 * Meeting and due-task pushes, the morning push summary, and the morning
 * agenda emails. The cron dispatcher (/api/cron/tick) runs each when it's
 * due; this route runs both, for calling by hand.
 */
export async function GET(request: Request) {
  await connection();
  if (!cronAuthorized(request)) return new NextResponse("Unauthorized", { status: 401 });
  const [push, email] = await Promise.all([
    (await pushConfigured()) ? sendDueNotifications() : Promise.resolve({ skipped: "Push notifications aren't set up (VAPID keys)." }),
    sendAgendaEmails(),
  ]);
  return NextResponse.json({ push, email });
}
