import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { currentRecordId } from "@/lib/crm/merged";
import { Suspense } from "react";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { Composer } from "@/components/activity/composer";
import { FocusLine } from "@/components/activity/focus-line";
import { RecordSummary } from "@/components/records/record-summary";
import { Timeline } from "@/components/activity/timeline";
import { BillingCard } from "@/components/clients/billing-card";
import { CategoryActions, CategoryBadge, CategoryDate, HealthBadge } from "@/components/clients/client-controls";
import { PerformanceCard } from "@/components/clients/client-panels";
import { ProductLinesCard } from "@/components/clients/product-tag";
import { ClientPeopleCard } from "@/components/clients/client-people";
import { StageBar } from "@/components/clients/client-controls";
import { DynamicMarker } from "@/components/dynamic-marker";
import { CallButton } from "@/components/phone/contact-actions";
import { FilesCard } from "@/components/files/files-panel";
import { ClientDetails, OrganizationCard } from "@/components/records/details";
import { RecordBody, RecordHeader } from "@/components/records/record-header";
import { PageSkeleton, Skeleton } from "@/components/ui/skeleton";
import { recordTimeline } from "@/lib/crm/activities";
import { getAppData } from "@/lib/crm/context";
import { clientPeople, getClient, metricsOf, otherOrganizationsOfClient } from "@/lib/crm/records";
import { formatMoney, personName } from "@/lib/format";

export async function generateMetadata({ params }: PageProps<"/clients/[id]">): Promise<Metadata> {
  const { id } = await params;
  const row = z.uuid().safeParse(id).success ? await getClient(id) : null;
  return { title: row?.client.name ?? "Client" };
}

export default function ClientPage({ params }: PageProps<"/clients/[id]">) {
  return (
    <>
      <DynamicMarker />
      <Suspense fallback={<PageSkeleton />}>
        <Client params={params} />
      </Suspense>
    </>
  );
}

async function Client({ params }: Pick<PageProps<"/clients/[id]">, "params">) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const row = await getClient(id);
  if (!row) {
    // A link to a record that was merged away opens the one it was merged into.
    const current = await currentRecordId("client", id);
    if (current !== id) redirect(`/clients/${current}`);
    notFound();
  }
  const { client, person, organization } = row;
  const c = client.category;
  // Their own private mail with this record is on the timeline, for them alone.
  const viewer = await requireUser();
  const [tl, app, metrics, associated, alsoTied] = await Promise.all([
    recordTimeline("client", id, viewer.id),
    getAppData(),
    metricsOf(id),
    clientPeople(client),
    otherOrganizationsOfClient(id),
  ]);
  // Everyone a call, email, text or meeting from this page can be with: the contact, then decision makers, then everyone else.
  const contacts = associated.map(({ person: p, source }) => ({
    personId: p.id,
    name: personName(p),
    email: p.email,
    phone: p.phone,
    textOptedOut: !!p.textOptOutAt,
    detail: source === "contact" ? ["Contact", p.title].filter(Boolean).join(", ") : p.title,
    starred: p.decisionMaker,
  }));
  const stage = app.pipelines.flatMap((p) => p.stages).find((s) => s.id === client.stageId);
  // What Stripe bills them a month, after discounts. Past clients' subscriptions have ended, so there's nothing running to show.
  const monthly = c === "past" ? 0 : client.stripeMrr;

  return (
    <>
      <RecordHeader
        entity="client"
        id={id}
        title={client.name}
        archived={!!client.archivedAt}
        sub={
          <>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <CategoryBadge category={c} />
              {c === "current" ? <HealthBadge health={client.health} /> : null}
              {c === "prospective" ? (
                <>
                  <span className="text-[15px] font-semibold text-primary tabular-nums">{formatMoney(client.value, client.currency)}</span>
                  {stage && client.value ? <span className="tabular-nums">· {formatMoney(Math.round((client.value * stage.probability) / 100), client.currency)} weighted</span> : null}
                </>
              ) : monthly ? (
                <span className="text-[15px] font-semibold text-primary tabular-nums">
                  {formatMoney(monthly, client.currency)}/mo
                </span>
              ) : null}
            </span>
            {/* Its own line, so on a phone the dates and names wrap together instead of leaving a stray "·". */}
            <span className="mt-1 flex flex-wrap gap-x-1.5 text-muted [&>:empty]:hidden [&>:not(:empty)~:not(:empty)]:before:mr-1.5 [&>:not(:empty)~:not(:empty)]:before:content-['·']">
              <span>
                <CategoryDate category={c} startedOn={client.startedOn} endedOn={client.endedOn} expectedCloseDate={client.expectedCloseDate} />
              </span>
              {organization && organization.name !== client.name ? <span>{organization.name}</span> : null}
              {person ? <span>{personName(person)}</span> : null}
            </span>
          </>
        }
        actions={
          <span className="flex items-center gap-2">
            {person ? <CallButton target={{ name: personName(person), phone: person.phone, personId: person.id, clientId: id }} /> : organization ? <CallButton target={{ name: organization.name, phone: organization.phone, organizationId: organization.id, clientId: id }} /> : null}
            <CategoryActions clientId={id} name={client.name} category={c} />
          </span>
        }
      />
      <div className="border-b border-line pt-3">
        <StageBar clientId={id} stageId={client.stageId} category={c} stageChangedAt={client.stageChangedAt} />
      </div>
      <RecordBody
        side={
          <>
            <ProductLinesCard clientId={id} lines={client.productLines} />
            <ClientDetails client={client} person={person} organization={organization} />
            <ClientPeopleCard
              clientId={id}
              organizationName={organization?.name ?? null}
              people={associated.map(({ person: p, source }) => ({ id: p.id, name: personName(p), title: p.title, email: p.email, decisionMaker: p.decisionMaker, source }))}
            />
            {/* Organizations kept from clients merged into this one: their people are this client's people too. */}
            {alsoTied.map((org) => (
              <OrganizationCard key={org.id} org={org} title="Also tied to" />
            ))}
            {/* Billing shows on every client, prospects included: someone can be paying for one product while being sold another. */}
            <Suspense fallback={<Skeleton className="h-28 rounded-xl" />}>
              <BillingCard clientId={id} syncedAt={client.stripeSyncedAt} suggest={person?.email ?? organization?.name ?? client.name} />
            </Suspense>
            {c === "current" || metrics.length ? <PerformanceCard clientId={id} metrics={metrics} readOnly={c !== "current"} /> : null}
            <FilesCard files={tl.files} emailFiles={tl.emailFiles} links={{ clientId: id, personId: client.personId, organizationId: client.organizationId }} />
          </>
        }
      >
        <RecordSummary entity="client" id={id} summary={client.summary} summaryAt={client.summaryAt} />
        <FocusLine planned={tl.planned} lastContactAt={tl.lastContactAt} context={{ type: "client", id, category: c }} />
        <Composer links={{ clientId: id }} recipient={contacts.find((c) => c.personId === client.personId) ?? contacts[0] ?? null} contacts={contacts} />
        <Timeline
          planned={tl.planned}
          pinned={tl.pinned}
          past={tl.past} hasMore={tl.hasMore} counts={tl.counts}
          context={{ type: "client", id, category: c }}
          fileLinks={{ clientId: id, personId: client.personId, organizationId: client.organizationId }}
          files={tl.files}
          emptyHint={c === "prospective" ? "Calls, emails and notes with this prospect show up here, along with every stage change." : "Every interaction, email, billing change and stage move with this client shows up here."}
        />
      </RecordBody>
    </>
  );
}
