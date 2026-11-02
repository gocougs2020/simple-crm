import "server-only";
import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { GetInboxThreadEmailResponseSuccess } from "resend";
import { getDb, schema } from "@/db";
import { touch } from "@/lib/crm/events";
import { getResend } from "@/lib/email";
import { sanitizeHtml } from "@/lib/safe-html";

const { inboxThreads, inboxMessages, activities, people, organizations, clients, outboundEmails } = schema;

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

/** Every inbox in the Resend account. */
export async function listInboxes(): Promise<InboxSummary[]> {
  const resend = resendOrThrow();
  const out: InboxSummary[] = [];
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = must(await resend.inboxes.list({ limit: 100, ...(after ? { after } : {}) }), "list inboxes");
    out.push(...res.data);
    if (!res.has_more || !res.data.length) break;
    after = res.data[res.data.length - 1].id;
  }
  return out;
}

/**
 * Who a thread is about, from the other side's addresses: the first one that
 * belongs to a person, else an organization whose website matches the
 * domain. The client is the one tied to that person or organization, current
 * clients first.
 */
async function findLinks(participants: string[]) {
  const db = await getDb();
  let personId: string | null = null;
  let organizationId: string | null = null;
  if (participants.length) {
    const found = await db
      .select({ id: people.id, email: people.email, organizationId: people.organizationId })
      .from(people)
      .where(and(isNull(people.archivedAt), inArray(sql`lower(${people.email})`, participants)));
    const first = participants.map((p) => found.find((f) => f.email?.toLowerCase() === p)).find(Boolean);
    personId = first?.id ?? null;
    organizationId = first?.organizationId ?? null;
    if (!organizationId) {
      const domains = [...new Set(participants.map((p) => p.split("@")[1]).filter(Boolean))];
      if (domains.length) {
        const [org] = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(and(isNull(organizations.archivedAt), inArray(organizations.domain, domains)))
          .limit(1);
        organizationId = org?.id ?? null;
      }
    }
  }
  let clientId: string | null = null;
  if (personId || organizationId) {
    const match = personId && organizationId ? sql`(${clients.personId} = ${personId} or ${clients.organizationId} = ${organizationId})` : personId ? eq(clients.personId, personId) : eq(clients.organizationId, organizationId!);
    const [c] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(and(isNull(clients.archivedAt), match))
      .orderBy(sql`case ${clients.category} when 'current' then 0 when 'prospective' then 1 else 2 end`, desc(clients.updatedAt))
      .limit(1);
    clientId = c?.id ?? null;
  }
  return { personId, organizationId, clientId };
}

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
  const ours = ourAddresses ?? new Set((await listInboxes()).map((i) => i.email_address.toLowerCase()));
  const inbox = must(await resend.inboxes.get(inboxId), "load the inbox");
  const summary = must(await resend.inboxes.threads.get({ inboxId, threadId: resendThreadId }), "load the conversation");

  const messages: GetInboxThreadEmailResponseSuccess[] = [];
  let after: string | undefined;
  for (let page = 0; page < 5; page++) {
    const res = must(await resend.inboxes.threads.emails.list({ inboxId, threadId: resendThreadId, limit: 100, ...(after ? { after } : {}) }), "load the conversation's emails");
    messages.push(...res.data);
    if (!res.has_more || !res.data.length) break;
    after = res.data[res.data.length - 1].id;
  }
  messages.sort((a, b) => a.received_at.localeCompare(b.received_at));

  const participants = [...new Set(messages.flatMap((m) => [m.from, ...m.to, ...m.cc].map(address)).filter((a) => a && !ours.has(a)))];
  const last = messages.at(-1);
  const [existing] = await db.select().from(inboxThreads).where(eq(inboxThreads.resendThreadId, resendThreadId));
  const links = existing?.linkedByHand ? { personId: existing.personId, organizationId: existing.organizationId, clientId: existing.clientId } : await findLinks(participants);
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
    lastMessageAt: last ? new Date(last.received_at) : null,
    ...links,
    updatedAt: new Date(),
  };
  const [thread] = existing
    ? await db.update(inboxThreads).set(values).where(eq(inboxThreads.id, existing.id)).returning()
    : await db.insert(inboxThreads).values(values).onConflictDoUpdate({ target: inboxThreads.resendThreadId, set: values }).returning();

  // Messages already finished (stored and logged on the timeline). One stored without an activity was left
  // half-done by a sync that died midway; it's picked up again below.
  const done = new Set(
    messages.length
      ? (
          await db
            .select({ id: inboxMessages.resendEmailId })
            .from(inboxMessages)
            .where(and(inArray(inboxMessages.resendEmailId, messages.map((m) => m.id)), isNotNull(inboxMessages.activityId)))
        ).map((r) => r.id)
      : [],
  );
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
        .select({ activityId: activities.id })
        .from(outboundEmails)
        .innerJoin(activities, eq(activities.emailId, outboundEmails.id))
        .where(
          sql`${outboundEmails.resendId} = ${m.id} or (${outboundEmails.resendId} is null and ${outboundEmails.campaignId} is null and lower(${outboundEmails.to}) in (${sql.join(recipients.length ? recipients.map((r) => sql`${r}`) : [sql`''`], sql`, `)}) and ${outboundEmails.subject} = ${m.subject ?? ""} and ${outboundEmails.createdAt} >= ${new Date(sentAt.getTime() - 15 * 60_000)})`,
        )
        .limit(1);
      if (sent) activityId = sent.activityId;
    }
    if (!activityId) {
      const [a] = await db
        .insert(activities)
        .values({ type: "email", direction: m.direction, subject: m.subject, body: body || null, occurredAt: sentAt, userId: null, inboxThreadId: thread.id, ...links })
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
  }
  if (existing && !existing.linkedByHand && (existing.personId !== links.personId || existing.organizationId !== links.organizationId || existing.clientId !== links.clientId)) await applyThreadLinks(thread.id);
  else if (thread.lastMessageAt) await touch(links, thread.lastMessageAt);
  return thread;
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
      await db.update(inboxThreads).set({ folder: t.folder, read: t.read }).where(eq(inboxThreads.id, l.id));
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

/** Threads about a record, newest first, for the email card on its page. */
export async function threadsFor(link: { personIds?: string[]; organizationId?: string | null; clientId?: string | null }, limit = 8) {
  const db = await getDb();
  const ors = [
    link.personIds?.length ? inArray(inboxThreads.personId, link.personIds) : null,
    link.organizationId ? eq(inboxThreads.organizationId, link.organizationId) : null,
    link.clientId ? eq(inboxThreads.clientId, link.clientId) : null,
  ].filter((x): x is NonNullable<typeof x> => !!x);
  if (!ors.length) return [];
  return db
    .select({ id: inboxThreads.id, subject: inboxThreads.subject, snippet: inboxThreads.snippet, read: inboxThreads.read, messageCount: inboxThreads.messageCount, lastMessageAt: inboxThreads.lastMessageAt, inboxAddress: inboxThreads.inboxAddress })
    .from(inboxThreads)
    .where(and(sql`(${sql.join(ors, sql` or `)})`, sql`${inboxThreads.folder} not in ('spam', 'trash')`))
    .orderBy(desc(inboxThreads.lastMessageAt))
    .limit(limit);
}

/** Unread conversations in the inbox folder, for the sidebar badge. */
export async function unreadCount() {
  const db = await getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(inboxThreads)
    .where(and(eq(inboxThreads.folder, "inbox"), eq(inboxThreads.read, false), gte(inboxThreads.lastMessageAt, new Date(Date.now() - 90 * 86400_000))));
  return row?.n ?? 0;
}
