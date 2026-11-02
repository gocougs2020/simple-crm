import type { Metadata } from "next";
import { sql } from "drizzle-orm";
import { Suspense } from "react";
import { ServiceSettings } from "@/components/settings/services";
import { PageSkeleton } from "@/components/ui/skeleton";
import { getDb, schema } from "@/db";
import { requireAdminPage } from "@/lib/auth";

export const metadata: Metadata = { title: "Services" };

export default function ServicesPage() {
  return (
    <Suspense fallback={<PageSkeleton rows={6} />}>
      <Services />
    </Suspense>
  );
}

async function Services() {
  await requireAdminPage();
  const db = await getDb();
  const cs = schema.clientServices;
  const rows = await db
    .select({ serviceId: cs.serviceId, active: sql<number>`count(*) filter (where ${cs.endedOn} is null or ${cs.endedOn} > current_date)::int`, total: sql<number>`count(distinct ${cs.clientId})::int` })
    .from(cs)
    .groupBy(cs.serviceId);
  return <ServiceSettings usage={Object.fromEntries(rows.map((r) => [r.serviceId, { active: r.active, total: r.total }]))} />;
}
