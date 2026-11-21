import { connection, NextResponse } from "next/server";
import { sweepRuns } from "@/lib/agent/runs";
import { runDueJobs } from "@/lib/agent/schedules";
import { cronAuthorized } from "@/lib/cron";
import { describeBacklog } from "@/lib/file-describe";
import { retryReplies } from "@/lib/forwarding/inbound";

export const maxDuration = 300;

/**
 * Starts the agent's scheduled jobs whose time has come, stops background
 * runs that have gone on too long, starts any left waiting, describes a few
 * files nobody has described yet, and sends forwarding replies that didn't
 * go out. The cron dispatcher (/api/cron/tick) runs each of these when it
 * has work; this route runs them all, for calling by hand. Forgetting old
 * forwarded-email text is in the daily prune (src/lib/daily-prune.ts).
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
  const replies = await retryReplies().catch((err) => {
    console.error("[forwarding] reply retries", err);
    return { sent: 0 };
  });
  return NextResponse.json({ ...swept, scheduled: jobs.started, ...described, forwardRepliesSent: replies.sent });
}
