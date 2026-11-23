import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { currentRecordId } from "@/lib/crm/merged";
import { Suspense } from "react";
import { DynamicMarker } from "@/components/dynamic-marker";
import { Composer } from "@/components/activity/composer";
import { FocusLine } from "@/components/activity/focus-line";
import { RecordSummary } from "@/components/records/record-summary";
import { Timeline } from "@/components/activity/timeline";
import { FilesCard } from "@/components/files/files-panel";
import { OrganizationCard, PersonDetails, RelatedClients } from "@/components/records/details";
import { RecordBody, RecordHeader } from "@/components/records/record-header";
import { CallButton, StarToggle } from "@/components/phone/contact-actions";
import { Avatar } from "@/components/ui/avatar";
import { appConfig } from "@/app.config";
import { PageSkeleton } from "@/components/ui/skeleton";
import { recordTimeline } from "@/lib/crm/activities";
import { clientsOfPerson, getPerson, otherOrganizationsOf } from "@/lib/crm/records";
import { personName } from "@/lib/format";
import { isTeammate } from "@/lib/crm/teammates";
import { z } from "zod";
import { requireUser } from "@/lib/auth";

export async function generateMetadata({ params }: PageProps<"/people/[id]">): Promise<Metadata> {
  const { id } = await params;
  const row = z.uuid().safeParse(id).success ? await getPerson(id) : null;
  return { title: row ? personName(row.person) : "Person" };
}

export default function PersonPage({ params }: PageProps<"/people/[id]">) {
  return (
    <>
      <DynamicMarker />
      <Suspense fallback={<PageSkeleton />}>
        <Person params={params} />
      </Suspense>
    </>
  );
}

async function Person({ params }: Pick<PageProps<"/people/[id]">, "params">) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const row = await getPerson(id);
  if (!row) {
    // A link to a record that was merged away opens the one it was merged into.
    const current = await currentRecordId("person", id);
    if (current !== id) redirect(`/people/${current}`);
    // A teammate linked as if they were a contact (the agent, an old note) opens their teammate page.
    if (await isTeammate(id)) redirect(`/team/${id}`);
    notFound();
  }
  const { person, organization } = row;
  // Their own private mail with this record is on the timeline, for them alone.
  const viewer = await requireUser();
  const [tl, clients, alsoAt] = await Promise.all([recordTimeline("person", id, viewer.id), clientsOfPerson(id, person.organizationId), otherOrganizationsOf(id)]);
  const name = personName(person);
  return (
    <>
      <RecordHeader
        entity="person"
        id={id}
        title={name}
        archived={!!person.archivedAt}
        avatar={<Avatar name={name} size="xl" />}
        sub={
          <span className="flex flex-wrap items-center gap-x-1.5">
            {[person.title, organization?.name].filter(Boolean).join(" at ") || null}
            {person.organizationId ? <StarToggle personId={id} starred={person.decisionMaker} name={person.firstName} className="-my-1" /> : null}
            {person.decisionMaker ? <span className="text-[12.5px] text-muted">{appConfig.records.keyContactLabel}</span> : null}
          </span>
        }
        actions={<CallButton target={{ name, phone: person.phone, personId: id }} />}
      />
      <RecordBody
        side={
          <>
            {/* The client they belong to comes first, above the details. */}
            <RelatedClients clients={clients} create={{ kind: "client", defaults: { personId: id, personName: name, organizationId: organization?.id, organizationName: organization?.name } }} />
            <PersonDetails person={person} organization={organization} />
            {organization ? <OrganizationCard org={organization} /> : null}
            {alsoAt.map((org) => (
              <OrganizationCard key={org.id} org={org} title="Also at" />
            ))}
            <FilesCard files={tl.files} emailFiles={tl.emailFiles} links={{ personId: id, organizationId: person.organizationId }} />
          </>
        }
      >
        <RecordSummary entity="person" id={id} summary={person.summary} summaryAt={person.summaryAt} />
        <FocusLine planned={tl.planned} lastContactAt={tl.lastContactAt} lastCampaignAt={person.lastCampaignAt} context={{ type: "person", id }} />
        <Composer links={{ personId: id }} recipient={{ personId: id, name, email: person.email, phone: person.phone, textOptedOut: !!person.textOptOutAt }} />
        <Timeline planned={tl.planned} pinned={tl.pinned} past={tl.past} hasMore={tl.hasMore} counts={tl.counts} context={{ type: "person", id }} fileLinks={{ personId: id, organizationId: person.organizationId }} files={tl.files} emptyHint={`Log a call, note or email with ${person.firstName} above and it shows up here.`} />
      </RecordBody>
    </>
  );
}
