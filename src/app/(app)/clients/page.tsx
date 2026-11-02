import type { Metadata } from "next";
import { Suspense } from "react";
import { ClientsView } from "@/components/clients/clients-view";
import { PageSkeleton } from "@/components/ui/skeleton";
import { requireUser } from "@/lib/auth";
import { clientCategories, type ClientCategory } from "@/lib/constants";
import { getAppData } from "@/lib/crm/context";
import { allClientTags, clientCounts, listClients } from "@/lib/crm/records";

export const metadata: Metadata = { title: "Clients" };

export default function ClientsPage({ searchParams }: PageProps<"/clients">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Clients searchParams={searchParams} />
    </Suspense>
  );
}

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

async function Clients({ searchParams }: Pick<PageProps<"/clients">, "searchParams">) {
  const sp = await searchParams;
  const [user, app] = await Promise.all([requireUser(), getAppData()]);
  const category: ClientCategory = clientCategories.find((c) => c === one(sp.category)) ?? "prospective";
  // The URL wins; otherwise each teammate's last choice.
  const view = one(sp.view) === "table" || one(sp.view) === "board" ? (one(sp.view) as "board" | "table") : (user.prefs.clientsView ?? "board");
  const options = app.pipelines.filter((p) => p.category === category);
  const asked = one(sp.pipeline);
  // The board shows one pipeline; the table can show them all.
  const pipelineId = options.find((p) => p.id === (asked ?? user.prefs.clientPipelines?.[category]))?.id ?? (view === "table" && !asked ? null : (options[0]?.id ?? null));
  const owner = one(sp.owner);
  const [rows, counts, tags] = await Promise.all([
    options.length
      ? listClients({
          category,
          pipelineId: pipelineId ?? undefined,
          ownerId: owner === "me" ? user.id : owner,
          q: one(sp.q),
          health: one(sp.health),
          serviceId: one(sp.service),
          churnReason: one(sp.reason),
          tag: one(sp.tag),
          sort: view === "table" ? one(sp.sort) : undefined,
          dir: one(sp.dir) as "asc" | "desc" | undefined,
        })
      : [],
    clientCounts(),
    allClientTags(),
  ]);
  return <ClientsView rows={rows} view={view} category={category} pipelineId={pipelineId} counts={counts} tags={tags} />;
}
