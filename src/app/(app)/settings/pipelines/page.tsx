import type { Metadata } from "next";
import { count, isNull } from "drizzle-orm";
import { Suspense } from "react";
import { PipelineSettings } from "@/components/settings/pipelines";
import { PageSkeleton } from "@/components/ui/skeleton";
import { getDb, schema } from "@/db";
import { requireAdminPage } from "@/lib/auth";

export const metadata: Metadata = { title: "Pipelines" };

export default function PipelinesPage() {
  return (
    <Suspense fallback={<PageSkeleton rows={6} />}>
      <Pipelines />
    </Suspense>
  );
}

async function Pipelines() {
  await requireAdminPage();
  const db = await getDb();
  const rows = await db.select({ stageId: schema.deals.stageId, n: count() }).from(schema.deals).where(isNull(schema.deals.archivedAt)).groupBy(schema.deals.stageId);
  return <PipelineSettings dealCounts={Object.fromEntries(rows.map((r) => [r.stageId, r.n]))} />;
}
