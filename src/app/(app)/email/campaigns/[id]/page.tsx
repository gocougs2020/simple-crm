import type { Metadata } from "next";
import { asc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";
import { CampaignEditor } from "@/components/email/campaign-editor";
import { PageSkeleton } from "@/components/ui/skeleton";
import { getDb, schema } from "@/db";
import { emailBrand } from "@/lib/brand";
import { audienceCount, campaignAudience, campaignCreatorEmail, renderCampaign, textCampaignStats } from "@/lib/email/campaigns";
import { TextCampaignEditor } from "@/components/email/text-campaign-editor";
import { requireUser } from "@/lib/auth";
import { numbersFor } from "@/lib/twilio/access";
import { campaignDelivery } from "@/lib/email/delivery";
import { allClientTags, allIndustries, allTags } from "@/lib/crm/records";

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
  if (c.channel === "text") {
    const [tags, clientTags, industries, count, audiences, stats, numbers] = await Promise.all([
      allTags(),
      allClientTags(),
      allIndustries(),
      sent ? Promise.resolve(c.recipientCount) : campaignAudience(c).then((a) => audienceCount(a, "text")),
      db.select({ id: schema.audiences.id, name: schema.audiences.name, filters: schema.audiences.filters }).from(schema.audiences).orderBy(asc(schema.audiences.name)),
      sent ? textCampaignStats(c.id) : Promise.resolve(null),
      // Its own number too, so a sent campaign names it even after access changed.
      db.select({ id: schema.phoneNumbers.id, label: schema.phoneNumbers.label, number: schema.phoneNumbers.number, archivedAt: schema.phoneNumbers.archivedAt }).from(schema.phoneNumbers).orderBy(asc(schema.phoneNumbers.label)),
    ]);
    const user = await requireUser();
    const mine = new Set((await numbersFor(user)).map((n) => n.id));
    return (
      <TextCampaignEditor
        campaign={c}
        tags={tags}
        clientTags={clientTags}
        industries={industries}
        initialCount={count}
        audiences={audiences}
        stats={stats}
        numbers={numbers.filter((n) => n.id === c.phoneNumberId || (mine.has(n.id) && !n.archivedAt))}
      />
    );
  }
  const [tags, clientTags, industries, count, brand, audiences, delivery, creatorEmail] = await Promise.all([
    allTags(),
    allClientTags(),
    allIndustries(),
    sent ? Promise.resolve(c.recipientCount) : campaignAudience(c).then(audienceCount),
    emailBrand(),
    db.select({ id: schema.audiences.id, name: schema.audiences.name, filters: schema.audiences.filters }).from(schema.audiences).orderBy(asc(schema.audiences.name)),
    sent ? campaignDelivery([c.id]).then((m) => m.get(c.id) ?? null) : Promise.resolve(null),
    campaignCreatorEmail(c.createdBy),
  ]);
  // Drafts always preview with the current brand kit.
  const html = sent ? c.html : await renderCampaign(c.body, c.previewText);
  return (
    <CampaignEditor
      campaign={{ ...c, html }}
      tags={tags}
      clientTags={clientTags}
      industries={industries}
      initialCount={count}
      hasAddress={!!brand.postalAddress}
      audiences={audiences}
      defaultReplyTo={creatorEmail}
      delivery={delivery}
    />
  );
}
