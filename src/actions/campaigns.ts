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
import { audienceCount, campaignAudience, campaignCreatorEmail, campaignReplyTo, campaignText, renderCampaign, runDueCampaigns } from "@/lib/email/campaigns";
import { campaignRecipients, recipientFilters } from "@/lib/email/delivery";
import { sendEmail } from "@/lib/email";
import { escapeHtml, fillMergeTags, fillMergeTagsHtml, mergeValues } from "@/lib/email/merge-tags";
import { roundUpToQuarterHour } from "@/lib/format";
import { siteOrigin } from "@/lib/origin";
import { appConfig } from "@/app.config";
import { campaignChannels, type CampaignChannel } from "@/lib/constants";
import { toE164 } from "@/lib/phone/numbers";
import { sanitizeHtml } from "@/lib/safe-html";
import { assertNumberAccess, numbersFor } from "@/lib/twilio/access";
import { phoneConfigured } from "@/lib/twilio/config";
import { sendText } from "@/lib/twilio/texts";

const { campaigns } = schema;
const uuid = z.uuid();

export async function createCampaign(channel: CampaignChannel = "email"): Promise<Result<{ id: string }>> {
  return run(async () => {
    const user = await actionEditor();
    const kind = z.enum(campaignChannels).parse(channel);
    if (kind === "text" && !phoneConfigured()) throw new ActionError("Texting isn't set up on this deployment. An admin can add a Twilio account (docs/PHONE.md).");
    const db = await getDb();
    const numbers = kind === "text" ? await numbersFor(user) : [];
    const [row] = await db
      .insert(campaigns)
      // Replies go to whoever sets the campaign up, unless they change it.
      .values(
        kind === "email"
          ? { name: "Untitled campaign", body: "<p>Hi {{first_name|there}},</p><p></p>", replyTo: user.email, createdBy: user.id }
          : { name: "Untitled text campaign", channel: "text", textBody: "Hi {{first_name|there}}, ", phoneNumberId: numbers.find((n) => n.id === user.prefs.phoneNumberId)?.id ?? numbers[0]?.id ?? null, createdBy: user.id },
      )
      .returning({ id: campaigns.id });
    return row;
  });
}

const textSaveSchema = z.object({
  name: z.string().trim().min(1, "Name the campaign.").max(120),
  textBody: z.string().max(1600, "Texts can be up to 1,600 characters."),
  phoneNumberId: uuid.nullable(),
  audience: audienceSchema,
  audienceId: uuid.nullable().optional(),
});

/** Saves a text campaign's draft. Only numbers the teammate may text from can be picked. */
export async function saveTextCampaign(campaignId: string, input: z.input<typeof textSaveSchema>): Promise<Result<{ recipients: number }>> {
  return run(async () => {
    const user = await actionEditor();
    const data = textSaveSchema.parse(input);
    const db = await getDb();
    const [c] = await db.select({ status: campaigns.status, channel: campaigns.channel, phoneNumberId: campaigns.phoneNumberId }).from(campaigns).where(eq(campaigns.id, uuid.parse(campaignId)));
    if (!c || c.channel !== "text") throw new ActionError("This campaign was deleted.");
    if (c.status === "sent" || c.status === "sending") throw new ActionError("This campaign has already gone out and can't be changed.");
    // Every save, not just a change of number: editing a campaign is choosing to text from its number.
    if (data.phoneNumberId) await assertNumberAccess(user, data.phoneNumberId);
    let audience = data.audience;
    if (data.audienceId) {
      const [saved] = await db.select({ filters: schema.audiences.filters }).from(schema.audiences).where(eq(schema.audiences.id, data.audienceId));
      if (!saved) throw new ActionError("That saved audience was deleted. Pick another or set filters here.");
      audience = saved.filters;
    }
    await db
      .update(campaigns)
      .set({ name: data.name, textBody: data.textBody, phoneNumberId: data.phoneNumberId, audience, audienceId: data.audienceId ?? null, updatedAt: new Date() })
      .where(eq(campaigns.id, campaignId));
    return { recipients: await audienceCount(audience, "text") };
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
    const [c] = await db.select({ status: campaigns.status, channel: campaigns.channel }).from(campaigns).where(eq(campaigns.id, uuid.parse(campaignId)));
    if (!c || c.channel !== "email") throw new ActionError("This campaign was deleted.");
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

export async function countAudience(audience: z.input<typeof audienceSchema>, channel: CampaignChannel = "email") {
  await actionUser();
  return audienceCount(audienceSchema.parse(audience), z.enum(campaignChannels).parse(channel));
}

/** Texts a text campaign to a number you type, filled in as if you were the recipient. */
export async function sendTextCampaignTest(campaignId: string, to: string): Promise<Result<{ to: string }>> {
  return run(async () => {
    const user = await actionEditor();
    const db = await getDb();
    const [c] = await db.select().from(campaigns).where(eq(campaigns.id, uuid.parse(campaignId)));
    if (!c || c.channel !== "text") throw new ActionError("This campaign was deleted.");
    if (!c.textBody.trim()) throw new ActionError("Write the text first.");
    if (!c.phoneNumberId) throw new ActionError("Pick the number this campaign texts from.");
    const number = await assertNumberAccess(user, c.phoneNumberId);
    const e164 = toE164(to, appConfig.phone.defaultCountryCode);
    if (!e164) throw new ActionError("Enter the number to text the test to, with its area code.");
    const [first, ...rest] = user.name.split(" ");
    const brand = await emailBrand();
    const body = `[Test] ${campaignText(c.textBody, mergeValues({ firstName: first, lastName: rest.join(" ") || null, email: user.email, title: user.title, organizationName: brand.workspaceName, ownerName: user.name }))}`;
    const result = await sendText({ number, to: e164, body, userId: user.id, links: { personId: null, organizationId: null, clientId: null }, origin: await siteOrigin() });
    if (!result.sent) throw new ActionError(result.error ?? "The test didn't send.");
    return { to: e164 };
  });
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
    const user = await actionEditor();
    const db = await getDb();
    const [c] = await db.select().from(campaigns).where(eq(campaigns.id, uuid.parse(campaignId)));
    if (!c) throw new ActionError("This campaign was deleted.");
    if (c.channel === "text") {
      if (!phoneConfigured()) throw new ActionError("Texting isn't set up on this deployment.");
      if (!c.textBody.trim()) throw new ActionError("Write the text first.");
      if (!c.phoneNumberId) throw new ActionError("Pick the number this campaign texts from.");
      await assertNumberAccess(user, c.phoneNumberId);
      if (!(await audienceCount(await campaignAudience(c), "text")))
        throw new ActionError(appConfig.phone.textCampaignsNeedConsent ? "No one matches this audience yet. Text campaigns only go to people marked as agreeing to marketing texts." : "No one matches this audience yet.");
    } else {
      if (!c.subject.trim()) throw new ActionError("Add a subject line first.");
      if (!c.html) throw new ActionError("Write the email first.");
      if (!(await emailBrand()).postalAddress) throw new ActionError("Add your postal address in Settings → Email and brand first. Marketing email must include one.");
      if (!(await audienceCount(await campaignAudience(c)))) throw new ActionError("No one matches this audience yet.");
    }
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
        channel: c.channel,
        textBody: c.textBody,
        phoneNumberId: c.phoneNumberId,
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
