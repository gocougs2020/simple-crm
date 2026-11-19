import "server-only";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { appConfig } from "@/app.config";
import { getDb, schema } from "@/db";
import { touch } from "@/lib/crm/events";
import { linksForEmails, type Links } from "@/lib/crm/match";
import type { LoadedAttachment } from "@/lib/email/attachments";
import { sanitizeHtml, textToHtml } from "@/lib/safe-html";
import { getWorkspace } from "@/lib/workspace";
import { withheldCategory } from "./config";
import { graph, graphPages, GraphError, ReconnectError, type ConnectedAccount } from "./graph";
import { graphAddress, stripQuoted } from "./mail-text";
import { screenEmail } from "./screen";

const { syncedEmails, activities, outboundEmails } = schema;

// ─── Sending ─────────────────────────────────────────────────────────────

/** Graph takes attachments up to 3 MB inline; bigger ones go up in an upload session. */
const INLINE_MAX = 3 * 1024 * 1024;
const CHUNK = 320 * 1024 * 10; // upload chunks must be multiples of 320 KiB

const recipients = (list: string[] | undefined) => (list ?? []).map((address) => ({ emailAddress: { address } }));

/**
 * Sends an email from the teammate's own mailbox: it goes out as them, is
 * saved in their Sent Items, and replies come back to their Outlook (and onto
 * the record with the next sync). Returns the Internet Message-ID so the sync
 * recognizes the copy in Sent Items.
 */
export async function sendFromMailbox(
  account: ConnectedAccount,
  m: { to: string | string[]; cc?: string[]; bcc?: string[]; replyTo?: string | null; subject: string; html: string; attachments: LoadedAttachment[] },
): Promise<{ messageId: string | null; graphId: string }> {
  const draft = await graph<{ id: string; internetMessageId?: string }>(account, "/me/messages", {
    method: "POST",
    json: {
      subject: m.subject,
      body: { contentType: "HTML", content: m.html },
      toRecipients: recipients([m.to].flat()),
      ccRecipients: recipients(m.cc),
      bccRecipients: recipients(m.bcc),
      ...(m.replyTo && m.replyTo.toLowerCase() !== account.email ? { replyTo: recipients([m.replyTo]) } : {}),
    },
  });
  try {
    for (const file of m.attachments) {
      if (file.content.length <= INLINE_MAX) {
        await graph(account, `/me/messages/${draft.id}/attachments`, {
          method: "POST",
          json: { "@odata.type": "#microsoft.graph.fileAttachment", name: file.filename, contentType: file.contentType, contentBytes: file.content.toString("base64") },
        });
        continue;
      }
      const session = await graph<{ uploadUrl: string }>(account, `/me/messages/${draft.id}/attachments/createUploadSession`, {
        method: "POST",
        json: { AttachmentItem: { attachmentType: "file", name: file.filename, size: file.content.length, contentType: file.contentType } },
      });
      for (let start = 0; start < file.content.length; start += CHUNK) {
        const end = Math.min(start + CHUNK, file.content.length);
        // The upload URL carries its own authorization; no Graph token goes with it.
        const res = await fetch(session.uploadUrl, {
          method: "PUT",
          headers: { "content-length": String(end - start), "content-range": `bytes ${start}-${end - 1}/${file.content.length}` },
          body: new Uint8Array(file.content.subarray(start, end)),
        });
        if (!res.ok) throw new GraphError(`Microsoft didn't take the attachment ${file.filename} (HTTP ${res.status}).`, res.status);
      }
    }
    await graph(account, `/me/messages/${draft.id}/send`, { method: "POST" });
  } catch (err) {
    // Don't leave a half-made draft in their Drafts folder.
    await graph(account, `/me/messages/${draft.id}`, { method: "DELETE" }).catch(() => {});
    throw err;
  }
  return { messageId: draft.internetMessageId ?? null, graphId: draft.id };
}

// ─── Syncing ─────────────────────────────────────────────────────────────

