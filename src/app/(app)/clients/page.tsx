import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Suspense } from "react";
import { appConfig } from "@/app.config";
import { ClientsView } from "@/components/clients/clients-view";
import { PageSkeleton } from "@/components/ui/skeleton";
import { requireUser } from "@/lib/auth";
import { CLIENTS_TAB_COOKIE, clientCategories, type ClientCategory } from "@/lib/constants";
import { getAppData } from "@/lib/crm/context";
import { allClientTags, clientCounts, listClients } from "@/lib/crm/records";
import { productFamilies } from "@/lib/product-rules";

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
  // The URL wins; otherwise the tab last opened in this browser session, then prospects.
  const saved = (await cookies()).get(CLIENTS_TAB_COOKIE)?.value;
  const category: ClientCategory = clientCategories.find((c) => c === one(sp.category)) ?? clientCategories.find((c) => c === saved) ?? "prospective";
  // The URL wins; otherwise each teammate's last choice, then the deployment's default.
  const view = one(sp.view) === "table" || one(sp.view) === "board" ? (one(sp.view) as "board" | "table") : (user.prefs.clientsView ?? appConfig.layout.defaultClientsView);
  const options = app.pipelines.filter((p) => p.category === category);
  // The board shows one pipeline; the table shows them all.
  const pipelineId = view === "table" ? null : (options.find((p) => p.id === (one(sp.pipeline) ?? user.prefs.clientPipelines?.[category]))?.id ?? options[0]?.id ?? null);
  const owner = one(sp.owner);
  const [rows, counts, tags] = await Promise.all([
    options.length
      ? listClients({
          category,
          pipelineId: pipelineId ?? undefined,
          ownerId: owner === "me" ? user.id : owner,
          health: one(sp.health),
          churnReason: one(sp.reason),
          billing: one(sp.billing),
          productLine: productFamilies.find((f) => f === one(sp.product)),
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
