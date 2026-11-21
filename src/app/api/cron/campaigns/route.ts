import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron";
import { runDueCampaigns } from "@/lib/email/campaigns";
import { siteOrigin } from "@/lib/origin";

export const maxDuration = 300;

/**
 * Sends scheduled campaigns that are due and resumes interrupted ones. The
 * cron dispatcher (/api/cron/tick) runs this on the quarter hour when a
 * campaign is due; scheduled times are rounded to the quarter hour to match.
 * Also callable by hand.
 */
export async function GET(request: Request) {
  if (!cronAuthorized(request)) return new NextResponse("Unauthorized", { status: 401 });
  return NextResponse.json(await runDueCampaigns(await siteOrigin()));
}
