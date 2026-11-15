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
import { defaultReplyTo, fromAs, getResend, sendEmail } from "@/lib/email";
import { loadAttachments, resolveAttachments } from "@/lib/email/attachments";
import { assertInboxInScope, InboxError } from "@/lib/email/inbox";
import { fillMergeTags, fillMergeTagsHtml, mergeValues } from "@/lib/email/merge-tags";
import { htmlToText, sanitizeHtml } from "@/lib/safe-html";
import DirectEmail from "@/emails/direct";

const { people, organizations, activities, outboundEmails, emailTemplates } = schema;

const sendInput = z.object({
  personId: z.uuid(),
  clientId: z.uuid().nullable().optional(),
  /** Send from one of the workspace's Resend inboxes, so replies come back into the CRM. Otherwise from RESEND_FROM, with replies to the teammate. */
  inboxId: z.string().max(100).nullable().optional(),
  cc: z
    .array(z.email("One of the CC addresses isn't valid."))
    .max(10)
    .optional(),
  /** Where replies go. Blank uses RESEND_REPLY_TO, then the sender's own address. Ignored when sending from an inbox, whose replies come back to it. */
  replyTo: z.union([z.email("The reply-to address isn't valid."), z.literal("")]).nullable().optional(),
  subject: z.string().trim().min(1, "Add a subject.").max(200),
  body: z.string().min(1, "Write the email first.").max(200_000),
  /** Files already uploaded to the CRM (see uploadFile). */
  attachmentIds: z.array(z.uuid()).max(20).optional(),
  /** Send a copy to me (BCC). */
  copyMe: z.boolean().optional(),
});

/** What the composer needs to know before sending: the reply-to it starts with. */
export async function composerDefaults() {
  const user = await actionUser();
  return { replyTo: defaultReplyTo ?? user.email, replyToIsDefault: !!defaultReplyTo };
}

/**
 * Sends a one-off email to a person from their record (or a client's), as the
 * signed-in teammate. From an inbox, the teammate's name goes in front of the
 * inbox address and replies thread back into the CRM. Without one, From is
 * RESEND_FROM and Reply-To is the teammate, so replies land in their own
 * mailbox. Either way the email is logged on the timeline.
 */
export async function sendRecordEmail(input: z.input<typeof sendInput>): Promise<Result<{ activityId: string }>> {
  return run(async () => {
    const user = await actionEditor();
    const data = sendInput.parse(input);
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
    let client: { name: string; organizationId: string | null } | undefined;
    if (data.clientId) {
      [client] = await db.select({ name: schema.clients.name, organizationId: schema.clients.organizationId }).from(schema.clients).where(eq(schema.clients.id, data.clientId));
      if (!client) throw new ActionError("This client was deleted.");
    }
    const attachments = await resolveAttachments(data.attachmentIds ?? []);
    const files = await loadAttachments(attachments);
    const replyTo = data.inboxId ? null : data.replyTo || defaultReplyTo || user.email;

    const values = mergeValues({ ...row.person, organizationName: row.organizationName, ownerName: row.ownerName, clientName: client?.name }, user);
    const subject = fillMergeTags(data.subject, values);
    const html = fillMergeTagsHtml(sanitizeHtml(data.body), values);
    if (!htmlToText(html)) throw new ActionError("Write the email first.");
    const brand = await emailBrand();
    const signature = brand.signature
      ? fillMergeTags(brand.signature.replace(/\{\{\s*sender_title\s*\}\}/gi, user.title ?? ""), values).replace(/\n{2,}/g, "\n").trim()
      : null;

    const [outbound] = await db
      .insert(outboundEmails)
      .values({ personId: row.person.id, clientId: data.clientId ?? null, userId: user.id, to: row.person.email, cc: data.cc?.join(", ") || null, replyTo, subject, attachments })
      .returning({ id: outboundEmails.id });
    const fromName = brand.senderName ? `${user.name} · ${brand.senderName}` : user.name;
    const preview = htmlToText(html).split("\n").find(Boolean)?.slice(0, 120) ?? "";
    const email = DirectEmail({ brand, html, preview, signature });
    let resendId: string | null;
    if (data.inboxId) {
      const resend = getResend();
      if (!resend) throw new ActionError("Email isn't connected yet, so inboxes can't send. Send without an inbox, or add RESEND_API_KEY.");
      const draft = await resend.inboxes.drafts.create(
        { inboxId: data.inboxId, to: row.person.email, cc: data.cc?.length ? data.cc : undefined, bcc: data.copyMe ? user.email : undefined, subject, html: await render(email), attachments: files.length ? files : undefined },
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
          to: row.person.email,
          cc: data.cc?.length ? data.cc : undefined,
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
    await db.update(outboundEmails).set({ resendId }).where(eq(outboundEmails.id, outbound.id));

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
