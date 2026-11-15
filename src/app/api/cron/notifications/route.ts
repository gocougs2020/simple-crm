import { connection, NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron";
import { sendDueNotifications } from "@/lib/push/due";
import { pushConfigured } from "@/lib/push/vapid";

export const maxDuration = 120;

/** Vercel Cron, on the quarter hour with the other jobs: "due soon" pushes and the morning summary of today's tasks. */
export async function GET(request: Request) {
  await connection();
  if (!cronAuthorized(request)) return new NextResponse("Unauthorized", { status: 401 });
  if (!(await pushConfigured())) return NextResponse.json({ skipped: "Push notifications aren't set up (VAPID keys)." });
  return NextResponse.json(await sendDueNotifications());
}
