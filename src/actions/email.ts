"use server";

import { refresh } from "next/cache";
import { render } from "@react-email/render";
import { and, desc, eq, or } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { run, type Result } from "@/lib/action";
import { ActionError, actionUser, isAdmin } from "@/lib/auth";
import { emailBrand } from "@/lib/brand";
import { touch } from "@/lib/crm/events";
import { fromAs, getResend, sendEmail } from "@/lib/email";
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
  subject: z.string().trim().min(1, "Add a subject.").max(200),
  body: z.string().min(1, "Write the email first.").max(200_000),
  /** Send a copy to me (BCC). */
  copyMe: z.boolean().optional(),
});

/**
 * Sends a one-off email to a person from their record (or a client's), as the
 * signed-in teammate. From an inbox, the teammate's name goes in front of the
 * inbox address and replies thread back into the CRM. Without one, From is
 * RESEND_FROM and Reply-To is the teammate, so replies land in their own
 * mailbox. Either way the email is logged on the timeline.
 */
export async function sendRecordEmail(input: z.input<typeof sendInput>): Promise<Result<{ activityId: string }>> {
  return run(async () => {
    const user = await actionUser();
    const data = sendInput.parse(input);
    if (data.inboxId && getResend()) {
      // Only inboxes on domains this CRM manages (RESEND_DOMAINS) can send.
      await assertInboxInScope(data.inboxId).catch((err) => {
        throw err instanceof InboxError ? new ActionError(err.message) : err;
      });
    }
    const db = await getDb();
    const [row] = await db
      .select({ person: people, organizationName: organizations.name })
      .from(people)
      .leftJoin(organizations, eq(organizations.id, people.organizationId))
      .where(eq(people.id, data.personId));
    if (!row) throw new ActionError("This person was deleted.");
    if (!row.person.email) throw new ActionError("Add an email address to this person first.");

    const values = mergeValues({ ...row.person, organizationName: row.organizationName }, user);
    const subject = fillMergeTags(data.subject, values);
    const html = fillMergeTagsHtml(sanitizeHtml(data.body), values);
    if (!htmlToText(html)) throw new ActionError("Write the email first.");
    const brand = await emailBrand();
    const signature = brand.signature
      ? fillMergeTags(brand.signature.replace(/\{\{\s*sender_title\s*\}\}/gi, user.title ?? ""), values).replace(/\n{2,}/g, "\n").trim()
      : null;

    const [outbound] = await db
      .insert(outboundEmails)
      .values({ personId: row.person.id, userId: user.id, to: row.person.email, cc: data.cc?.join(", ") || null, subject })
      .returning({ id: outboundEmails.id });
    const fromName = brand.senderName ? `${user.name} · ${brand.senderName}` : user.name;
    const preview = htmlToText(html).split("\n").find(Boolean)?.slice(0, 120) ?? "";
    const email = DirectEmail({ brand, html, preview, signature });
    let resendId: string | null;
    if (data.inboxId) {
      const resend = getResend();
      if (!resend) throw new ActionError("Email isn't connected yet, so inboxes can't send. Send without an inbox, or add RESEND_API_KEY.");
      const draft = await resend.inboxes.drafts.create(
        { inboxId: data.inboxId, to: row.person.email, cc: data.cc?.length ? data.cc : undefined, bcc: data.copyMe ? user.email : undefined, subject, html: await render(email) },
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
          replyTo: user.email,
          subject,
          react: email,
          tags: [{ name: "type", value: "direct" }],
          idempotencyKey: `direct-${outbound.id}`,
        })
      ).id;
    }
    await db.update(outboundEmails).set({ resendId }).where(eq(outboundEmails.id, outbound.id));

    let clientOrg: string | null = null;
    if (data.clientId) {
      const [c] = await db.select({ organizationId: schema.clients.organizationId }).from(schema.clients).where(eq(schema.clients.id, data.clientId));
      clientOrg = c?.organizationId ?? null;
    }
    const now = new Date();
    const links = { personId: row.person.id, organizationId: row.person.organizationId ?? clientOrg, clientId: data.clientId ?? null };
    const [activity] = await db
      .insert(activities)
      .values({ type: "email", direction: "outbound", subject, body: html, occurredAt: now, userId: user.id, assigneeId: user.id, emailId: outbound.id, ...links })
      .returning({ id: activities.id });
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
    .select({ id: emailTemplates.id, name: emailTemplates.name, subject: emailTemplates.subject, body: emailTemplates.body, shared: emailTemplates.shared })
    .from(emailTemplates)
    .where(or(eq(emailTemplates.shared, true), eq(emailTemplates.createdBy, user.id)))
    .orderBy(desc(emailTemplates.updatedAt));
}

const templateInput = z.object({
  name: z.string().trim().min(1, "Name the template.").max(120),
  subject: z.string().trim().max(200),
  body: z.string().max(200_000),
  shared: z.boolean(),
});

export async function saveTemplate(templateId: string | null, input: z.input<typeof templateInput>): Promise<Result<{ id: string }>> {
  return run(async () => {
    const user = await actionUser();
    const data = templateInput.parse(input);
    const body = sanitizeHtml(data.body);
    const db = await getDb();
    if (!templateId) {
      const [row] = await db.insert(emailTemplates).values({ ...data, body, createdBy: user.id }).returning({ id: emailTemplates.id });
      refresh();
      return row;
    }
    const [t] = await db.select().from(emailTemplates).where(eq(emailTemplates.id, z.uuid().parse(templateId)));
    if (!t) throw new ActionError("This template was deleted.");
    if (t.createdBy !== user.id && !isAdmin(user)) throw new ActionError("Only the author or an admin can edit this template.");
    await db
      .update(emailTemplates)
      .set({ ...data, body, updatedAt: new Date() })
      .where(eq(emailTemplates.id, t.id));
    refresh();
    return { id: t.id };
  });
}

export async function deleteTemplate(templateId: string): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const db = await getDb();
    const where = isAdmin(user) ? eq(emailTemplates.id, templateId) : and(eq(emailTemplates.id, templateId), eq(emailTemplates.createdBy, user.id));
    const rows = await db.delete(emailTemplates).where(where).returning({ id: emailTemplates.id });
    if (!rows.length) throw new ActionError("Only the author or an admin can delete this template.");
    refresh();
  });
}
