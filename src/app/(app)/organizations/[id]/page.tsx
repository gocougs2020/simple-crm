import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { currentRecordId } from "@/lib/crm/merged";
import { Suspense } from "react";
import { DynamicMarker } from "@/components/dynamic-marker";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { BuildingOffice2Icon } from "@heroicons/react/24/outline";
import { Composer } from "@/components/activity/composer";
import { FocusLine } from "@/components/activity/focus-line";
import { RecordSummary } from "@/components/records/record-summary";
import { Timeline } from "@/components/activity/timeline";
import { FilesCard } from "@/components/files/files-panel";
import { OrganizationDetails, RelatedClients, RelatedOrganizations, RelatedPeople } from "@/components/records/details";
import { RecordBody, RecordHeader } from "@/components/records/record-header";
import { CallButton } from "@/components/phone/contact-actions";
import { PageSkeleton } from "@/components/ui/skeleton";
import { recordTimeline } from "@/lib/crm/activities";
import { orderPeople } from "@/lib/crm/people-order";
import { clientsOfOrganization, getOrganization, organizationsOf, peopleOf } from "@/lib/crm/records";
import { personName } from "@/lib/format";

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
  if (!org) {
    // A link to a record that was merged away opens the one it was merged into.
    const current = await currentRecordId("organization", id);
    if (current !== id) redirect(`/organizations/${current}`);
    notFound();
  }
  // Their own private mail with this record is on the timeline, for them alone.
  const viewer = await requireUser();
  const [tl, clients, people, parent, children] = await Promise.all([
    recordTimeline("organization", id, viewer.id),
    clientsOfOrganization(id),
    peopleOf(id),
    org.parentId ? getOrganization(org.parentId) : null,
    org.isParent ? organizationsOf(id) : [],
  ]);
  // Everyone a call, email, text or meeting from this page can be with: decision makers, then everyone else, A to Z.
  const contacts = orderPeople(
    people.map((p) => ({ personId: p.id, name: personName(p), email: p.email, phone: p.phone, textOptedOut: !!p.textOptOutAt, detail: p.title, starred: p.decisionMaker })),
    (c) => c,
  );
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
        sub={[org.isParent ? "Parent organization" : parent ? `Part of ${parent.name}` : null, org.industry, org.domain].filter(Boolean).join(" · ") || undefined}
        actions={<CallButton target={{ name: org.name, phone: org.phone, organizationId: id }} />}
      />
      <RecordBody
        side={
          <>
            <OrganizationDetails org={org} parent={parent ? { id: parent.id, name: parent.name } : null} childCount={children.length} />
            {org.isParent ? <RelatedOrganizations parent={{ id, name: org.name }} organizations={children} /> : null}
            <RelatedPeople people={people} organization={org} />
            <RelatedClients clients={clients} create={{ kind: "client", defaults: { organizationId: id, organizationName: org.name, name: org.name } }} />
            <FilesCard files={tl.files} emailFiles={tl.emailFiles} links={{ organizationId: id }} />
          </>
        }
      >
        <RecordSummary entity="organization" id={id} summary={org.summary} summaryAt={org.summaryAt} />
        <FocusLine planned={tl.planned} lastContactAt={tl.lastContactAt} context={{ type: "organization", id }} />
        <Composer links={{ organizationId: id }} contacts={contacts} />
        <Timeline
          planned={tl.planned}
          pinned={tl.pinned}
          past={tl.past} hasMore={tl.hasMore} counts={tl.counts}
          context={{ type: "organization", id }}
          fileLinks={{ organizationId: id }}
          files={tl.files}
          emptyHint={`Everything logged with ${org.name}'s people and clients shows up here too.`}
        />
      </RecordBody>
    </>
  );
}
