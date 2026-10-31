import { Suspense } from "react";
import { HomeView } from "@/components/home/home-view";
import { PageSkeleton } from "@/components/ui/skeleton";
import { requireUser } from "@/lib/auth";
import { dealStats, dealsWithoutNextStep, listActivities, myDueCounts, teamFeed } from "@/lib/crm/activities";
import { getAppData } from "@/lib/crm/context";
import { pipelineSummary } from "@/lib/crm/records";

export default function Home() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Dashboard />
    </Suspense>
  );
}

async function Dashboard() {
  const [user, app] = await Promise.all([requireUser(), getAppData()]);
  const tz = app.workspace.timezone;
  const pipeline = app.pipelines.find((p) => p.id === user.prefs.pipelineId) ?? app.pipelines[0];
  const [tasks, feed, stuck, stats, summary, due] = await Promise.all([
    listActivities({ assigneeId: user.id, status: "todo", range: "week" }, tz),
    teamFeed(15),
    dealsWithoutNextStep(),
    dealStats(tz),
    pipeline ? pipelineSummary(pipeline.id) : Promise.resolve([]),
    myDueCounts(user.id, tz),
  ]);
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(new Date()));
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const stages = (pipeline?.stages ?? []).map((s) => {
    const row = summary.find((r) => r.stageId === s.id);
    return { id: s.id, name: s.name, n: row?.n ?? 0, value: Number(row?.value ?? 0) };
  });
  return <HomeView greeting={greeting} tasks={tasks} feed={feed} stuck={stuck} stats={{ ...stats, dueNow: due.overdue + due.today }} stages={stages} pipelineName={pipeline?.name ?? null} />;
}
