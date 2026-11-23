"use server";

import { refresh } from "next/cache";
import { render } from "@react-email/render";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { run, type Result } from "@/lib/action";
import { ActionError, actionEditor, actionUser, isAdmin } from "@/lib/auth";
import { emailBrand } from "@/lib/brand";
import { touch } from "@/lib/crm/events";
import { MAX_EMAIL_RECIPIENTS } from "@/lib/crm/schemas";
import { setActivityPeople } from "@/lib/crm/service/activities";
import { planRecipients } from "@/lib/email/recipients";
import { fromAs, getResend, sendEmail } from "@/lib/email";
import { loadAttachments, resolveAttachments } from "@/lib/email/attachments";
import { assertInboxInScope, InboxError } from "@/lib/email/inbox";
import { fillMergeTags, fillMergeTagsHtml, mergeValues } from "@/lib/email/merge-tags";
import { outlookSignature, workspaceSignature } from "@/lib/email/signature";
import { microsoftConfigured } from "@/lib/microsoft/config";
import { accountOf, GraphError } from "@/lib/microsoft/graph";
import { sendFromMailbox } from "@/lib/microsoft/mail";
import { htmlToText, sanitizeHtml } from "@/lib/safe-html";
import DirectEmail from "@/emails/direct";
import { plainEmailHtml } from "@/emails/plain";

const { people, organizations, activities, outboundEmails, emailTemplates } = schema;

const sendInput = z.object({
  /** The first person on the To line. Merge tags fill in for them. */
  personId: z.uuid(),
  /** More people on the To line (a client's other people). */
  toPersonIds: z.array(z.uuid()).max(MAX_EMAIL_RECIPIENTS).optional(),
  /** People on the Cc line. */
  ccPersonIds: z.array(z.uuid()).max(MAX_EMAIL_RECIPIENTS).optional(),
  clientId: z.uuid().nullable().optional(),
  /** Send from one of the workspace's Resend inboxes, so replies come back into the CRM. Otherwise from RESEND_FROM, with replies to the teammate. */
  inboxId: z.string().max(100).nullable().optional(),
  /** Send from the teammate's own connected Microsoft 365 mailbox instead. Takes precedence over `inboxId`. */
  via: z.enum(["crm", "microsoft"]).optional(),
  /** Cc addresses typed by hand. */
  cc: z
    .array(z.email("One of the CC addresses isn't valid."))
    .max(MAX_EMAIL_RECIPIENTS)
    .optional(),
  /** Where replies go. Blank means the sender's own address. Ignored when sending from an inbox, whose replies come back to it. */
  replyTo: z.union([z.email("The reply-to address isn't valid."), z.literal("")]).nullable().optional(),
  subject: z.string().trim().min(1, "Add a subject.").max(200),
  body: z.string().min(1, "Write the email first.").max(200_000),
  /** Files already uploaded to the CRM (see uploadFile). */
  attachmentIds: z.array(z.uuid()).max(20).optional(),
  /** Send a copy to me (BCC). */
  copyMe: z.boolean().optional(),
  /** From Outlook: whether the sender's signature goes under it. Left out, it's their default (Settings → Email and calendar). */
  signature: z.boolean().optional(),
});


/**
 * Sends a one-off email to a person from their record (or a client's), as the
 * signed-in teammate. From a client it can go to several of the client's
 * people at once, on To and Cc: one email everyone can reply-all to, 10
 * addresses at most between the two lines (`planRecipients`). From an inbox, the teammate's name goes in front of the
 * inbox address and replies thread back into the CRM. Without one, From is
 * RESEND_FROM and Reply-To is the teammate's own address unless they changed
 * it for this email. Either way the email is logged on the timeline.
 */
