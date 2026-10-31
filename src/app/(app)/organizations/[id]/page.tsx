import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DynamicMarker } from "@/components/dynamic-marker";
import { z } from "zod";
import { BuildingOffice2Icon } from "@heroicons/react/24/outline";
import { Composer } from "@/components/activity/composer";
import { Timeline } from "@/components/activity/timeline";
import { FilesPanel } from "@/components/files/files-panel";
import { OrganizationDetails, RelatedDeals, RelatedPeople } from "@/components/records/details";
import { RecordBody, RecordHeader } from "@/components/records/record-header";
import { PageSkeleton } from "@/components/ui/skeleton";
import { timeline } from "@/lib/crm/activities";
import { getOrganization, listDeals, peopleOf } from "@/lib/crm/records";

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
  const [tl, deals, people] = await Promise.all([timeline("organization", id), listDeals({ organizationId: id, status: "all" }), peopleOf(id)]);
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
            <RelatedDeals
              deals={deals.map((d) => ({ id: d.deal.id, title: d.deal.title, value: d.deal.value, status: d.deal.status, stageName: d.stageName }))}
              create={{ kind: "deal", defaults: { organizationId: id, organizationName: org.name } }}
            />
            <FilesPanel files={tl.files} links={{ organizationId: id }} />
          </>
        }
      >
        <Composer links={{ organizationId: id }} />
        <Timeline
          planned={tl.planned}
          pinned={tl.pinned}
          past={tl.past}
          context={{ type: "organization", id }}
          emptyHint={`Everything logged with ${org.name}'s people and deals shows up here too.`}
        />
      </RecordBody>
    </>
  );
}
