import type { Metadata } from "next";
import { desc } from "drizzle-orm";
import { Suspense } from "react";
import { CampaignList } from "@/components/email/campaign-list";
import { PageSkeleton } from "@/components/ui/skeleton";
import { getDb, schema } from "@/db";

export const metadata: Metadata = { title: "Email" };

export default function EmailPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Campaigns />
    </Suspense>
  );
}

async function Campaigns() {
  const db = await getDb();
  const c = schema.campaigns;
  const rows = await db
    .select({ id: c.id, name: c.name, subject: c.subject, status: c.status, scheduledAt: c.scheduledAt, sentAt: c.sentAt, recipientCount: c.recipientCount, sendError: c.sendError, updatedAt: c.updatedAt })
    .from(c)
    .orderBy(desc(c.updatedAt))
    .limit(200);
  return <CampaignList rows={rows} />;
}
