import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DynamicMarker } from "@/components/dynamic-marker";
import { z } from "zod";
import { BuildingOffice2Icon } from "@heroicons/react/24/outline";
import { Composer } from "@/components/activity/composer";
import { FocusLine } from "@/components/activity/focus-line";
import { Timeline } from "@/components/activity/timeline";
import { EmailThreadsCard } from "@/components/email/threads-card";
import { OrganizationDetails, RelatedClients, RelatedPeople } from "@/components/records/details";
import { RecordBody, RecordHeader } from "@/components/records/record-header";
import { PageSkeleton } from "@/components/ui/skeleton";
import { timeline } from "@/lib/crm/activities";
import { clientsOfOrganization, getOrganization, peopleOf } from "@/lib/crm/records";
import { threadsFor } from "@/lib/email/inbox";

export async function generateMetadata({ params }: PageProps<"/organizations/[id]">): Promise<Metadata> {
  const { id } = await params;
  const org = z.uuid().safeParse(id).success ? await getOrganization(id) : null;
  return { title: org?.name ?? "Organization" };
}

export default function OrganizationPage({ params }: PageProps<"/organizations/[id]">) {
  return (
    <>
      <DynamicMarker />
      <Suspense fallback={<PageSkeleton />}>
        <Organization params={params} />
      </Suspense>
    </>
  );
}

async function Organization({ params }: Pick<PageProps<"/organizations/[id]">, "params">) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const org = await getOrganization(id);
  if (!org) notFound();
  const [tl, clients, people] = await Promise.all([timeline("organization", id), clientsOfOrganization(id), peopleOf(id)]);
  const threads = await threadsFor({ personIds: people.map((p) => p.id), organizationId: id });
  return (
    <>
      <RecordHeader
        entity="organization"
        id={id}
        title={org.name}
        archived={!!org.archivedAt}
        avatar={
          <span className="flex size-12 items-center justify-center rounded-lg border border-line bg-sunken">
            <BuildingOffice2Icon className="size-6 text-muted" />
          </span>
        }
        sub={[org.industry, org.domain].filter(Boolean).join(" · ") || undefined}
      />
      <RecordBody
        side={
          <>
            <OrganizationDetails org={org} />
            <RelatedPeople people={people} organization={org} />
            <RelatedClients clients={clients} create={{ kind: "client", defaults: { organizationId: id, organizationName: org.name, name: org.name } }} />
            <EmailThreadsCard threads={threads} />
          </>
        }
      >
        <FocusLine planned={tl.planned} lastContactAt={tl.lastContactAt} context={{ type: "organization", id }} />
        <Composer links={{ organizationId: id }} />
        <Timeline
          planned={tl.planned}
          pinned={tl.pinned}
          past={tl.past}
          context={{ type: "organization", id }}
          fileLinks={{ organizationId: id }}
          emptyHint={`Everything logged with ${org.name}'s people and clients shows up here too.`}
        />
      </RecordBody>
    </>
  );
}
