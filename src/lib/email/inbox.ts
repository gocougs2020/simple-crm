import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";
import type { GetInboxThreadEmailResponseSuccess, Resend } from "resend";
import { appConfig } from "@/app.config";
import { getDb, schema } from "@/db";
import { touch } from "@/lib/crm/events";
import { linksForEmails } from "@/lib/crm/match";
import { emailDomainsScoped, getResend, inEmailScope } from "@/lib/email";
import { htmlToText, sanitizeHtml } from "@/lib/safe-html";
import { deliveryEvents } from "./delivery-status";
import { forwardedAddresses, linkAddresses } from "./forwarded";
import { inboundEmail } from "@/lib/push/triggers";
import { forwardingAvailability, provenSender } from "@/lib/forwarding/inbound";

const { inboxThreads, inboxMessages, inboxSends, activities, outboundEmails } = schema;

/**
 * Resend inboxes, mirrored into the CRM. Resend receives and stores the mail;
 * this keeps a copy of each thread linked to the person, organization and
 * client it's about, and turns every message into an email activity on their
 * timelines. Syncing is idempotent: run it from the webhook, the cron or the
 * "Sync now" button as often as you like.
 */

export class InboxError extends Error {}

export function resendOrThrow() {
  const r = getResend();
  if (!r) throw new InboxError("Email isn't connected. Add RESEND_API_KEY to the environment.");
  return r;
}

/** Unwraps a Resend response, turning its error into one a person can read. */
export function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error || !res.data) throw new InboxError(`Resend couldn't ${what}: ${res.error?.message ?? "no response"}.`);
  return res.data;
}

/** "Sam Lee <sam@acme.com>" → "sam@acme.com". */
export function address(raw: string) {
  return (/<([^>]+)>/.exec(raw)?.[1] ?? raw).trim().toLowerCase();
}

/** "Sam Lee <sam@acme.com>" → "Sam Lee", or the address when there's no name. */
export function displayName(raw: string) {
  const name = /^\s*"?([^"<]+?)"?\s*</.exec(raw)?.[1]?.trim();
  return name || address(raw);
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Plain text email as paragraphs, with links kept clickable. */
function textToHtml(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${escape(p).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** The readable body of a message. Text parts read better than sanitized marketing HTML, so they win when present. */
function bodyOf(m: { html: string | null; text: string | null }) {
  if (m.text?.trim()) return sanitizeHtml(textToHtml(m.text));
  return sanitizeHtml(m.html);
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Plain text for the thread list. React escapes it when shown, so entities are decoded here, not left as "&#x27;". */
function snippetOf(m: { html: string | null; text: string | null }) {
  const text = m.text?.trim() ? m.text : (m.html ?? "").replace(/<(style|script)[\s\S]*?<\/\1>/gi, "").replace(/<[^>]+>/g, " ");
  return (
    text
      .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) =>
        e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (entities[e.toLowerCase()] ?? all),
      )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180) || null
  );
}

type InboxSummary = { id: string; email_address: string; name: string | null; from_name: string | null; unread: number };

/** The cached inbox list's tag. Every settings action that adds, changes or removes an inbox or a domain expires it (`updateTag`). */
export const INBOXES_TAG = "resend-inboxes";

/**
 * Every inbox in the Resend account on a domain this CRM manages (see
 * RESEND_DOMAINS), cached for a few minutes: the Email page, the inbox sync
 * and the composer's inbox picker read it on every request, and it changes
 * only when someone adds or removes an inbox. `use cache: remote` because
 * Resend is rate-limited and serverless instances rarely share memory, so an
 * in-memory entry would seldom be hit. `unread` here can be minutes old; the
 * Email page counts unread itself, and Settings reads `listInboxesNow`.
 */
export async function listInboxes(): Promise<InboxSummary[]> {
  "use cache: remote";
  cacheTag(INBOXES_TAG);
  cacheLife({ stale: 60, revalidate: 120, expire: 300 });
  return listInboxesNow();
}

