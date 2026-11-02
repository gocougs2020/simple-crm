import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";
import { CampaignEditor } from "@/components/email/campaign-editor";
import { PageSkeleton } from "@/components/ui/skeleton";
import { getDb, schema } from "@/db";
import { emailBrand } from "@/lib/brand";
import { audienceCount, renderCampaign } from "@/lib/email/campaigns";
import { allClientTags, allTags } from "@/lib/crm/records";

export const metadata: Metadata = { title: "Campaign" };

export default function CampaignPage({ params }: PageProps<"/email/campaigns/[id]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Campaign params={params} />
    </Suspense>
  );
}

async function Campaign({ params }: Pick<PageProps<"/email/campaigns/[id]">, "params">) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const db = await getDb();
  const [c] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id));
  if (!c) notFound();
  const [tags, clientTags, count, brand] = await Promise.all([allTags(), allClientTags(), audienceCount(c.audience), emailBrand()]);
  // Drafts always preview with the current brand kit.
  const html = c.status === "draft" || c.status === "scheduled" ? await renderCampaign(c.body, c.previewText) : c.html;
  return <CampaignEditor campaign={{ ...c, html }} tags={tags} clientTags={clientTags} initialCount={c.status === "sent" ? c.recipientCount : count} hasAddress={!!brand.postalAddress} />;
}
