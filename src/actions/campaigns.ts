"use server";

import { refresh } from "next/cache";
import { after } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { run, type Result } from "@/lib/action";
import { ActionError, actionUser } from "@/lib/auth";
import { emailBrand } from "@/lib/brand";
import { audienceCount, renderCampaign, runDueCampaigns } from "@/lib/email/campaigns";
import { sendEmail } from "@/lib/email";
import { escapeHtml, fillMergeTags, fillMergeTagsHtml, mergeValues } from "@/lib/email/merge-tags";
import { siteOrigin } from "@/lib/origin";
import { sanitizeHtml } from "@/lib/safe-html";

const { campaigns } = schema;
const uuid = z.uuid();

const audienceSchema = z.object({
  tags: z.array(z.string().max(40)).max(50).optional(),
  ownerIds: z.array(uuid).max(100).optional(),
  organizationIds: z.array(uuid).max(500).optional(),
  stageIds: z.array(uuid).max(100).optional(),
  personIds: z.array(uuid).max(5000).optional(),
});

export async function createCampaign(): Promise<Result<{ id: string }>> {
  return run(async () => {
    const user = await actionUser();
    const db = await getDb();
    const [row] = await db
      .insert(campaigns)
      .values({ name: "Untitled campaign", body: "<p>Hi {{first_name|there}},</p><p></p>", createdBy: user.id })
      .returning({ id: campaigns.id });
    return row;
  });
}

const saveSchema = z.object({
  name: z.string().trim().min(1, "Name the campaign.").max(120),
  subject: z.string().trim().max(200),
  previewText: z.string().trim().max(200).nullable(),
  body: z.string().max(300_000),
  audience: audienceSchema,
});

/** Saves the draft and re-renders its HTML with the current brand kit. Sent and sending campaigns can't change. */
export async function saveCampaign(campaignId: string, input: z.input<typeof saveSchema>): Promise<Result<{ recipients: number; html: string }>> {
  return run(async () => {
    await actionUser();
    const data = saveSchema.parse(input);
    const db = await getDb();
    const [c] = await db.select({ status: campaigns.status }).from(campaigns).where(eq(campaigns.id, uuid.parse(campaignId)));
    if (!c) throw new ActionError("This campaign was deleted.");
    if (c.status === "sent" || c.status === "sending") throw new ActionError("This campaign has already gone out and can't be changed.");
    const body = sanitizeHtml(data.body);
    const html = await renderCampaign(body, data.previewText);
    await db
      .update(campaigns)
      .set({ ...data, body, html, updatedAt: new Date() })
      .where(eq(campaigns.id, campaignId));
    return { recipients: await audienceCount(data.audience), html };
  });
}

export async function countAudience(audience: z.input<typeof audienceSchema>) {
  await actionUser();
  return audienceCount(audienceSchema.parse(audience));
}

/** Sends the campaign to yourself, filled in as if you were the recipient. */
export async function sendCampaignTest(campaignId: string): Promise<Result<{ to: string }>> {
  return run(async () => {
    const user = await actionUser();
    const db = await getDb();
    const [c] = await db.select().from(campaigns).where(eq(campaigns.id, uuid.parse(campaignId)));
    if (!c?.html) throw new ActionError("Save the campaign first.");
    const [first, ...rest] = user.name.split(" ");
    const values = mergeValues({ firstName: first, lastName: rest.join(" ") || null, organizationName: (await emailBrand()).workspaceName });
    await sendEmail({
      to: user.email,
      subject: `[Test] ${fillMergeTags(c.subject || c.name, values)}`,
      html: fillMergeTagsHtml(c.html, values).replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, escapeHtml(`${await siteOrigin()}/unsubscribe`)),
      tags: [{ name: "type", value: "campaign-test" }],
    });
    return { to: user.email };
  });
}

/** Schedules for later, or (with no time) sends now in the background. The claim is one conditional update, so it can't start twice. */
export async function scheduleCampaign(campaignId: string, at: string | null): Promise<Result> {
  return run(async () => {
    await actionUser();
    const db = await getDb();
    const [c] = await db.select().from(campaigns).where(eq(campaigns.id, uuid.parse(campaignId)));
    if (!c) throw new ActionError("This campaign was deleted.");
    if (!c.subject.trim()) throw new ActionError("Add a subject line first.");
    if (!c.html) throw new ActionError("Write the email first.");
    if (!(await emailBrand()).postalAddress) throw new ActionError("Add your postal address in Settings → Email and brand first. Marketing email must include one.");
    if (!(await audienceCount(c.audience))) throw new ActionError("No one matches this audience yet.");
    const when = at ? new Date(z.iso.datetime({ offset: true }).parse(at)) : new Date();
    if (at && when.getTime() < Date.now() - 60_000) throw new ActionError("Pick a time in the future.");
    const [claimed] = await db
      .update(campaigns)
      .set({ status: "scheduled", scheduledAt: when, sendError: null, updatedAt: new Date() })
      .where(and(eq(campaigns.id, c.id), inArray(campaigns.status, ["draft", "scheduled"])))
      .returning({ id: campaigns.id });
    if (!claimed) throw new ActionError("This campaign is already sending.");
    if (!at) {
      const origin = await siteOrigin();
      // Respond right away; the send continues in the background (and the cron resumes it if it's cut short).
      after(() => runDueCampaigns(origin, c.id).catch((err) => console.error("[campaigns] send", err)));
    }
    refresh();
  });
}

export async function unscheduleCampaign(campaignId: string): Promise<Result> {
  return run(async () => {
    await actionUser();
    const db = await getDb();
    await db
      .update(campaigns)
      .set({ status: "draft", scheduledAt: null, updatedAt: new Date() })
      .where(and(eq(campaigns.id, uuid.parse(campaignId)), eq(campaigns.status, "scheduled")));
    refresh();
  });
}

export async function duplicateCampaign(campaignId: string): Promise<Result<{ id: string }>> {
  return run(async () => {
    const user = await actionUser();
    const db = await getDb();
    const [c] = await db.select().from(campaigns).where(eq(campaigns.id, uuid.parse(campaignId)));
    if (!c) throw new ActionError("This campaign was deleted.");
    const [row] = await db
      .insert(campaigns)
      .values({ name: `${c.name} (copy)`, subject: c.subject, previewText: c.previewText, body: c.body, html: c.html, audience: c.audience, createdBy: user.id })
      .returning({ id: campaigns.id });
    refresh();
    return row;
  });
}

export async function deleteCampaign(campaignId: string): Promise<Result> {
  return run(async () => {
    await actionUser();
    const db = await getDb();
    const rows = await db
      .delete(campaigns)
      .where(and(eq(campaigns.id, uuid.parse(campaignId)), inArray(campaigns.status, ["draft", "scheduled"])))
      .returning({ id: campaigns.id });
    if (!rows.length) throw new ActionError("Sent campaigns stay for the record.");
    refresh();
  });
}