export async function sendRecordEmail(input: z.input<typeof sendInput>): Promise<Result<{ activityId: string }>> {
  return run(async () => {
    const user = await actionEditor();
    const data = sendInput.parse(input);
    const mailbox = data.via === "microsoft" ? await accountOf(user.id) : null;
    if (data.via === "microsoft") {
      if (!microsoftConfigured() || !mailbox) throw new ActionError("Connect your Microsoft account in Settings → Email and calendar first, or send from the CRM.");
      if (mailbox.status !== "active") throw new ActionError("Your Microsoft account needs reconnecting. Reconnect it in Settings → Email and calendar, or send from the CRM.");
      if (!mailbox.sendMail) throw new ActionError("Sending from your mailbox is off. Turn it on in Settings → Email and calendar, or send from the CRM.");
      data.inboxId = null;
    }
    if (data.inboxId && getResend()) {
      // Only inboxes on domains this CRM manages (RESEND_DOMAINS) can send.
      await assertInboxInScope(data.inboxId).catch((err) => {
        throw err instanceof InboxError ? new ActionError(err.message) : err;
      });
    }
    const db = await getDb();
    const [row] = await db
      .select({ person: people, organizationName: organizations.name, ownerName: schema.users.name })
      .from(people)
      .leftJoin(organizations, eq(organizations.id, people.organizationId))
      .leftJoin(schema.users, eq(schema.users.id, people.ownerId))
      .where(eq(people.id, data.personId));
    if (!row) throw new ActionError("This person was deleted.");
    if (!row.person.email) throw new ActionError("Add an email address to this person first.");
    // Everyone else on the To and Cc lines.
    const otherIds = [...new Set([...(data.toPersonIds ?? []), ...(data.ccPersonIds ?? [])])].filter((id) => id !== row.person.id);
    const others = otherIds.length ? await db.select({ id: people.id, firstName: people.firstName, lastName: people.lastName, email: people.email }).from(people).where(inArray(people.id, otherIds)) : [];
    const entry = (id: string) => {
      const p = others.find((o) => o.id === id);
      if (!p) throw new ActionError("One of the people on this email was deleted. Take them off and send again.");
      if (!p.email) throw new ActionError(`${[p.firstName, p.lastName].filter(Boolean).join(" ")} has no email address. Add one to their record, or take them off this email.`);
      return { personId: p.id, email: p.email };
    };
    const plan = planRecipients({
      to: [{ personId: row.person.id, email: row.person.email }, ...(data.toPersonIds ?? []).filter((id) => id !== row.person.id).map(entry)],
      cc: [...(data.ccPersonIds ?? []).filter((id) => id !== row.person.id).map(entry), ...(data.cc ?? []).map((email) => ({ personId: null, email }))],
    });
    if (plan.total > MAX_EMAIL_RECIPIENTS) {
      throw new ActionError(`An email can go to ${MAX_EMAIL_RECIPIENTS} addresses at most, counting To and Cc. This one has ${plan.total}: take ${plan.total - MAX_EMAIL_RECIPIENTS} off and send again.`);
    }
    const cc = plan.cc.length ? plan.cc : undefined;
    let client: { name: string; organizationId: string | null } | undefined;
    if (data.clientId) {
      [client] = await db.select({ name: schema.clients.name, organizationId: schema.clients.organizationId }).from(schema.clients).where(eq(schema.clients.id, data.clientId));
      if (!client) throw new ActionError("This client was deleted.");
    }
    const attachments = await resolveAttachments(data.attachmentIds ?? []);
    const files = await loadAttachments(attachments);
    // From their own mailbox, replies come back to it unless they name another address.
    const replyTo = data.inboxId ? null : mailbox ? data.replyTo || null : data.replyTo || user.email;

    const values = mergeValues({ ...row.person, organizationName: row.organizationName, ownerName: row.ownerName, clientName: client?.name }, user);
    const subject = fillMergeTags(data.subject, values);
    const html = fillMergeTagsHtml(sanitizeHtml(data.body), values);
    if (!htmlToText(html)) throw new ActionError("Write the email first.");
    const brand = await emailBrand();
    const signature = workspaceSignature(brand.signature, user, (text) => fillMergeTags(text, values));

    const [outbound] = await db
      .insert(outboundEmails)
      .values({ personId: row.person.id, clientId: data.clientId ?? null, userId: user.id, to: plan.to.join(", "), cc: plan.cc.join(", ") || null, replyTo, subject, attachments, provider: mailbox ? "microsoft" : "resend" })
      .returning({ id: outboundEmails.id });
    const fromName = brand.senderName ? `${user.name} · ${brand.senderName}` : user.name;
    const preview = htmlToText(html).split("\n").find(Boolean)?.slice(0, 120) ?? "";
    const email = DirectEmail({ brand, html, preview, signature });
    let resendId: string | null = null;
    if (mailbox) {
      try {
        // From their own Outlook it reads like any email they send there: no branded layout around it.
        const sent = await sendFromMailbox(mailbox, { to: plan.to, cc, bcc: data.copyMe ? [user.email] : undefined, replyTo, subject, html: plainEmailHtml(html, outlookSignature(user, signature, data.signature)), attachments: files });
        await db.update(outboundEmails).set({ messageId: sent.messageId }).where(eq(outboundEmails.id, outbound.id));
      } catch (err) {
        await db.delete(outboundEmails).where(eq(outboundEmails.id, outbound.id));
        if (err instanceof GraphError) throw new ActionError(err.message);
        throw err;
      }
    } else if (data.inboxId) {
      const resend = getResend();
      if (!resend) throw new ActionError("Email isn't connected yet, so inboxes can't send. Send without an inbox, or add RESEND_API_KEY.");
      const draft = await resend.inboxes.drafts.create(
        { inboxId: data.inboxId, to: plan.to, cc, bcc: data.copyMe ? user.email : undefined, subject, html: await render(email), attachments: files.length ? files : undefined },
        { idempotencyKey: `draft-${outbound.id}` },
      );
      if (draft.error || !draft.data) throw new ActionError(`Resend couldn't prepare the email: ${draft.error?.message ?? "no response"}.`);
      const sent = await resend.inboxes.drafts.send({ inboxId: data.inboxId, draftId: draft.data.id }, { idempotencyKey: `direct-${outbound.id}` });
      if (sent.error || !sent.data) throw new ActionError(`Resend couldn't send the email: ${sent.error?.message ?? "no response"}.`);
      resendId = sent.data.id;
    } else {
      resendId = (
        await sendEmail({
          from: fromAs(fromName),
          to: plan.to,
          cc,
          bcc: data.copyMe ? user.email : undefined,
          replyTo: replyTo ?? undefined,
          subject,
          react: email,
          attachments: files.length ? files : undefined,
          tags: [{ name: "type", value: "direct" }],
          idempotencyKey: `direct-${outbound.id}`,
        })
      ).id;
    }
    if (resendId) await db.update(outboundEmails).set({ resendId }).where(eq(outboundEmails.id, outbound.id));

    const now = new Date();
    const links = { personId: row.person.id, organizationId: row.person.organizationId ?? client?.organizationId ?? null, clientId: data.clientId ?? null };
    const [activity] = await db
      .insert(activities)
      .values({ type: "email", direction: "outbound", subject, body: html, occurredAt: now, userId: user.id, assigneeId: user.id, emailId: outbound.id, ...links })
      .returning({ id: activities.id });
    // Files uploaded for this email (on this record, not yet on anything else) fold into it on the timeline.
    // A template's files stay free, so the next email can use them too.
    if (attachments.length) {
      await db
        .update(schema.files)
        .set({ activityId: activity.id })
        .where(
          and(
            inArray(
              schema.files.id,
              attachments.map((a) => a.fileId),
            ),
            isNull(schema.files.activityId),
            data.clientId ? or(eq(schema.files.clientId, data.clientId), eq(schema.files.personId, row.person.id)) : eq(schema.files.personId, row.person.id),
          ),
        );
    }
    await touch(links, now);
    // It's on the timeline of everyone it went to, and counts as contact with each of them.
    if (plan.otherPersonIds.length) {
      await setActivityPeople(activity.id, plan.otherPersonIds);
      for (const personId of plan.otherPersonIds) await touch({ personId }, now);
    }
    refresh();
    return { activityId: activity.id };
  });
}

