import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron";
import { runDueCampaigns } from "@/lib/email/campaigns";
import { siteOrigin } from "@/lib/origin";

export const maxDuration = 300;

/**
 * Vercel Cron, on the quarter hour (with the inbox sync, so Neon can scale to
 * zero between runs): sends scheduled campaigns that are due and resumes
 * interrupted ones. Scheduled times are rounded to the quarter hour to match.
 */
export async function GET(request: Request) {
  if (!cronAuthorized(request)) return new NextResponse("Unauthorized", { status: 401 });
  return NextResponse.json(await runDueCampaigns(await siteOrigin()));
}