/** The inbox list straight from Resend, with its unread counts as they are now (Settings → Email domains). */
export async function listInboxesNow(): Promise<InboxSummary[]> {
  const resend = resendOrThrow();
  const out: InboxSummary[] = [];
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = must(await resend.inboxes.list({ limit: 100, ...(after ? { after } : {}) }), "list inboxes");
    out.push(...res.data.filter((i) => inEmailScope(i.email_address)));
    if (!res.has_more || !res.data.length) break;
    after = res.data[res.data.length - 1].id;
  }
  return out;
}

const outOfScope = "That belongs to a domain this CRM doesn't manage. Add the domain to RESEND_DOMAINS to manage it here.";

/** Refuses an inbox on a domain outside RESEND_DOMAINS, so the CRM can't send from or change another app's inbox. */
export async function assertInboxInScope(inboxId: string) {
  if (!emailDomainsScoped) return;
  const inbox = must(await resendOrThrow().inboxes.get(inboxId), "load the inbox");
  if (!inEmailScope(inbox.email_address)) throw new InboxError(outOfScope);
}

/** Refuses a domain outside RESEND_DOMAINS, so the CRM can't verify, change or remove another app's domain. */
export async function assertDomainInScope(domainId: string) {
  if (!emailDomainsScoped) return;
  const domain = must(await resendOrThrow().domains.get(domainId), "load the domain");
  if (!inEmailScope(domain.name)) throw new InboxError(outOfScope);
}

/** Who a thread is about, from the other side's addresses (src/lib/crm/match.ts). */
const findLinks = linksForEmails;

/** Keeps every message's timeline entry pointing at the thread's current links. */
export async function applyThreadLinks(threadId: string) {
  const db = await getDb();
  const [t] = await db.select().from(inboxThreads).where(eq(inboxThreads.id, threadId));
  if (!t) return;
  await db.update(activities).set({ personId: t.personId, organizationId: t.organizationId, clientId: t.clientId, updatedAt: new Date() }).where(eq(activities.inboxThreadId, t.id));
  if (t.lastMessageAt) await touch(t, t.lastMessageAt);
}

/**
 * Pulls one thread and its messages from Resend into the CRM. New messages
 * become email activities; an email the CRM itself sent reuses the activity it
 * already logged, so nothing shows twice.
 */
