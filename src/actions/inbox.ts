"use server";

import { refresh } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { run, type Result } from "@/lib/action";
import { ActionError, actionAdmin, actionUser } from "@/lib/auth";
import { recordEvent } from "@/lib/crm/events";
import { getResend } from "@/lib/email";
import { applyThreadLinks, InboxError, listInboxes, must, resendOrThrow, syncAllInboxes, syncInbox, syncThread } from "@/lib/email/inbox";
import { siteOrigin } from "@/lib/origin";
import { htmlToText, sanitizeHtml } from "@/lib/safe-html";

const { inboxThreads, inboxMessages, activities, clients, people } = schema;
const uuid = z.uuid();

/** Turns Resend and sync failures into sentences the interface can show. */
async function inbox<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof InboxError) throw new ActionError(err.message);
    throw err;
  }
}

/** Inboxes a teammate can send from, for the composer's From menu. Empty when email isn't connected. */
export async function listSendingInboxes(): Promise<{ id: string; address: string; name: string | null }[]> {
  await actionUser();
  if (!getResend()) return [];
  try {
    return (await listInboxes()).map((i) => ({ id: i.id, address: i.email_address, name: i.name }));
  } catch (err) {
    console.error("[inbox] list", err);
    return [];
  }
}

export async function syncNow(): Promise<Result<{ synced: number }>> {
  return run(async () => {
    await actionUser();
    const r = await inbox(() => syncAllInboxes(50));
    refresh();
    return { synced: r.synced };
  });
}

async function threadOrThrow(threadId: string) {
  const db = await getDb();
  const [t] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, uuid.parse(threadId)));
  if (!t) throw new ActionError("This conversation is gone. Sync the inbox and try again.");
  return t;
}

const replyInput = z.object({
  body: z.string().min(1, "Write a reply first.").max(200_000),
  replyAll: z.boolean().optional(),
  cc: z.array(z.email("One of the CC addresses isn't valid.")).max(10).optional(),
});

/** Replies to the latest message in a thread, from the inbox it arrived in. The reply is logged as the teammate who wrote it. */
export async function replyToThread(threadId: string, input: z.input<typeof replyInput>): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const data = replyInput.parse(input);
    const html = sanitizeHtml(data.body);
    if (!htmlToText(html)) throw new ActionError("Write a reply first.");
    const t = await threadOrThrow(threadId);
    const db = await getDb();
    const messages = await db.select().from(inboxMessages).where(eq(inboxMessages.threadId, t.id)).orderBy(inboxMessages.sentAt);
    const target = [...messages].reverse().find((m) => m.direction === "inbound") ?? messages.at(-1);
    if (!target) throw new ActionError("There's nothing to reply to yet. Sync the inbox and try again.");
    const resend = await inbox(async () => resendOrThrow());
    const sent = await inbox(async () =>
      must(
        await resend.inboxes.threads.emails.reply(
          { inboxId: t.resendInboxId, threadId: t.resendThreadId, emailId: target.resendEmailId, html, replyAll: data.replyAll ?? false, cc: data.cc?.length ? data.cc : undefined },
          { idempotencyKey: `reply-${t.id}-${crypto.randomUUID()}` },
        ),
        "send the reply",
      ),
    );
    await inbox(() => syncThread(t.resendInboxId, t.resendThreadId));
    // The sync logs the reply with no author; it was this teammate.
    const [msg] = await db.select({ activityId: inboxMessages.activityId }).from(inboxMessages).where(eq(inboxMessages.resendEmailId, sent.id));
    if (msg?.activityId) await db.update(activities).set({ userId: user.id, assigneeId: user.id }).where(eq(activities.id, msg.activityId));
    refresh();
  });
}

const composeInput = z.object({
  inboxId: z.string().min(1, "Pick an inbox to send from.").max(100),
  to: z.array(z.email("One of the To addresses isn't valid.")).min(1, "Add who it's to.").max(20),
  cc: z.array(z.email("One of the CC addresses isn't valid.")).max(10).optional(),
  subject: z.string().trim().min(1, "Add a subject.").max(200),
  body: z.string().min(1, "Write the email first.").max(200_000),
});

