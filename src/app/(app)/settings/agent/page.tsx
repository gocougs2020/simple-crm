import type { Metadata } from "next";
import { Suspense } from "react";
import { appConfig } from "@/app.config";
import { AgentSettings } from "@/components/settings/agent";
import { PageSkeleton } from "@/components/ui/skeleton";
import { aiFeatures } from "@/lib/agent/config";
import { listJobs } from "@/lib/agent/schedules";
import { listSkills } from "@/lib/agent/skills";
import { toScheduledJob, toSkill } from "@/lib/api/queries";
import { isAdmin, requireUser } from "@/lib/auth";
import { sessionActor } from "@/lib/crm/actor";

export const metadata: Metadata = { title: appConfig.agent.name };

export default function AgentSettingsPage() {
  return (
    <Suspense fallback={<PageSkeleton rows={6} />}>
      <Agent />
    </Suspense>
  );
}

/** Skills and scheduled jobs: the teammate's own, the shared ones, and for admins everyone's. */
async function Agent() {
  const user = await requireUser("/settings/agent");
  const actor = sessionActor(user);
  const scope = isAdmin(user) ? "all" : undefined;
  const [skills, jobs] = await Promise.all([listSkills(actor, { scope }), listJobs(actor, { scope })]);
  return <AgentSettings skills={skills.map((s) => toSkill(s))} jobs={jobs.map(toScheduledJob)} background={aiFeatures().background} />;
}
