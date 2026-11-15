import type { Metadata } from "next";
import { asc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";
import { CampaignEditor } from "@/components/email/campaign-editor";
import { PageSkeleton } from "@/components/ui/skeleton";
import { getDb, schema } from "@/db";
import { emailBrand } from "@/lib/brand";
import { campaignReplyTo } from "@/lib/email";
import { audienceCount, campaignAudience, renderCampaign } from "@/lib/email/campaigns";
import { campaignDelivery } from "@/lib/email/delivery";
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
  const sent = c.status === "sent" || c.status === "sending";
  const [tags, clientTags, count, brand, audiences, delivery] = await Promise.all([
    allTags(),
    allClientTags(),
    sent ? Promise.resolve(c.recipientCount) : campaignAudience(c).then(audienceCount),
    emailBrand(),
    db.select({ id: schema.audiences.id, name: schema.audiences.name, filters: schema.audiences.filters }).from(schema.audiences).orderBy(asc(schema.audiences.name)),
    sent ? campaignDelivery([c.id]).then((m) => m.get(c.id) ?? null) : Promise.resolve(null),
  ]);
  // Drafts always preview with the current brand kit.
  const html = sent ? c.html : await renderCampaign(c.body, c.previewText);
  return (
    <CampaignEditor
      campaign={{ ...c, html }}
      tags={tags}
      clientTags={clientTags}
      initialCount={count}
      hasAddress={!!brand.postalAddress}
      audiences={audiences}
      defaultReplyTo={campaignReplyTo(null, brand.replyTo) ?? null}
      delivery={delivery}
    />
  );
}