type GraphMessage = {
  id: string;
  internetMessageId?: string;
  conversationId?: string;
  subject?: string | null;
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: { emailAddress?: { name?: string; address?: string } }[];
  ccRecipients?: { emailAddress?: { name?: string; address?: string } }[];
  receivedDateTime: string;
  sentDateTime?: string;
  body?: { contentType: string; content: string };
  sensitivity?: "normal" | "personal" | "private" | "confidential";
  categories?: string[];
  isDraft?: boolean;
};

const SELECT = "id,internetMessageId,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,body,sensitivity,categories,isDraft";
/** Plain-text bodies read better on a timeline than sanitized Outlook HTML, and are what the screen reads. */
const TEXT_BODY = { headers: { Prefer: 'outlook.body-content-type="text"' } };
/** Overlap between syncs, so mail that arrives while one runs is never skipped. */
const OVERLAP_MS = 10 * 60_000;

type Folder = "inbox" | "sent";
const folderPath: Record<Folder, string> = { inbox: "inbox", sent: "sentitems" };

export type MailboxSyncResult = { imported: number; withheld: number };

/**
 * Brings a mailbox's mail with contacts into the CRM: new messages in Inbox
 * (and Sent Items, with `microsoft.syncSent`) since the last sync. Only mail
 * with a person or organization in the CRM is looked at; mail between
 * teammates and with strangers is left alone. Each one is screened first,
 * and what's kept out is marked in Outlook. Safe to run as often as you like.
 */
