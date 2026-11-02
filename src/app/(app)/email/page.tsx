import type { Metadata } from "next";
import { and, asc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { Suspense } from "react";
import { z } from "zod";
import { InboxView, type InboxThreadRow, type OpenThread } from "@/components/email/inbox-view";
import { PageSkeleton } from "@/components/ui/skeleton";
import { getDb, schema } from "@/db";
import { isAdmin, requireUser } from "@/lib/auth";
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
  if (!configured) return <InboxView configured={false} isAdmin={admin} inboxes={[]} inboxError={null} threads={[]} open={null} filters={{ folder: "inbox" }} />;

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
  const t = schema.inboxThreads;
  const db = await getDb();

  const where: SQL[] = [];
  // Sent mail lives in the same threads as replies, so the Sent folder is any thread with an outbound message.
  if (folder === "sent") where.push(sql`exists (select 1 from inbox_messages m where m.thread_id = ${t.id} and m.direction = 'outbound')`, sql`${t.folder} not in ('trash', 'spam')`);
  else where.push(eq(t.folder, folder));
  if (inbox) where.push(eq(t.resendInboxId, inbox));
  if (unlinked) where.push(isNull(t.personId), isNull(t.clientId));
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
    read: r.thread.read,
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
  const openId = one(sp.t);
  if (openId && z.uuid().safeParse(openId).success) {
    const [row] = await db
      .select({ thread: t, personName: sql<string | null>`case when ${schema.people.id} is null then null else ${schema.people.firstName} || coalesce(' ' || ${schema.people.lastName}, '') end`, clientName: schema.clients.name })
      .from(t)
      .leftJoin(schema.people, eq(schema.people.id, t.personId))
      .leftJoin(schema.clients, eq(schema.clients.id, t.clientId))
      .where(eq(t.id, openId));
    if (row) {
      const m = schema.inboxMessages;
      const messages = await db
        .select({ id: m.id, direction: m.direction, from: m.from, to: m.to, cc: m.cc, subject: m.subject, html: m.html, sentAt: m.sentAt, attachments: m.attachments, userId: schema.activities.userId })
        .from(m)
        .leftJoin(schema.activities, eq(schema.activities.id, m.activityId))
        .where(eq(m.threadId, row.thread.id))
        .orderBy(asc(m.sentAt));
      open = {
        id: row.thread.id,
        subject: row.thread.subject,
        folder: row.thread.folder,
        read: row.thread.read,
        inboxAddress: row.thread.inboxAddress,
        person: row.thread.personId ? { id: row.thread.personId, label: row.personName ?? "Someone" } : null,
        client: row.thread.clientId ? { id: row.thread.clientId, label: row.clientName ?? "A client" } : null,
        messages: messages.map((x) => ({ ...x, sentAt: x.sentAt.toISOString() })),
      };
    }
  }

  return <InboxView configured isAdmin={admin} inboxes={inboxes} inboxError={inboxError} threads={threads} open={open} filters={{ folder, inbox, q, unlinked }} />;
}
