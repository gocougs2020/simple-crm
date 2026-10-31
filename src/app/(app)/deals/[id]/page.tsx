import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DynamicMarker } from "@/components/dynamic-marker";
import { z } from "zod";
import { Composer } from "@/components/activity/composer";
import { Timeline } from "@/components/activity/timeline";
import { DealOutcome, StageBar } from "@/components/deals/deal-controls";
import { FilesPanel } from "@/components/files/files-panel";
import { DealDetails, OrganizationCard, PersonCard } from "@/components/records/details";
import { RecordBody, RecordHeader } from "@/components/records/record-header";
import { PageSkeleton } from "@/components/ui/skeleton";
import { timeline } from "@/lib/crm/activities";
import { getDeal } from "@/lib/crm/records";
import { getAppData } from "@/lib/crm/context";
import { formatMoney, personName } from "@/lib/format";

export async function generateMetadata({ params }: PageProps<"/deals/[id]">): Promise<Metadata> {
  const { id } = await params;
  const row = z.uuid().safeParse(id).success ? await getDeal(id) : null;
  return { title: row?.deal.title ?? "Deal" };
}

export default function DealPage({ params }: PageProps<"/deals/[id]">) {
  return (
    <>
      <DynamicMarker />
      <Suspense fallback={<PageSkeleton />}>
        <Deal params={params} />
      </Suspense>
    </>
  );
}

async function Deal({ params }: Pick<PageProps<"/deals/[id]">, "params">) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const row = await getDeal(id);
  if (!row) notFound();
  const { deal, person, organization } = row;
  const [tl, app] = await Promise.all([timeline("deal", id), getAppData()]);
  const stage = app.pipelines.flatMap((p) => p.stages).find((s) => s.id === deal.stageId);
  return (
    <>
      <RecordHeader
        entity="deal"
        id={id}
        title={deal.title}
        archived={!!deal.archivedAt}
        sub={
          <span className="flex flex-wrap items-center gap-x-2">
            <span className="text-[15px] font-semibold text-primary tabular-nums">{formatMoney(deal.value, deal.currency)}</span>
            {stage && deal.status === "open" && deal.value ? <span className="tabular-nums">· {formatMoney(Math.round((deal.value * stage.probability) / 100), deal.currency)} weighted</span> : null}
            {organization ? <span>· {organization.name}</span> : null}
            {person ? <span>· {personName(person)}</span> : null}
          </span>
        }
        actions={<DealOutcome dealId={id} status={deal.status} lostReason={deal.lostReason} closedAt={deal.closedAt} />}
      />
      <div className="border-b border-line pt-3">
        <StageBar dealId={id} stageId={deal.stageId} status={deal.status} stageChangedAt={deal.stageChangedAt} />
      </div>
      <RecordBody
        side={
          <>
            <DealDetails deal={deal} person={person} organization={organization} />
            {person ? <PersonCard person={person} /> : null}
            {organization ? <OrganizationCard org={organization} /> : null}
            <FilesPanel files={tl.files} links={{ dealId: id, personId: deal.personId, organizationId: deal.organizationId }} />
          </>
        }
      >
        <Composer links={{ dealId: id }} recipient={person ? { personId: person.id, name: personName(person), email: person.email } : null} />
        <Timeline planned={tl.planned} pinned={tl.pinned} past={tl.past} context={{ type: "deal", id }} emptyHint="Calls, emails and notes about this deal show up here, along with every stage change." />
      </RecordBody>
    </>
  );
}
