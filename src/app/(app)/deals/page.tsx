import type { Metadata } from "next";
import { Suspense } from "react";
import { DealsView } from "@/components/deals/deals-view";
import { PageSkeleton } from "@/components/ui/skeleton";
import { requireUser } from "@/lib/auth";
import { getAppData } from "@/lib/crm/context";
import { listDeals } from "@/lib/crm/records";

export const metadata: Metadata = { title: "Deals" };

export default function DealsPage({ searchParams }: PageProps<"/deals">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Deals searchParams={searchParams} />
    </Suspense>
  );
}

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

async function Deals({ searchParams }: Pick<PageProps<"/deals">, "searchParams">) {
  const sp = await searchParams;
  const [user, app] = await Promise.all([requireUser(), getAppData()]);
  // The URL wins; otherwise each teammate's last choice.
  const view = one(sp.view) === "table" || one(sp.view) === "board" ? (one(sp.view) as "board" | "table") : (user.prefs.dealsView ?? "board");
  const pipelineId = app.pipelines.find((p) => p.id === (one(sp.pipeline) ?? user.prefs.pipelineId))?.id ?? app.pipelines[0]?.id ?? "";
  const owner = one(sp.owner);
  const status = view === "board" ? "open" : ((one(sp.status) as "open" | "won" | "lost" | "all" | undefined) ?? "open");
  const deals = pipelineId
    ? await listDeals({
        pipelineId,
        status,
        ownerId: owner === "me" ? user.id : owner,
        q: one(sp.q),
        sort: view === "table" ? one(sp.sort) : undefined,
        dir: one(sp.dir) as "asc" | "desc" | undefined,
      })
    : [];
  return <DealsView deals={deals} view={view} pipelineId={pipelineId} />;
}