export async function syncThread(inboxId: string, resendThreadId: string, ourAddresses?: Set<string>) {
  const resend = resendOrThrow();
  const db = await getDb();
  // The inbox, from the cached list of the CRM's inboxes when it's there (usually: no request); else asked for.
  const listed = await listInboxes();
  const inbox = listed.find((i) => i.id === inboxId) ?? must(await resend.inboxes.get(inboxId), "load the inbox");
  // The webhook hears about every inbox in the account; another app's mail is never mirrored.
  if (!inEmailScope(inbox.email_address)) return null;
  const ours = ourAddresses ?? new Set(listed.map((i) => i.email_address.toLowerCase()));
  // The conversation and its first page of emails, together.
  const [summaryRes, firstPage] = await Promise.all([
    resend.inboxes.threads.get({ inboxId, threadId: resendThreadId }),
    resend.inboxes.threads.emails.list({ inboxId, threadId: resendThreadId, limit: 100 }),
  ]);
  const summary = must(summaryRes, "load the conversation");

  const messages: GetInboxThreadEmailResponseSuccess[] = [];
  let res = must(firstPage, "load the conversation's emails");
  for (let page = 0; page < 5; page++) {
    messages.push(...res.data);
    if (!res.has_more || !res.data.length || page === 4) break;
    const after = res.data[res.data.length - 1].id;
    res = must(await resend.inboxes.threads.emails.list({ inboxId, threadId: resendThreadId, limit: 100, after }), "load the conversation's emails");
  }
  messages.sort((a, b) => a.received_at.localeCompare(b.received_at));

  const participants = [...new Set(messages.flatMap((m) => [m.from, ...m.to, ...m.cc].map(address)).filter((a) => a && !ours.has(a)))];
  // What's already stored of these emails (one read for both uses below), the thread, and which participants are teammates, together.
  const [known, [existing], teammates] = await Promise.all([
    messages.length
      ? db
          .select({ id: inboxMessages.resendEmailId, hidden: sql<boolean>`${inboxMessages.hiddenAt} is not null`, linked: sql<boolean>`${inboxMessages.activityId} is not null` })
          .from(inboxMessages)
          .where(inArray(inboxMessages.resendEmailId, messages.map((m) => m.id)))
      : [],
    db.select().from(inboxThreads).where(eq(inboxThreads.resendThreadId, resendThreadId)),
    teammatesByAddress(participants),
  ]);
  // Mail into the inbox from a teammate is theirs: usually a thread they forwarded so it lands on a record.
  // Its own From and To are the teammate and the inbox, so the records it's about come from the headers it quotes.
  const fromTeammate = (m: GetInboxThreadEmailResponseSuccess) => (m.direction === "inbound" ? (teammates.get(address(m.from)) ?? null) : null);
  const forwarded = messages.filter(fromTeammate).flatMap((m) => forwardedAddresses(m.text ?? htmlToText(m.html)).filter((a) => !ours.has(a)));
  // Messages someone deleted from the records stay out of the snippet too.
  const hidden = new Set(known.filter((k) => k.hidden).map((k) => k.id));
  const last = messages.filter((m) => !hidden.has(m.id)).at(-1);
  const links = existing?.linkedByHand
    ? { personId: existing.personId, organizationId: existing.organizationId, clientId: existing.clientId }
    : await findLinks(linkAddresses(participants, new Set([...teammates.keys(), ...(await teammatesByAddress(forwarded.filter((a) => !teammates.has(a)))).keys()]), forwarded));
  const values = {
    resendThreadId,
    resendInboxId: inboxId,
    inboxAddress: inbox.email_address,
    subject: summary.subject ?? last?.subject ?? null,
    snippet: last ? snippetOf(last) : null,
    participants,
    folder: summary.folder,
    read: summary.read,
    messageCount: messages.length,
    // From every message, deleted or not, so the next sync can tell nothing's new.
    lastMessageAt: messages.length ? new Date(messages.at(-1)!.received_at) : null,
    ...links,
    updatedAt: new Date(),
  };
  const [thread] = existing
    ? await db.update(inboxThreads).set(values).where(eq(inboxThreads.id, existing.id)).returning()
    : await db.insert(inboxThreads).values(values).onConflictDoUpdate({ target: inboxThreads.resendThreadId, set: values }).returning();

  // Messages already finished (stored and logged on the timeline, or deleted from it). One stored without an
  // activity was left half-done by a sync that died midway; it's picked up again below.
  const done = new Set(known.filter((k) => k.linked || k.hidden).map((k) => k.id));
  for (const m of messages) {
    if (done.has(m.id)) continue;
    const body = bodyOf(m);
    const sentAt = new Date(m.received_at);
    await db
      .insert(inboxMessages)
      .values({
        threadId: thread.id,
        resendEmailId: m.id,
        direction: m.direction,
        from: m.from,
        to: m.to,
        cc: m.cc,
        subject: m.subject,
        html: body || null,
        text: m.text,
        attachments: m.attachments.map((x) => ({ id: x.id, filename: x.filename, size: x.size })),
        sentAt,
      })
      .onConflictDoNothing({ target: inboxMessages.resendEmailId });

    let activityId: string | null = null;
    let created = false;
    if (m.direction === "outbound") {
      // Sent from a record in the CRM: that send already logged an activity.
      const recipients = [...m.to, ...m.cc].map(address);
      const [sent] = await db
        .select({ activityId: activities.id, outboundId: outboundEmails.id })
        .from(outboundEmails)
        .leftJoin(activities, eq(activities.emailId, outboundEmails.id))
        .where(
          sql`${outboundEmails.resendId} = ${m.id} or (${outboundEmails.resendId} is null and ${outboundEmails.campaignId} is null and lower(split_part(${outboundEmails.to}, ',', 1)) in (${sql.join(recipients.length ? recipients.map((r) => sql`${r}`) : [sql`''`], sql`, `)}) and ${outboundEmails.subject} = ${m.subject ?? ""} and ${outboundEmails.createdAt} >= ${new Date(sentAt.getTime() - 15 * 60_000)})`,
        )
        .limit(1);
      if (sent?.activityId) activityId = sent.activityId;
      else if (sent) {
        // Sent from a record, then deleted from it: it stays deleted.
        await db.update(inboxMessages).set({ hiddenAt: new Date() }).where(and(eq(inboxMessages.resendEmailId, m.id), isNull(inboxMessages.activityId)));
        continue;
      }
    }
    // Credited to the teammate only when their domain's signature proves they sent it: a From line alone can be
    // forged, and credit makes it read as their own action. Unproven, it stays mail that arrived, as before.
    const teammate = activityId ? null : fromTeammate(m);
    const forwardedBy = teammate && (await provenSender(m.id, address(m.from))) ? teammate : null;
    if (!activityId) {
      const [a] = await db
        .insert(activities)
        .values({ type: "email", direction: m.direction, subject: m.subject, body: body || null, occurredAt: sentAt, userId: forwardedBy, inboxThreadId: thread.id, ...links })
        .returning({ id: activities.id });
      activityId = a.id;
      created = true;
    }
    // Attach it only if no other sync got there first. The webhook fires more than once for a new thread and
    // the cron can overlap it; the loser removes the activity it just made, so nothing shows twice.
    const [won] = await db
      .update(inboxMessages)
      .set({ activityId })
      .where(and(eq(inboxMessages.resendEmailId, m.id), isNull(inboxMessages.activityId)))
      .returning({ id: inboxMessages.id });
    if (!won) {
      if (created) await db.delete(activities).where(eq(activities.id, activityId));
      continue;
    }
    if (!created) await db.update(activities).set({ inboxThreadId: thread.id, ...links }).where(eq(activities.id, activityId));
    // Sent from the inbox page: credit whoever sent it. Read after the activity exists, so a send recorded at any moment is caught here or by `creditSender`.
    if (created && m.direction === "outbound") await creditActivity(activityId, m.id);
    // A teammate's own forward isn't news from a contact.
    if (m.direction === "inbound" && !forwardedBy) await inboundEmail({ id: m.id, from: m.from, subject: m.subject, sentAt, threadId: thread.id, ...links });
  }
  if (existing && !existing.linkedByHand && (existing.personId !== links.personId || existing.organizationId !== links.organizationId || existing.clientId !== links.clientId)) await applyThreadLinks(thread.id);
  else if (thread.lastMessageAt) await touch(links, thread.lastMessageAt);
  return thread;
}

