"use server";

import { refresh } from "next/cache";
import { after } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { run, type Result } from "@/lib/action";
import { ActionError, actionEditor, actionUser } from "@/lib/auth";
import { emailBrand } from "@/lib/brand";
import { audienceSchema } from "@/lib/email/audience-schema";
import { loadAttachments, resolveAttachments } from "@/lib/email/attachments";
import { audienceCount, campaignAudience, campaignCreatorEmail, campaignReplyTo, renderCampaign, runDueCampaigns } from "@/lib/email/campaigns";
import { campaignRecipients, recipientFilters } from "@/lib/email/delivery";
import { sendEmail } from "@/lib/email";
import { escapeHtml, fillMergeTags, fillMergeTagsHtml, mergeValues } from "@/lib/email/merge-tags";
import { roundUpToQuarterHour } from "@/lib/format";
import { siteOrigin } from "@/lib/origin";
import { sanitizeHtml } from "@/lib/safe-html";

const { campaigns } = schema;
const uuid = z.uuid();

export async function createCampaign(): Promise<Result<{ id: string }>> {
  return run(async () => {
    const user = await actionEditor();
    const db = await getDb();
    const [row] = await db
      .insert(campaigns)
      // Replies go to whoever sets the campaign up, unless they change it.
      .values({ name: "Untitled campaign", body: "<p>Hi {{first_name|there}},</p><p></p>", replyTo: user.email, createdBy: user.id })
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
  /** A saved audience to use instead of `audience`. */
  audienceId: uuid.nullable().optional(),
  replyTo: z.union([z.email("The reply-to address isn't valid."), z.literal("")]).nullable().optional(),
  attachmentIds: z.array(uuid).max(20).optional(),
});

/** Saves the draft and re-renders its HTML with the current brand kit. Sent and sending campaigns can't change. */
export async function saveCampaign(campaignId: string, input: z.input<typeof saveSchema>): Promise<Result<{ recipients: number; html: string }>> {
  return run(async () => {
    await actionEditor();
    const { attachmentIds, ...data } = saveSchema.parse(input);
    const db = await getDb();
    const [c] = await db.select({ status: campaigns.status }).from(campaigns).where(eq(campaigns.id, uuid.parse(campaignId)));
    if (!c) throw new ActionError("This campaign was deleted.");
    if (c.status === "sent" || c.status === "sending") throw new ActionError("This campaign has already gone out and can't be changed.");
    const body = sanitizeHtml(data.body);
    const html = await renderCampaign(body, data.previewText);
    let audience = data.audience;
    if (data.audienceId) {
      // Keep a copy of the saved audience's filters, so the campaign still has an audience if it's deleted.
      const [saved] = await db.select({ filters: schema.audiences.filters }).from(schema.audiences).where(eq(schema.audiences.id, data.audienceId));
      if (!saved) throw new ActionError("That saved audience was deleted. Pick another or set filters here.");
      audience = saved.filters;
    }
    const attachments = attachmentIds ? await resolveAttachments(attachmentIds) : undefined;
    await db
      .update(campaigns)
      .set({ ...data, audience, audienceId: data.audienceId ?? null, replyTo: data.replyTo || null, body, html, ...(attachments ? { attachments } : {}), updatedAt: new Date() })
      .where(eq(campaigns.id, campaignId));
    return { recipients: await audienceCount(audience), html };
  });
}

/** One page of a sent campaign's recipients with how each email did. */
export async function listCampaignRecipients(campaignId: string, filter: string, page: number) {
  await actionUser();
  return campaignRecipients(uuid.parse(campaignId), z.enum(recipientFilters).catch("all").parse(filter), z.number().int().min(0).max(10_000).catch(0).parse(page));
}

export async function countAudience(audience: z.input<typeof audienceSchema>) {
  await actionUser();
  return audienceCount(audienceSchema.parse(audience));
}

/** Sends the campaign to yourself, filled in as if you were the recipient. */
export async function sendCampaignTest(campaignId: string): Promise<Result<{ to: string }>> {
  return run(async () => {
    const user = await actionEditor();
    const db = await getDb();
    const [c] = await db.select().from(campaigns).where(eq(campaigns.id, uuid.parse(campaignId)));
    if (!c?.html) throw new ActionError("Save the campaign first.");
    const [first, ...rest] = user.name.split(" ");
    const brand = await emailBrand();
    const values = mergeValues({ firstName: first, lastName: rest.join(" ") || null, email: user.email, title: user.title, organizationName: brand.workspaceName, ownerName: user.name });
    await sendEmail({
      to: user.email,
      replyTo: (await campaignReplyTo(c)) ?? user.email,
      subject: `[Test] ${fillMergeTags(c.subject || c.name, values)}`,
      html: fillMergeTagsHtml(c.html, values).replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, escapeHtml(`${await siteOrigin()}/unsubscribe`)),
      attachments: await loadAttachments(c.attachments),
      tags: [{ name: "type", value: "campaign-test" }],
    });
    return { to: user.email };
  });
}

/** Schedules for later, or (with no time) sends now in the background. The claim is one conditional update, so it can't start twice. */
export async function scheduleCampaign(campaignId: string, at: string | null): Promise<Result> {
  return run(async () => {
    await actionEditor();
    const db = await getDb();
    const [c] = await db.select().from(campaigns).where(eq(campaigns.id, uuid.parse(campaignId)));
    if (!c) throw new ActionError("This campaign was deleted.");
    if (!c.subject.trim()) throw new ActionError("Add a subject line first.");
    if (!c.html) throw new ActionError("Write the email first.");
    if (!(await emailBrand()).postalAddress) throw new ActionError("Add your postal address in Settings → Email and brand first. Marketing email must include one.");
    if (!(await audienceCount(await campaignAudience(c)))) throw new ActionError("No one matches this audience yet.");
    // The cron runs on the quarter hour, so a scheduled send goes out at the next one. Saying so up front keeps the time shown honest.
    const when = at ? roundUpToQuarterHour(new Date(z.iso.datetime({ offset: true }).parse(at))) : new Date();
    if (at && when.getTime() < Date.now()) throw new ActionError("Pick a time in the future.");
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
    await actionEditor();
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
    const user = await actionEditor();
    const db = await getDb();
    const [c] = await db.select().from(campaigns).where(eq(campaigns.id, uuid.parse(campaignId)));
    if (!c) throw new ActionError("This campaign was deleted.");
    // A shared address (sales@…) carries over; the original author's own address becomes yours.
    const creatorEmail = await campaignCreatorEmail(c.createdBy);
    const replyTo = !c.replyTo || c.replyTo.toLowerCase() === creatorEmail?.toLowerCase() ? user.email : c.replyTo;
    const [row] = await db
      .insert(campaigns)
      .values({
        name: `${c.name} (copy)`,
        subject: c.subject,
        previewText: c.previewText,
        body: c.body,
        html: c.html,
        audience: c.audience,
        audienceId: c.audienceId,
        replyTo,
        attachments: c.attachments,
        createdBy: user.id,
      })
      .returning({ id: campaigns.id });
    refresh();
    return row;
  });
}

export async function deleteCampaign(campaignId: string): Promise<Result> {
  return run(async () => {
    await actionEditor();
    const db = await getDb();
    const rows = await db
      .delete(campaigns)
      .where(and(eq(campaigns.id, uuid.parse(campaignId)), inArray(campaigns.status, ["draft", "scheduled"])))
      .returning({ id: campaigns.id });
    if (!rows.length) throw new ActionError("Sent campaigns stay for the record.");
    refresh();
  });
}
