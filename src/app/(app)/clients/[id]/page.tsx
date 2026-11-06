import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";
import { Composer } from "@/components/activity/composer";
import { FocusLine } from "@/components/activity/focus-line";
import { Timeline } from "@/components/activity/timeline";
import { BillingCard } from "@/components/clients/billing-card";
import { CategoryActions, CategoryBadge, CategoryDate, HealthBadge } from "@/components/clients/client-controls";
import { PerformanceCard, ServicesCard } from "@/components/clients/client-panels";
import { StageBar } from "@/components/clients/client-controls";
import { DynamicMarker } from "@/components/dynamic-marker";
import { FilesCard } from "@/components/files/files-panel";
import { ClientDetails } from "@/components/records/details";
import { RecordBody, RecordHeader } from "@/components/records/record-header";
import { PageSkeleton, Skeleton } from "@/components/ui/skeleton";
import { monthlyFactor } from "@/lib/constants";
import { timeline } from "@/lib/crm/activities";
import { getAppData } from "@/lib/crm/context";
import { getClient, metricsOf, servicesOf } from "@/lib/crm/records";
import { dayKey, formatMoney, personName } from "@/lib/format";

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
  if (!row) notFound();
  const { client, person, organization } = row;
  const c = client.category;
  const [tl, app, services, metrics] = await Promise.all([
    timeline("client", id),
    getAppData(),
    servicesOf(id),
    metricsOf(id),
  ]);
  const stage = app.pipelines.flatMap((p) => p.stages).find((s) => s.id === client.stageId);
  const today = dayKey(new Date(), app.workspace.timezone);
  // A past client's subscription is what ended on their latest end date (a client won back and lost again has two periods).
  const lastEnded = services.reduce<string | null>((max, s) => (s.endedOn && (!max || s.endedOn > max) ? s.endedOn : max), null);
  const monthly = Math.round(services.filter((s) => (c === "past" ? s.endedOn === lastEnded : !s.endedOn || s.endedOn > today)).reduce((sum, s) => sum + s.price * monthlyFactor[s.interval], 0));

  return (
    <>
      <RecordHeader
        entity="client"
        id={id}
        title={client.name}
        archived={!!client.archivedAt}
        sub={
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
                {formatMoney(monthly, client.currency)}/mo{c === "past" ? <span className="font-normal text-muted"> when they left</span> : null}
              </span>
            ) : null}
            <span className="text-muted">
              <CategoryDate category={c} startedOn={client.startedOn} endedOn={client.endedOn} expectedCloseDate={client.expectedCloseDate} />
            </span>
            {organization && organization.name !== client.name ? <span>· {organization.name}</span> : null}
            {person ? <span>· {personName(person)}</span> : null}
          </span>
        }
        actions={<CategoryActions clientId={id} name={client.name} category={c} previousServiceIds={c === "past" ? [...new Set(services.filter((s) => s.endedOn === lastEnded).map((s) => s.serviceId))] : undefined} />}
      />
      <div className="border-b border-line pt-3">
        <StageBar clientId={id} stageId={client.stageId} category={c} stageChangedAt={client.stageChangedAt} />
      </div>
      <RecordBody
        side={
          <>
            <ClientDetails client={client} person={person} organization={organization} />
            {c !== "prospective" ? (
              <ServicesCard clientId={id} category={c} rows={services}>
                <Suspense fallback={<Skeleton className="mt-3 h-16 rounded-lg" />}>
                  <BillingCard clientId={id} customerId={client.stripeCustomerId} suggest={person?.email ?? organization?.name ?? client.name} />
                </Suspense>
              </ServicesCard>
            ) : null}
            {c === "current" || metrics.length ? <PerformanceCard clientId={id} metrics={metrics} readOnly={c !== "current"} /> : null}
            <FilesCard files={tl.files} emailFiles={tl.emailFiles} />
          </>
        }
      >
        <FocusLine planned={tl.planned} lastContactAt={tl.lastContactAt} context={{ type: "client", id, category: c }} />
        <Composer links={{ clientId: id }} recipient={person ? { personId: person.id, name: personName(person), email: person.email } : null} />
        <Timeline
          planned={tl.planned}
          pinned={tl.pinned}
          past={tl.past}
          context={{ type: "client", id, category: c }}
          fileLinks={{ clientId: id, personId: client.personId, organizationId: client.organizationId }}
          files={tl.files}
          emptyHint={c === "prospective" ? "Calls, emails and notes with this prospect show up here, along with every stage change." : "Every interaction, email, service change and stage move with this client shows up here."}
        />
      </RecordBody>
    </>
  );
}