/** Active teammates among these addresses, by their sign-in address. */
async function teammatesByAddress(addresses: string[]) {
  if (!addresses.length) return new Map<string, string>();
  const db = await getDb();
  const rows = await db
    .select({ id: schema.users.id, email: sql<string>`lower(${schema.users.email})` })
    .from(schema.users)
    .where(and(inArray(sql`lower(${schema.users.email})`, addresses), isNull(schema.users.deactivatedAt)));
  return new Map(rows.map((r) => [r.email, r.id]));
}

/** Credits an email's activity to the teammate who sent it from the inbox page, if one did and nobody is credited yet. */
async function creditActivity(activityId: string, resendEmailId: string) {
  const db = await getDb();
  const [s] = await db.select({ userId: inboxSends.userId }).from(inboxSends).where(eq(inboxSends.resendEmailId, resendEmailId));
  if (s?.userId) await db.update(activities).set({ userId: s.userId, assigneeId: s.userId }).where(and(eq(activities.id, activityId), isNull(activities.userId)));
}

/**
 * Records who sent an email from the inbox page, the moment Resend accepts
 * it. Whichever syncs the message first (this send or Resend's webhook), the
 * email ends up credited to them.
 */
export async function creditSender(resendEmailId: string, userId: string) {
  const db = await getDb();
  await db.insert(inboxSends).values({ resendEmailId, userId }).onConflictDoNothing();
  const [msg] = await db.select({ activityId: inboxMessages.activityId }).from(inboxMessages).where(eq(inboxMessages.resendEmailId, resendEmailId));
  if (msg?.activityId) await creditActivity(msg.activityId, resendEmailId);
}