/** A new conversation from the inbox page. */
export async function composeEmail(input: z.input<typeof composeInput>): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const data = composeInput.parse(input);
    const html = sanitizeHtml(data.body);
    if (!htmlToText(html)) throw new ActionError("Write the email first.");
    const resend = await inbox(async () => resendOrThrow());
    const key = crypto.randomUUID();
    const draft = await inbox(async () => must(await resend.inboxes.drafts.create({ inboxId: data.inboxId, to: data.to, cc: data.cc?.length ? data.cc : undefined, subject: data.subject, html }, { idempotencyKey: `draft-${key}` }), "prepare the email"));
    const sent = await inbox(async () => must(await resend.inboxes.drafts.send({ inboxId: data.inboxId, draftId: draft.id }, { idempotencyKey: `send-${key}` }), "send the email"));
    await inbox(() => syncInbox(data.inboxId, { limit: 10 }));
    const db = await getDb();
    const [msg] = await db.select({ activityId: inboxMessages.activityId }).from(inboxMessages).where(eq(inboxMessages.resendEmailId, sent.id));
    if (msg?.activityId) await db.update(activities).set({ userId: user.id, assigneeId: user.id }).where(eq(activities.id, msg.activityId));
    refresh();
  });
}

/** Archive, trash, spam or back to the inbox. Changes it in Resend first, so the two never disagree. */
export async function moveThread(threadId: string, folder: "inbox" | "archive" | "spam" | "trash"): Promise<Result> {
  return run(async () => {
    await actionUser();
    const f = z.enum(["inbox", "archive", "spam", "trash"]).parse(folder);
    const t = await threadOrThrow(threadId);
    const resend = await inbox(async () => resendOrThrow());
    await inbox(async () => must(await resend.inboxes.threads.update({ inboxId: t.resendInboxId, threadId: t.resendThreadId, folder: f }), "move the conversation"));
    const db = await getDb();
    await db.update(inboxThreads).set({ folder: f, updatedAt: new Date() }).where(eq(inboxThreads.id, t.id));
    refresh();
  });
}

export async function markThreadRead(threadId: string, read: boolean): Promise<Result> {
  return run(async () => {
    await actionUser();
    const t = await threadOrThrow(threadId);
    if (t.read === read) return;
    const resend = await inbox(async () => resendOrThrow());
    await inbox(async () => must(await resend.inboxes.threads.update({ inboxId: t.resendInboxId, threadId: t.resendThreadId, read }), "update the conversation"));
    const db = await getDb();
    await db.update(inboxThreads).set({ read }).where(eq(inboxThreads.id, t.id));
    refresh();
  });
}

const linkInput = z.object({ personId: z.uuid().nullable().optional(), clientId: z.uuid().nullable().optional() });

/**
 * Says who a conversation is about. Picking a client fills in its contact and
 * organization; picking a person fills in theirs. Every message in the thread
 * moves to the new records' timelines, and later syncs keep the choice.
 */
export async function linkThread(threadId: string, input: z.input<typeof linkInput>): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const data = linkInput.parse(input);
    const t = await threadOrThrow(threadId);
    const db = await getDb();
    let personId = data.personId === undefined ? t.personId : data.personId;
    let organizationId: string | null = null;
    let clientId = data.clientId === undefined ? t.clientId : data.clientId;
    if (data.clientId) {
      const [c] = await db.select().from(clients).where(eq(clients.id, data.clientId));
      if (!c) throw new ActionError("That client was deleted.");
      if (data.personId === undefined) personId = c.personId ?? personId;
      organizationId = c.organizationId;
    }
    if (personId) {
      const [p] = await db.select({ organizationId: people.organizationId }).from(people).where(eq(people.id, personId));
      organizationId ??= p?.organizationId ?? null;
    }
    if (data.personId === null && data.clientId === undefined) clientId = t.clientId;
    await db.update(inboxThreads).set({ personId, organizationId, clientId, linkedByHand: true, updatedAt: new Date() }).where(eq(inboxThreads.id, t.id));
    await applyThreadLinks(t.id);
    if (clientId && clientId !== t.clientId) await recordEvent({ entityType: "client", entityId: clientId, action: "email_linked", data: { subject: t.subject }, userId: user.id });
    refresh();
  });
}

// ─── Domains, inboxes and the webhook (admins) ───────────────────────────

const regions = ["us-east-1", "eu-west-1", "sa-east-1", "ap-northeast-1"] as const;

const domainInput = z.object({
  name: z
    .string()
    .trim()
    .toLowerCase()
    .transform((v) => v.replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .pipe(z.string().regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/, "Enter a domain like mail.acme.com.")),
  region: z.enum(regions).default("us-east-1"),
  receiving: z.boolean().default(true),
});

export async function addDomain(input: z.input<typeof domainInput>): Promise<Result<{ id: string }>> {
  return run(async () => {
    await actionAdmin();
    const data = domainInput.parse(input);
    const resend = await inbox(async () => resendOrThrow());
    const d = await inbox(async () =>
      must(await resend.domains.create({ name: data.name, region: data.region, capabilities: { sending: "enabled", receiving: data.receiving ? "enabled" : "disabled" } }), "add the domain"),
    );
    refresh();
    return { id: d.id };
  });
}