// ─── Templates ───────────────────────────────────────────────────────────

/** Shared templates plus the viewer's own. */
export async function listTemplates() {
  const user = await actionUser();
  const db = await getDb();
  return db
    .select({ id: emailTemplates.id, name: emailTemplates.name, subject: emailTemplates.subject, body: emailTemplates.body, attachments: emailTemplates.attachments, shared: emailTemplates.shared })
    .from(emailTemplates)
    .where(or(eq(emailTemplates.shared, true), eq(emailTemplates.createdBy, user.id)))
    .orderBy(desc(emailTemplates.updatedAt));
}

const templateInput = z.object({
  name: z.string().trim().min(1, "Name the template.").max(120),
  subject: z.string().trim().max(200),
  body: z.string().max(200_000),
  attachmentIds: z.array(z.uuid()).max(20).optional(),
  shared: z.boolean(),
});

export async function saveTemplate(templateId: string | null, input: z.input<typeof templateInput>): Promise<Result<{ id: string }>> {
  return run(async () => {
    const user = await actionEditor();
    const { attachmentIds, ...data } = templateInput.parse(input);
    const body = sanitizeHtml(data.body);
    const attachments = attachmentIds ? await resolveAttachments(attachmentIds) : undefined;
    const db = await getDb();
    if (!templateId) {
      const [row] = await db
        .insert(emailTemplates)
        .values({ ...data, body, attachments, createdBy: user.id })
        .returning({ id: emailTemplates.id });
      refresh();
      return row;
    }
    const [t] = await db.select().from(emailTemplates).where(eq(emailTemplates.id, z.uuid().parse(templateId)));
    if (!t) throw new ActionError("This template was deleted.");
    if (t.createdBy !== user.id && !isAdmin(user)) throw new ActionError("Only the author or an admin can edit this template.");
    await db
      .update(emailTemplates)
      .set({ ...data, body, ...(attachments ? { attachments } : {}), updatedAt: new Date() })
      .where(eq(emailTemplates.id, t.id));
    refresh();
    return { id: t.id };
  });
}

export async function deleteTemplate(templateId: string): Promise<Result> {
  return run(async () => {
    const user = await actionEditor();
    const db = await getDb();
    const where = isAdmin(user) ? eq(emailTemplates.id, templateId) : and(eq(emailTemplates.id, templateId), eq(emailTemplates.createdBy, user.id));
    const rows = await db.delete(emailTemplates).where(where).returning({ id: emailTemplates.id });
    if (!rows.length) throw new ActionError("Only the author or an admin can delete this template.");
    refresh();
  });
}
