import type { Metadata } from "next";
import { Suspense } from "react";
import { appConfig } from "@/app.config";
import { AgentSettings } from "@/components/settings/agent";
import { ForwardingSettings } from "@/components/settings/forwarding";
import { PageSkeleton } from "@/components/ui/skeleton";
import { aiFeatures } from "@/lib/agent/config";
import { listJobs } from "@/lib/agent/schedules";
import { listSkills } from "@/lib/agent/skills";
import { toScheduledJob, toSkill } from "@/lib/api/queries";
import { isAdmin, requireUser } from "@/lib/auth";
import { sessionActor } from "@/lib/crm/actor";
import { forwardingFor } from "@/lib/forwarding/inbound";

export const metadata: Metadata = { title: appConfig.agent.name };

export default function AgentSettingsPage() {
  return (
    <Suspense fallback={<PageSkeleton rows={6} />}>
      <Agent />
    </Suspense>
  );
}

/** Email forwarding (the teammate's own), then skills and scheduled jobs: the teammate's own, the shared ones, and for admins everyone's. */
async function Agent() {
  const user = await requireUser("/settings/agent");
  const actor = sessionActor(user);
  const scope = isAdmin(user) ? "all" : undefined;
  const [skills, jobs, forwarding] = await Promise.all([listSkills(actor, { scope }), listJobs(actor, { scope }), forwardingFor(user)]);
  return (
    <>
      <ForwardingSettings
        available={forwarding.availability.on}
        unavailableReason={forwarding.availability.on ? null : forwarding.availability.reason}
        address={forwarding.address}
        recent={forwarding.recent}
      />
      <AgentSettings skills={skills.map((s) => toSkill(s))} jobs={jobs.map(toScheduledJob)} background={aiFeatures().background} />
    </>
  );
}