export async function verifyDomain(domainId: string): Promise<Result> {
  return run(async () => {
    await actionAdmin();
    const resend = await inbox(async () => resendOrThrow());
    await inbox(async () => must(await resend.domains.verify(z.string().min(1).max(100).parse(domainId)), "start verification"));
    refresh();
  });
}

export async function setDomainCapability(domainId: string, capability: "sending" | "receiving", enabled: boolean): Promise<Result> {
  return run(async () => {
    await actionAdmin();
    const resend = await inbox(async () => resendOrThrow());
    const cap = z.enum(["sending", "receiving"]).parse(capability);
    await inbox(async () => must(await resend.domains.update({ id: z.string().min(1).max(100).parse(domainId), capabilities: { [cap]: enabled ? "enabled" : "disabled" } }), `turn ${cap} ${enabled ? "on" : "off"}`));
    refresh();
  });
}

export async function removeDomain(domainId: string): Promise<Result> {
  return run(async () => {
    await actionAdmin();
    const resend = await inbox(async () => resendOrThrow());
    await inbox(async () => must(await resend.domains.remove(z.string().min(1).max(100).parse(domainId)), "remove the domain"));
    refresh();
  });
}

const inboxInput = z.object({
  localPart: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9._+-]{1,64}$/, "Use letters, numbers, dots or dashes before the @."),
  domain: z.string().trim().toLowerCase().min(3, "Pick a domain.").max(253),
  name: z.string().trim().max(80).optional(),
  fromName: z.string().trim().max(80).optional(),
});

export async function createInbox(input: z.input<typeof inboxInput>): Promise<Result> {
  return run(async () => {
    await actionAdmin();
    const data = inboxInput.parse(input);
    const resend = await inbox(async () => resendOrThrow());
    await inbox(async () => must(await resend.inboxes.create({ emailAddress: `${data.localPart}@${data.domain}`, name: data.name || undefined, fromName: data.fromName || undefined }), "create the inbox"));
    refresh();
  });
}

export async function updateInbox(inboxId: string, input: { name?: string; fromName?: string }): Promise<Result> {
  return run(async () => {
    await actionAdmin();
    const data = z.object({ name: z.string().trim().max(80).optional(), fromName: z.string().trim().max(80).optional() }).parse(input);
    if (data.name === undefined && data.fromName === undefined) return;
    const resend = await inbox(async () => resendOrThrow());
    await inbox(async () => must(await resend.inboxes.update(z.string().min(1).max(100).parse(inboxId), data as { name: string }), "update the inbox"));
    refresh();
  });
}

/** Removes the inbox in Resend. Conversations already in the CRM stay on their records' timelines. */
export async function removeInbox(inboxId: string): Promise<Result> {
  return run(async () => {
    await actionAdmin();
    const resend = await inbox(async () => resendOrThrow());
    await inbox(async () => must(await resend.inboxes.remove(z.string().min(1).max(100).parse(inboxId)), "remove the inbox"));
    refresh();
  });
}

const webhookEvents = ["inbox.email.received", "inbox.email.sent", "inbox.thread.created", "inbox.thread.folder.updated", "inbox.deleted"] as const;

/**
 * Points a Resend webhook at this deployment so new mail shows up within
 * seconds. Reconnecting (after a domain change, say) updates the same webhook.
 */
export async function connectWebhook(): Promise<Result<{ endpoint: string }>> {
  return run(async () => {
    await actionAdmin();
    const origin = await siteOrigin();
    if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(origin)) throw new ActionError("Resend can't reach localhost. Use Sync now while developing, or connect from your deployed site.");
    const endpoint = `${origin}/api/webhooks/resend`;
    const resend = await inbox(async () => resendOrThrow());
    const db = await getDb();
    const [ws] = await db.select({ email: schema.workspace.email }).from(schema.workspace).limit(1);
    const current = ws?.email ?? {};
    let next = { ...current };
    if (current.webhookId) {
      const updated = await resend.webhooks.update(current.webhookId, { endpoint, events: [...webhookEvents], status: "enabled" });
      if (updated.error) next = {};
      else next = { ...current, webhookEndpoint: endpoint };
    }
    if (!next.webhookId) {
      const created = await inbox(async () => must(await resend.webhooks.create({ endpoint, events: [...webhookEvents] }), "create the webhook"));
      next = { webhookId: created.id, webhookSecret: created.signing_secret, webhookEndpoint: endpoint };
    }
    await db.insert(schema.workspace).values({ id: 1, email: next }).onConflictDoUpdate({ target: schema.workspace.id, set: { email: next, updatedAt: new Date() } });
    refresh();
    return { endpoint };
  });
}
