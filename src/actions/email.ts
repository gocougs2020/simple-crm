"use server";

import { refresh } from "next/cache";
import { and, desc, eq, or } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { run, type Result } from "@/lib/action";
import { ActionError, actionUser, isAdmin } from "@/lib/auth";
import { emailBrand } from "@/lib/brand";
import { touch } from "@/lib/crm/events";
import { fromAs, sendEmail } from "@/lib/email";
import { fillMergeTags, fillMergeTagsHtml, mergeValues } from "@/lib/email/merge-tags";
import { htmlToText, sanitizeHtml } from "@/lib/safe-html";
import DirectEmail from "@/emails/direct";

const { people, organizations, activities, outboundEmails, emailTemplates } = schema;

const sendInput = z.object({
  personId: z.uuid(),
  dealId: z.uuid().nullable().optional(),
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
 * Sends a one-off email to a person from their record (or a deal's), as the
 * signed-in teammate: their name in From, their address in Reply-To, so
 * replies land in their own inbox. The email is logged on the timeline.
 */
export async function sendRecordEmail(input: z.input<typeof sendInput>): Promise<Result<{ activityId: string }>> {
  return run(async () => {
    const user = await actionUser();
    const data = sendInput.parse(input);
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
    const { id: resendId } = await sendEmail({
      from: fromAs(brand.senderName ? `${user.name} · ${brand.senderName}` : user.name),
      to: row.person.email,
      cc: data.cc?.length ? data.cc : undefined,
      bcc: data.copyMe ? user.email : undefined,
      replyTo: user.email,
      subject,
      react: DirectEmail({ brand, html, preview: htmlToText(html).split("\n").find(Boolean)?.slice(0, 120) ?? "", signature }),
      tags: [{ name: "type", value: "direct" }],
      idempotencyKey: `direct-${outbound.id}`,
    });
    await db.update(outboundEmails).set({ resendId }).where(eq(outboundEmails.id, outbound.id));

    let dealOrg: string | null = null;
    if (data.dealId) {
      const [d] = await db.select({ organizationId: schema.deals.organizationId }).from(schema.deals).where(eq(schema.deals.id, data.dealId));
      dealOrg = d?.organizationId ?? null;
    }
    const now = new Date();
    const links = { personId: row.person.id, organizationId: row.person.organizationId ?? dealOrg, dealId: data.dealId ?? null };
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
