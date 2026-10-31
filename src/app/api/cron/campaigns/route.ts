import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runDueCampaigns } from "@/lib/email/campaigns";
import { siteOrigin } from "@/lib/origin";

export const maxDuration = 300;

/** Compares hashes so the check takes the same time however much of the secret matches. */
function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return !process.env.VERCEL;
  const got = createHash("sha256").update(request.headers.get("authorization") ?? "").digest();
  const want = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(got, want);
}

/** Vercel Cron, every 5 minutes: sends scheduled campaigns that are due and resumes interrupted ones. */
export async function GET(request: Request) {
  if (!authorized(request)) return new NextResponse("Unauthorized", { status: 401 });
  return NextResponse.json(await runDueCampaigns(await siteOrigin()));
}