/**
 * Brings an inbox up to date: the most recent threads in every folder,
 * skipping ones whose message count and latest message already match.
 */
export async function syncInbox(inboxId: string, opts: { limit?: number; ourAddresses?: Set<string> } = {}) {
  const resend = resendOrThrow();
  const db = await getDb();
  const ours = opts.ourAddresses ?? new Set((await listInboxes()).map((i) => i.email_address.toLowerCase()));
  const res = must(await resend.inboxes.threads.list({ inboxId, folders: ["inbox", "archive", "sent", "spam", "trash"], limit: Math.min(opts.limit ?? 50, 100) }), "list conversations");
  const local = res.data.length
    ? await db
        .select({
          resendThreadId: inboxThreads.resendThreadId,
          messageCount: inboxThreads.messageCount,
          lastMessageAt: inboxThreads.lastMessageAt,
          id: inboxThreads.id,
          folder: inboxThreads.folder,
          read: inboxThreads.read,
          // Qualified by hand: with no joins Drizzle would render a bare "id", which the subquery reads as m.id.
          unfinished: sql<boolean>`exists (select 1 from inbox_messages m where m.thread_id = "inbox_threads"."id" and m.activity_id is null)`,
        })
        .from(inboxThreads)
        .where(inArray(inboxThreads.resendThreadId, res.data.map((t) => t.id)))
    : [];
  let synced = 0;
  for (const t of res.data) {
    const l = local.find((x) => x.resendThreadId === t.id);
    if (l && !l.unfinished && l.messageCount === t.email_count && l.lastMessageAt && l.lastMessageAt.getTime() >= new Date(t.received_at).getTime()) {
      // Written only when Resend's folder or read flag differs, so a sync with nothing new writes nothing.
      if (l.folder !== t.folder || l.read !== t.read) await db.update(inboxThreads).set({ folder: t.folder, read: t.read, updatedAt: new Date() }).where(eq(inboxThreads.id, l.id));
      continue;
    }
    await syncThread(inboxId, t.id, ours);
    synced++;
  }
  return { checked: res.data.length, synced };
}

export async function syncAllInboxes(limit = 50) {
  const inboxes = await listInboxes();
  const ours = new Set(inboxes.map((i) => i.email_address.toLowerCase()));
  let synced = 0;
  for (const i of inboxes) synced += (await syncInbox(i.id, { limit, ourAddresses: ours })).synced;
  return { inboxes: inboxes.length, synced };
}

type WebhookEventName = Parameters<Resend["webhooks"]["create"]>[0]["events"][number];

/**
 * What the CRM's Resend webhook subscribes to: inbox mail, delivery reports,
 * and opens and clicks only when this deployment tracks them (`email` in
 * app.config.ts). Settings asks to reconnect when the connected list differs.
 */
export function webhookEvents(): WebhookEventName[] {
  const forwarding = forwardingAvailability().on ? ["email.received"] : [];
  return ["inbox.email.received", "inbox.email.sent", "inbox.thread.created", "inbox.thread.folder.updated", "inbox.deleted", ...deliveryEvents(appConfig.email), ...forwarding] as WebhookEventName[];
}

/** Whether a connected webhook's events differ from what this deployment needs (connected before delivery reports, or tracking was turned on or off since). */
export function webhookNeedsReconnect(connected: string[] | undefined) {
  const want = webhookEvents();
  const have = new Set(connected ?? []);
  return want.length !== have.size || want.some((e) => !have.has(e));
}
