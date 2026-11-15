import type { Metadata } from "next";
import { desc } from "drizzle-orm";
import { Suspense } from "react";
import { CampaignList } from "@/components/email/campaign-list";
import { PageSkeleton } from "@/components/ui/skeleton";
import { getDb, schema } from "@/db";
import { campaignDelivery } from "@/lib/email/delivery";

export const metadata: Metadata = { title: "Campaigns" };

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
  const delivery = await campaignDelivery(rows.filter((r) => r.status === "sent" || r.status === "sending").map((r) => r.id));
  return (
    <CampaignList
      rows={rows.map((r) => {
        const d = delivery.get(r.id);
        return { ...r, deliveryRate: d?.reported ? d.deliveryRate : null, openRate: d?.opened ? d.openRate : null };
      })}
    />
  );
}
