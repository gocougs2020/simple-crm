import { connection, NextResponse } from "next/server";
import { sweepRuns } from "@/lib/agent/runs";
import { runDueJobs } from "@/lib/agent/schedules";
import { cronAuthorized } from "@/lib/cron";

export const maxDuration = 300;

/**
 * Vercel Cron, on the quarter hour: starts the agent's scheduled jobs whose
 * time has come, stops background runs that have gone on too long, and
 * starts any left waiting.
 */
export async function GET(request: Request) {
  await connection();
  if (!cronAuthorized(request)) return new NextResponse("Unauthorized", { status: 401 });
  const jobs = await runDueJobs().catch((err) => {
    console.error("[agent] scheduled jobs", err);
    return { started: 0 };
  });
  return NextResponse.json({ ...(await sweepRuns()), scheduled: jobs.started });
}
