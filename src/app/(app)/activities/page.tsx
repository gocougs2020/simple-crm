import type { Metadata } from "next";
import { Suspense } from "react";
import { ActivitiesView } from "@/components/activities/activities-view";
import { PageSkeleton } from "@/components/ui/skeleton";
import { requireUser } from "@/lib/auth";
import { activityTypes, type ActivityType } from "@/lib/constants";
import { listActivities } from "@/lib/crm/activities";
import { getAppData } from "@/lib/crm/context";

export const metadata: Metadata = { title: "Activities" };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export default function ActivitiesPage({ searchParams }: PageProps<"/activities">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Activities searchParams={searchParams} />
    </Suspense>
  );
}

async function Activities({ searchParams }: Pick<PageProps<"/activities">, "searchParams">) {
  const sp = await searchParams;
  const [user, app] = await Promise.all([requireUser(), getAppData()]);
  const status = one(sp.status) === "done" ? "done" : "todo";
  const who = one(sp.who);
  const types = (one(sp.type)?.split(",") ?? []).filter((t): t is ActivityType => (activityTypes as readonly string[]).includes(t));
  const rows = await listActivities({ status, assigneeId: who === "all" ? undefined : who && who !== "me" ? who : user.id, types }, app.workspace.timezone);
  return <ActivitiesView rows={rows} status={status} />;
}
