import type { Metadata } from "next";
import { asc, sql } from "drizzle-orm";
import { Suspense } from "react";
import { AudienceList } from "@/components/email/audiences";
import { PageSkeleton } from "@/components/ui/skeleton";
import { getDb, schema } from "@/db";
import { audienceCount } from "@/lib/email/campaigns";

export const metadata: Metadata = { title: "Audiences" };

export default function AudiencesPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Audiences />
    </Suspense>
  );
}

async function Audiences() {
  const db = await getDb();
  const a = schema.audiences;
  const rows = await db
    .select({
      id: a.id,
      name: a.name,
      description: a.description,
      filters: a.filters,
      createdBy: a.createdBy,
      updatedAt: a.updatedAt,
      campaigns: sql<number>`(select count(*)::int from campaigns c where c.audience_id = ${a.id})`,
    })
    .from(a)
    .orderBy(asc(a.name))
    .limit(200);
  // Counted now, so the list shows who each audience reaches today.
  const counts = await Promise.all(rows.map((r) => audienceCount(r.filters)));
  return <AudienceList rows={rows.map((r, i) => ({ ...r, count: counts[i] }))} />;
}
