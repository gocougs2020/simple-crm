import { connection, NextResponse } from "next/server";
import { sweepRuns } from "@/lib/agent/runs";
import { runDueJobs } from "@/lib/agent/schedules";
import { cronAuthorized } from "@/lib/cron";
import { describeBacklog } from "@/lib/file-describe";
import { pruneForwards } from "@/lib/forwarding/inbound";

export const maxDuration = 300;

/**
 * Vercel Cron, on the quarter hour: starts the agent's scheduled jobs whose
 * time has come, stops background runs that have gone on too long, starts
 * any left waiting, describes a few files nobody has described yet, and
 * forgets the text of forwarded emails older than 30 days.
 */
export async function GET(request: Request) {
  await connection();
  if (!cronAuthorized(request)) return new NextResponse("Unauthorized", { status: 401 });
  const jobs = await runDueJobs().catch((err) => {
    console.error("[agent] scheduled jobs", err);
    return { started: 0 };
  });
  const swept = await sweepRuns();
  const described = await describeBacklog().catch((err) => {
    console.error("[files] describe backlog", err);
    return { described: 0, embedded: 0 };
  });
  const forwarded = await pruneForwards().catch((err) => {
    console.error("[forwarding] prune", err);
    return { cleared: 0 };
  });
  return NextResponse.json({ ...swept, scheduled: jobs.started, ...described, forwardsCleared: forwarded.cleared });
}
