import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DynamicMarker } from "@/components/dynamic-marker";
import { Composer } from "@/components/activity/composer";
import { FocusLine } from "@/components/activity/focus-line";
import { Timeline } from "@/components/activity/timeline";
import { FilesCard } from "@/components/files/files-panel";
import { OrganizationCard, PersonDetails, RelatedClients } from "@/components/records/details";
import { RecordBody, RecordHeader } from "@/components/records/record-header";
import { Avatar } from "@/components/ui/avatar";
import { PageSkeleton } from "@/components/ui/skeleton";
import { timeline } from "@/lib/crm/activities";
import { clientsOfPerson, getPerson } from "@/lib/crm/records";
import { personName } from "@/lib/format";
import { z } from "zod";

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
  if (!row) notFound();
  const { person, organization } = row;
  const [tl, clients] = await Promise.all([timeline("person", id), clientsOfPerson(id, person.organizationId)]);
  const name = personName(person);
  return (
    <>
      <RecordHeader
        entity="person"
        id={id}
        title={name}
        archived={!!person.archivedAt}
        avatar={<Avatar name={name} size="xl" />}
        sub={[person.title, organization?.name].filter(Boolean).join(" at ") || undefined}
      />
      <RecordBody
        side={
          <>
            <PersonDetails person={person} organization={organization} />
            {organization ? <OrganizationCard org={organization} /> : null}
            <RelatedClients clients={clients} create={{ kind: "client", defaults: { personId: id, personName: name, organizationId: organization?.id, organizationName: organization?.name } }} />
            <FilesCard files={tl.files} emailFiles={tl.emailFiles} />
          </>
        }
      >
        <FocusLine planned={tl.planned} lastContactAt={tl.lastContactAt} context={{ type: "person", id }} />
        <Composer links={{ personId: id }} recipient={{ personId: id, name, email: person.email }} />
        <Timeline planned={tl.planned} pinned={tl.pinned} past={tl.past} context={{ type: "person", id }} fileLinks={{ personId: id, organizationId: person.organizationId }} files={tl.files} emptyHint={`Log a call, note or email with ${person.firstName} above and it shows up here.`} />
      </RecordBody>
    </>
  );
}