export async function syncMailbox(account: ConnectedAccount): Promise<MailboxSyncResult> {
  const db = await getDb();
  const result: MailboxSyncResult = { imported: 0, withheld: 0 };
  const users = await db.select({ email: schema.users.email, name: schema.users.name }).from(schema.users);
  // Every teammate's sign-in address and every connected mailbox's address: someone's Outlook address can differ from the email they sign in with.
  const mailboxes = await db.select({ email: schema.connectedAccounts.email }).from(schema.connectedAccounts);
  const team = new Set([...users.map((u) => u.email.toLowerCase()), ...mailboxes.map((m) => m.email.toLowerCase())]);
  team.add(account.email.toLowerCase());
  // For the screen: who's on our side, so mail between teammates (one of them also in the CRM as a person) is recognized.
  const ourTeam = [...new Set([...users.map((u) => `${u.name} <${u.email.toLowerCase()}>`), ...mailboxes.map((m) => m.email.toLowerCase()), account.email.toLowerCase()])];
  const workspaceName = (await getWorkspace()).name;
  const ctx = { account, team, ourTeam, workspaceName, result };

  const folders: Folder[] = appConfig.microsoft.syncSent ? ["inbox", "sent"] : ["inbox"];
  const cursor = { ...account.mailCursor };
  for (const folder of folders) {
    const since = new Date(cursor[folder] ? new Date(cursor[folder]).getTime() - OVERLAP_MS : Date.now() - appConfig.microsoft.firstSyncDays * 86400_000);
    const messages = await graphPages<GraphMessage>(
      account,
      `/me/mailFolders/${folderPath[folder]}/messages?$filter=${encodeURIComponent(`receivedDateTime ge ${since.toISOString()}`)}&$orderby=receivedDateTime asc&$top=50&$select=${SELECT}`,
      TEXT_BODY,
      6,
    );
    for (const m of messages) {
      if (m.isDraft) continue;
      await handleMessage(ctx, m, folder === "inbox" ? "inbound" : "outbound");
      if (!cursor[folder] || m.receivedDateTime > cursor[folder]!) cursor[folder] = m.receivedDateTime;
    }
  }

  await db
    .update(schema.connectedAccounts)
    .set({ mailCursor: cursor, lastSyncAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(eq(schema.connectedAccounts.id, account.id));
  return result;
}

type Ctx = { account: ConnectedAccount; team: Set<string>; ourTeam: string[]; workspaceName: string; result: MailboxSyncResult };

async function handleMessage(ctx: Ctx, m: GraphMessage, direction: "inbound" | "outbound") {
  const db = await getDb();
  const { account } = ctx;
  const from = graphAddress(m.from);
  const to = [...(m.toRecipients ?? []), ...(m.ccRecipients ?? [])].map(graphAddress).filter((a) => a.address);
  // Who's on the other side: the sender of mail in, the recipients of mail out. Teammates don't count.
  const others = (direction === "inbound" ? [from.address] : to.map((a) => a.address)).filter((a) => a && !ctx.team.has(a));
  if (!others.length) return;

  const [seen] = await db
    .select({ id: syncedEmails.id })
    .from(syncedEmails)
    .where(and(eq(syncedEmails.accountId, account.id), eq(syncedEmails.externalId, m.id)));
  if (seen) return;
  const links = await linksForEmails([...new Set(others)]);
  if (!links.personId && !links.organizationId) return;

  const sentAt = new Date(direction === "inbound" ? m.receivedDateTime : (m.sentDateTime ?? m.receivedDateTime));
  const base = {
    accountId: account.id,
    externalId: m.id,
    internetMessageId: m.internetMessageId ?? null,
    conversationId: m.conversationId ?? null,
    direction,
    from: from.address || null,
    to: to.map((a) => a.address),
    sentAt,
    ...links,
  };

  // Sent from a record through this mailbox, or already copied from a teammate's mailbox: it's on the timeline once.
  if (m.internetMessageId) {
    const [ours] = await db.select({ id: outboundEmails.id }).from(outboundEmails).where(eq(outboundEmails.messageId, m.internetMessageId)).limit(1);
    const [theirs] = ours
      ? []
      : await db
          .select({ id: syncedEmails.id })
          .from(syncedEmails)
          .innerJoin(activities, eq(activities.syncedEmailId, syncedEmails.id))
          .where(and(eq(syncedEmails.internetMessageId, m.internetMessageId), eq(syncedEmails.status, "imported")))
          .limit(1);
    if (ours || theirs) {
      await save(base, "imported", ours ? "Sent from the CRM" : "Already on the record from a teammate's mailbox");
      return;
    }
    // A teammate's copy of the same message was kept out, or deleted from the records: this copy stays out too.
    const [keptOut] = await db
      .select({ reason: syncedEmails.reason })
      .from(syncedEmails)
      .where(and(eq(syncedEmails.internetMessageId, m.internetMessageId), eq(syncedEmails.status, "withheld")))
      .limit(1);
    if (keptOut) {
      if (await save(base, "withheld", `Kept out on a teammate's copy: ${keptOut.reason ?? "withheld"}`.slice(0, 300))) await markWithheld(account, m);
      ctx.result.withheld++;
      return;
    }
  }

  // Outlook's own sensitivity label is the sender's word for it: always kept out, no AI needed.
  if (m.sensitivity && m.sensitivity !== "normal") {
    if (await save(base, "withheld", `Marked ${m.sensitivity} in Outlook`)) await markWithheld(account, m);
    ctx.result.withheld++;
    return;
  }

  const text = stripQuoted(m.body?.contentType === "text" ? m.body.content : (m.body?.content ?? "").replace(/<[^>]+>/g, " "));
  // The screen answers with how likely the email is to be sensitive. When it can't answer, mail goes in: Outlook's own label above already kept out what the sender marked private.
  const verdict = await screenEmail({ from: from.display, to: to.map((a) => a.display), subject: m.subject ?? null, text, ourTeam: ctx.ourTeam }, ctx.workspaceName);
  if (verdict.decision === "withhold") {
    if (await save(base, "withheld", verdict.reason, verdict.score)) await markWithheld(account, m);
    ctx.result.withheld++;
    return;
  }

  const row = await save(base, "imported", verdict.screened ? null : verdict.reason, verdict.score);
  if (!row) return;
  const body = text ? sanitizeHtml(textToHtml(text)) : null;
  // Undone if the activity can't be saved, so the next sync tries the message again instead of skipping it.
  const undo = (err: unknown) => db.delete(syncedEmails).where(eq(syncedEmails.id, row.id)).then(() => Promise.reject(err));
  await db.insert(activities).values({
    type: "email",
    direction,
    subject: m.subject?.trim() || null,
    body,
    occurredAt: sentAt,
    // Mail they sent is theirs; mail in arrived by itself, like a connected inbox's.
    userId: direction === "outbound" ? account.userId : null,
    assigneeId: direction === "outbound" ? account.userId : null,
    syncedEmailId: row.id,
    ...links,
  }).catch(undo);
  await touch(links, sentAt);
  ctx.result.imported++;
}

/** Records what happened to a message, once: a concurrent sync that loses the race gets null and stops. */
async function save(base: Omit<typeof syncedEmails.$inferInsert, "status" | "reason"> & Links, status: "imported" | "withheld", reason: string | null, screenScore?: number | null) {
  const db = await getDb();
  const [row] = await db
    .insert(syncedEmails)
    .values({ ...base, status, reason, screenScore: screenScore ?? null })
    .onConflictDoNothing({ target: [syncedEmails.accountId, syncedEmails.externalId] })
    .returning({ id: syncedEmails.id });
  return row ?? null;
}

/** Tags a kept-out email in Outlook (`microsoft.withheldCategory`), so the teammate can see it didn't go into the CRM. */
async function markWithheld(account: ConnectedAccount, m: GraphMessage) {
  const category = withheldCategory();
  if (!category || m.categories?.includes(category)) return;
  try {
    await graph(account, `/me/messages/${m.id}`, { method: "PATCH", json: { categories: [...(m.categories ?? []), category] } });
  } catch (err) {
    if (err instanceof ReconnectError) throw err;
    console.error("[microsoft] mark withheld", err);
  }
}

/** Every connected mailbox that syncs mail, for the cron. */
export async function mailboxesToSync() {
  const db = await getDb();
  return db
    .select({ account: schema.connectedAccounts })
    .from(schema.connectedAccounts)
    .innerJoin(schema.users, eq(schema.users.id, schema.connectedAccounts.userId))
    .where(and(eq(schema.connectedAccounts.status, "active"), eq(schema.connectedAccounts.syncMail, true), isNull(schema.users.deactivatedAt)))
    .then((rows) => rows.map((r) => r.account));
}

/** What the sync did lately for one mailbox, for Settings: counts over the last 30 days. */
export async function mailboxStats(accountId: string) {
  const db = await getDb();
  const [row] = await db
    .select({
      imported: sql<number>`count(*) filter (where ${syncedEmails.status} = 'imported')::int`,
      withheld: sql<number>`count(*) filter (where ${syncedEmails.status} = 'withheld')::int`,
      unscreened: sql<number>`count(*) filter (where ${syncedEmails.status} = 'imported' and ${syncedEmails.reason} like 'Not screened%')::int`,
    })
    .from(syncedEmails)
    .where(and(eq(syncedEmails.accountId, accountId), sql`${syncedEmails.createdAt} > now() - interval '30 days'`));
  return row ?? { imported: 0, withheld: 0, unscreened: 0 };
}

/**
 * Removes the synced copies of a mailbox's mail from timelines, when a
 * teammate disconnects and asks for it. The rows become kept-out tombstones,
 * like a deletion, so a teammate's copy of the same message isn't copied back.
 */
export async function removeSyncedMail(accountId: string) {
  const db = await getDb();
  const ids = db.select({ id: syncedEmails.id }).from(syncedEmails).where(eq(syncedEmails.accountId, accountId));
  await db.delete(activities).where(and(isNotNull(activities.syncedEmailId), inArray(activities.syncedEmailId, ids)));
  await db
    .update(syncedEmails)
    .set({ status: "withheld", reason: "Removed when the mailbox was disconnected" })
    .where(and(eq(syncedEmails.accountId, accountId), eq(syncedEmails.status, "imported")));
}
