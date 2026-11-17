import type { Metadata } from "next";
import { and, asc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { Suspense } from "react";
import { z } from "zod";
import { InboxView, type InboxThreadRow, type OpenThread } from "@/components/email/inbox-view";
import { PageSkeleton } from "@/components/ui/skeleton";
import { getDb, schema } from "@/db";
import { isAdmin, requireUser } from "@/lib/auth";
import { conversationOwner, unreadFor } from "@/lib/conversations/read-state";
import { readStateFor } from "@/lib/conversations/read-rules";
import { recordContext } from "@/lib/conversations/record-context";
import { likeTerm } from "@/lib/crm/records";
import { emailConfigured } from "@/lib/email";
import { listInboxes } from "@/lib/email/inbox";

export const metadata: Metadata = { title: "Inbox" };

const folders = ["inbox", "sent", "archive", "spam", "trash"] as const;
type Folder = (typeof folders)[number];

export default function InboxPage({ searchParams }: PageProps<"/email">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Inbox searchParams={searchParams} />
    </Suspense>
  );
}

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

async function Inbox({ searchParams }: Pick<PageProps<"/email">, "searchParams">) {
  const sp = await searchParams;
  const user = await requireUser();
  const admin = isAdmin(user);
  const configured = emailConfigured();
  if (!configured) return <InboxView configured={false} isAdmin={admin} inboxes={[]} inboxError={null} threads={[]} open={null} context={null} filters={{ folder: "inbox" }} />;

  let inboxes: { id: string; address: string; name: string | null; unread: number }[] = [];
  let inboxError: string | null = null;
  try {
    inboxes = (await listInboxes()).map((i) => ({ id: i.id, address: i.email_address, name: i.name, unread: i.unread }));
  } catch (err) {
    inboxError = err instanceof Error ? err.message : "Resend didn't answer.";
  }

  const folder: Folder = (folders as readonly string[]).includes(one(sp.folder) ?? "") ? (one(sp.folder) as Folder) : "inbox";
  const inbox = one(sp.inbox);
  const q = one(sp.q);
  const unlinked = one(sp.unlinked) === "1";
  const unreadOnly = one(sp.unread) === "1";
  const t = schema.inboxThreads;
  const db = await getDb();

  // Resend counts unread for the whole team; here each teammate sees only their own (src/lib/conversations/read-rules.ts).
  const counts = await db
    .select({ inboxId: t.resendInboxId, n: sql<number>`count(*)::int` })
    .from(t)
    .where(and(eq(t.folder, "inbox"), unreadFor("inbox_threads", user.id)))
    .groupBy(t.resendInboxId);
  inboxes = inboxes.map((i) => ({ ...i, unread: counts.find((c) => c.inboxId === i.id)?.n ?? 0 }));

  const where: SQL[] = [];
  // Sent mail lives in the same threads as replies, so the Sent folder is any thread with an outbound message.
  if (folder === "sent") where.push(sql`exists (select 1 from inbox_messages m where m.thread_id = ${t.id} and m.direction = 'outbound')`, sql`${t.folder} not in ('trash', 'spam')`);
  else where.push(eq(t.folder, folder));
  if (inbox) where.push(eq(t.resendInboxId, inbox));
  if (unlinked) where.push(isNull(t.personId), isNull(t.clientId));
  if (unreadOnly) where.push(unreadFor("inbox_threads", user.id));
  if (q?.trim()) {
    const term = likeTerm(q);
    where.push(or(ilike(t.subject, term), ilike(t.snippet, term), sql`${t.participants}::text ilike ${term}`)!);
  }

  const rows = await db
    .select({
      thread: t,
      personName: sql<string | null>`case when ${schema.people.id} is null then null else ${schema.people.firstName} || coalesce(' ' || ${schema.people.lastName}, '') end`,
      clientName: schema.clients.name,
      lastFrom: sql<string | null>`(select m."from" from inbox_messages m where m.thread_id = ${t.id} and m.direction = 'inbound' order by m.sent_at desc limit 1)`,
      unread: unreadFor("inbox_threads", user.id),
    })
    .from(t)
    .leftJoin(schema.people, eq(schema.people.id, t.personId))
    .leftJoin(schema.clients, eq(schema.clients.id, t.clientId))
    .where(and(...where))
    .orderBy(sql`${t.lastMessageAt} desc nulls last`)
    .limit(200);

  const threads: InboxThreadRow[] = rows.map((r) => ({
    id: r.thread.id,
    subject: r.thread.subject,
    snippet: r.thread.snippet,
    participants: r.thread.participants,
    read: !r.unread,
    messageCount: r.thread.messageCount,
    lastMessageAt: r.thread.lastMessageAt?.toISOString() ?? null,
    inboxAddress: r.thread.inboxAddress,
    lastFrom: r.lastFrom,
    personId: r.thread.personId,
    personName: r.personName,
    clientId: r.thread.clientId,
    clientName: r.clientName,
  }));

  let open: OpenThread | null = null;
  let openOrg: string | null = null;
  const openId = one(sp.t);
  if (openId && z.uuid().safeParse(openId).success) {
    const [row] = await db
      .select({
        thread: t,
        personName: sql<string | null>`case when ${schema.people.id} is null then null else ${schema.people.firstName} || coalesce(' ' || ${schema.people.lastName}, '') end`,
        clientName: schema.clients.name,
        ownerId: conversationOwner("inbox_threads"),
      })
      .from(t)
      .leftJoin(schema.people, eq(schema.people.id, t.personId))
      .leftJoin(schema.clients, eq(schema.clients.id, t.clientId))
      .where(eq(t.id, openId));
    if (row) {
      openOrg = row.thread.organizationId;
      const m = schema.inboxMessages;
      const messages = await db
        .select({ id: m.id, direction: m.direction, from: m.from, to: m.to, cc: m.cc, subject: m.subject, html: m.html, sentAt: m.sentAt, attachments: m.attachments, userId: schema.activities.userId })
        .from(m)
        .leftJoin(schema.activities, eq(schema.activities.id, m.activityId))
        .where(and(eq(m.threadId, row.thread.id), isNull(m.hiddenAt)))
        .orderBy(asc(m.sentAt));
      open = {
        id: row.thread.id,
        subject: row.thread.subject,
        folder: row.thread.folder,
        read: row.thread.read,
        readState: readStateFor({ read: row.thread.read, ownerId: row.ownerId }, user.id),
        inboxAddress: row.thread.inboxAddress,
        person: row.thread.personId ? { id: row.thread.personId, label: row.personName ?? "Someone" } : null,
        client: row.thread.clientId ? { id: row.thread.clientId, label: row.clientName ?? "A client" } : null,
        messages: messages.map((x) => ({ ...x, sentAt: x.sentAt.toISOString() })),
      };
    }
  }

  const context = open ? await recordContext({ personId: open.person?.id ?? null, organizationId: openOrg }) : null;
  return <InboxView configured isAdmin={admin} inboxes={inboxes} inboxError={inboxError} threads={threads} open={open} context={context} filters={{ folder, inbox, q, unlinked, unread: unreadOnly }} />;
}
