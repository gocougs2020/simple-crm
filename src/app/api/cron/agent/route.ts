import { connection, NextResponse } from "next/server";
import { sweepRuns } from "@/lib/agent/runs";
import { cronAuthorized } from "@/lib/cron";

export const maxDuration = 300;

/**
 * Vercel Cron, on the quarter hour: stops background runs of the agent
 * that have gone on too long, and starts any left waiting.
 */
export async function GET(request: Request) {
  await connection();
  if (!cronAuthorized(request)) return new NextResponse("Unauthorized", { status: 401 });
  return NextResponse.json(await sweepRuns());
}
