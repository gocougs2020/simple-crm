import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";
import { TeammateView } from "@/components/team/teammate-view";
import { PageSkeleton } from "@/components/ui/skeleton";
import { requireUser } from "@/lib/auth";
import { dayBounds, listActivities, loggedBy } from "@/lib/crm/activities";
import { getAppData } from "@/lib/crm/context";
import { getTeammate, ownedBy } from "@/lib/crm/teammates";
import { viewerTimeZone } from "@/lib/viewer-time-zone";

/** How many of their planned items the page lists before pointing to Activities. */
const PLANNED_SHOWN = 15;

export async function generateMetadata({ params }: PageProps<"/team/[id]">): Promise<Metadata> {
  const { id } = await params;
  const row = z.uuid().safeParse(id).success ? await getTeammate(id) : null;
  return { title: row?.name ?? "Teammate" };
}

export default function TeammatePage({ params }: PageProps<"/team/[id]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Teammate params={params} />
    </Suspense>
  );
}

async function Teammate({ params }: Pick<PageProps<"/team/[id]">, "params">) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const [teammate, , app] = await Promise.all([getTeammate(id), requireUser(), getAppData()]);
  if (!teammate) notFound();
  const tz = await viewerTimeZone(app.workspace.timezone);
  const [planned, recent, owned] = await Promise.all([listActivities({ assigneeId: id, status: "todo" }, tz), loggedBy(id), ownedBy(id)]);
  const { startOfToday } = dayBounds(tz);
  const overdue = planned.filter((r) => r.activity.dueAt && r.activity.dueAt < startOfToday).length;
  return <TeammateView teammate={teammate} planned={planned.slice(0, PLANNED_SHOWN)} plannedCount={planned.length} overdue={overdue} recent={recent} owned={owned} />;
}
