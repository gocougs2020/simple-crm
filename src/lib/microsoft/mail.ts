import "server-only";
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { ActionError, NotFoundError } from "@/lib/errors";
import { appConfig } from "@/app.config";
import { getDb, schema } from "@/db";
import { touch } from "@/lib/crm/events";
import { linksForEmails, type Links } from "@/lib/crm/match";
import type { LoadedAttachment } from "@/lib/email/attachments";
import { sanitizeHtml, textToHtml } from "@/lib/safe-html";
import { getWorkspace } from "@/lib/workspace";
import { withheldCategory } from "./config";
import { internalDomains, isBlocked, isInternal, outsiders } from "./sync-rules";
import { graph, graphPages, GraphError, ReconnectError, type ConnectedAccount } from "./graph";
import { graphAddress, outlookSensitivity, SENSITIVITY_PROPERTY, stripQuoted } from "./mail-text";
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
  receivedDateTime?: string;
  sentDateTime?: string;
  body?: { contentType: string; content: string };
  /** Asked for with `SENSITIVITY`: Outlook's sensitivity label, which Graph has no named property for on a message. */
  singleValueExtendedProperties?: { id: string; value: string }[];
  categories?: string[];
  isDraft?: boolean;
  /** In a delta read: the message left the folder. */
  "@removed"?: unknown;
};

/**
 * A message has no `sensitivity` property in Graph (only events do), so the
 * label is read from the MAPI property behind it (`SENSITIVITY_PROPERTY`).
 */
const SELECT = `id,internetMessageId,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,body,categories,isDraft&$expand=${encodeURIComponent(`singleValueExtendedProperties($filter=id eq '${SENSITIVITY_PROPERTY}')`)}`;
/** Plain-text bodies read better on a timeline than sanitized Outlook HTML, and are what the screen reads. */
const TEXT_BODY = { headers: { Prefer: 'outlook.body-content-type="text"' } };
const TEXT_BODY_DELTA = { headers: { Prefer: 'outlook.body-content-type="text", odata.maxpagesize=50' } };
/** Overlap between syncs, so mail that arrives while one runs is never skipped. */
const OVERLAP_MS = 10 * 60_000;
/** Pages of 50 read from one folder in one run. A bigger backlog carries on next time. */
const MAX_PAGES = 6;

/** The two folders synced unless the teammate picks their own, as they're stored in `mail_folders` and named in Graph. */
export const INBOX = "inbox";
export const SENT_ITEMS = "sentitems";

/**
 * A folder to read. Inbox and Sent Items are read by date, from the newest
 * message already seen. A folder the teammate picked is read with Graph's
 * delta query instead, which also reports mail moved into it, however old.
 */
type SyncFolder = { /** Its key in `mail_cursor`. */ key: string; path: string; sent: boolean; delta: boolean };

function foldersFor(account: ConnectedAccount): SyncFolder[] {
  const inbox: SyncFolder = { key: "inbox", path: INBOX, sent: false, delta: false };
  const sent: SyncFolder = { key: "sent", path: SENT_ITEMS, sent: true, delta: false };
  if (!account.mailFolders?.length) return appConfig.microsoft.syncSent ? [inbox, sent] : [inbox];
  return account.mailFolders.map((f) => (f.id === INBOX ? inbox : f.id === SENT_ITEMS ? sent : { key: f.id, path: encodeURIComponent(f.id), sent: false, delta: true }));
}

type Page = { value?: GraphMessage[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string };

/** What's new in one folder, and where to carry on from next time. */
async function readFolder(account: ConnectedAccount, folder: SyncFolder, cursor: string | undefined): Promise<{ messages: GraphMessage[]; cursor: string | undefined }> {
  if (!folder.delta) {
    const since = new Date(cursor && !cursor.startsWith("https://") ? new Date(cursor).getTime() - OVERLAP_MS : Date.now() - appConfig.microsoft.firstSyncDays * 86400_000);
    const messages = await graphPages<GraphMessage>(
      account,
      `/me/mailFolders/${folder.path}/messages?$filter=${encodeURIComponent(`receivedDateTime ge ${since.toISOString()}`)}&$orderby=receivedDateTime asc&$top=50&$select=${SELECT}`,
      TEXT_BODY,
      MAX_PAGES,
    );
    let newest = cursor && !cursor.startsWith("https://") ? cursor : undefined;
    for (const m of messages) if (m.receivedDateTime && (!newest || m.receivedDateTime > newest)) newest = m.receivedDateTime;
    return { messages, cursor: newest };
  }
  const start = `/me/mailFolders/${folder.path}/messages/delta?$select=${SELECT}`;
  const read = async (from: string) => {
    const messages: GraphMessage[] = [];
    let link = from;
    let next: string | undefined = from;
    for (let page = 0; next && page < MAX_PAGES; page++) {
      const res: Page = await graph<Page>(account, next, TEXT_BODY_DELTA);
      messages.push(...(res?.value ?? []).filter((m) => !m["@removed"]));
      // A next link when there's more to read (carried on next run), the delta link once the folder is caught up.
      link = res?.["@odata.nextLink"] ?? res?.["@odata.deltaLink"] ?? link;
      next = res?.["@odata.nextLink"];
    }
    return { messages, cursor: link };
  };
  try {
    return await read(cursor?.startsWith("https://") ? cursor : start);
  } catch (err) {
    // Graph forgot where we were (an old delta link): read the folder again. What's already stored is skipped.
    if (cursor && err instanceof GraphError && !(err instanceof ReconnectError) && (err.status === 410 || err.status === 400)) return read(start);
    throw err;
  }
}

export type MailboxSyncResult = { imported: number; private: number; withheld: number };

/**
 * Brings a mailbox's mail with contacts into the CRM: what's new in Inbox and
 * Sent Items, or in the folders the teammate picked. An email is only looked
 * at when someone on it (From, To or Cc) is outside our own organization and
 * is a person in the CRM, and nobody on it is on the teammate's block list.
 * Each one is screened first: it goes on the record for the team, is kept
 * private to the teammate, or isn't stored. Safe to run as often as you like.
 */
/**
 * What every mailbox's sync needs to know about the team: the teammates, every
 * connected mailbox's address and the workspace's name. The same for every
 * mailbox in a run, so the cron reads it once (`syncMailbox`'s `shared`).
 */
export async function mailboxSyncContext() {
  const db = await getDb();
  const [users, connected, ws] = await Promise.all([
    db.select({ email: schema.users.email, name: schema.users.name }).from(schema.users),
    db.select({ email: schema.connectedAccounts.email }).from(schema.connectedAccounts),
    getWorkspace(),
  ]);
  return { users, mailboxes: connected.map((m) => m.email.toLowerCase()), workspaceName: ws.name };
}

export async function syncMailbox(account: ConnectedAccount, shared?: Awaited<ReturnType<typeof mailboxSyncContext>>): Promise<MailboxSyncResult> {
  const db = await getDb();
  const result: MailboxSyncResult = { imported: 0, private: 0, withheld: 0 };
  // Every teammate's sign-in address and every connected mailbox's address: someone's Outlook address can differ from the email they sign in with.
  const { users, mailboxes, workspaceName } = shared ?? (await mailboxSyncContext());
  const team = new Set([...users.map((u) => u.email.toLowerCase()), ...mailboxes, account.email.toLowerCase()]);
  // Everyone at our own domains is on our side too, with or without a login here.
  const domains = internalDomains([...mailboxes, account.email], appConfig.microsoft.internalDomains);
  // For the screen: who's on our side, so mail between teammates (one of them also in the CRM as a person) is recognized.
  const ourTeam = [...new Set([...users.map((u) => `${u.name} <${u.email.toLowerCase()}>`), ...mailboxes, account.email.toLowerCase()])];
  const ctx: Ctx = { account, team, domains, ourTeam, workspaceName, result };

  const cursor: Record<string, string> = { ...account.mailCursor };
  for (const folder of foldersFor(account)) {
    const { messages, cursor: next } = await readFolder(account, folder, cursor[folder.key]);
    // One lookup for the whole batch: the overlap re-reads the last few minutes on every run, and those are all known.
    const seen = new Set(
      messages.length
        ? (
            await db
              .select({ externalId: syncedEmails.externalId })
              .from(syncedEmails)
              .where(and(eq(syncedEmails.accountId, account.id), inArray(syncedEmails.externalId, messages.map((m) => m.id))))
          ).map((r) => r.externalId)
        : [],
    );
    for (const m of messages) {
      if (m.isDraft || !m.id || !m.receivedDateTime || seen.has(m.id)) continue;
      await handleMessage(ctx, m, folder);
    }
    if (next) cursor[folder.key] = next;
    else delete cursor[folder.key];
  }

  await db
    .update(schema.connectedAccounts)
    .set({ mailCursor: cursor, lastSyncAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(eq(schema.connectedAccounts.id, account.id));
  return result;
}

type Ctx = { account: ConnectedAccount; team: Set<string>; domains: Set<string>; ourTeam: string[]; workspaceName: string; result: MailboxSyncResult };

async function handleMessage(ctx: Ctx, m: GraphMessage, folder: SyncFolder) {
  const db = await getDb();
  const { account } = ctx;
  const from = graphAddress(m.from);
  const to = [...(m.toRecipients ?? []), ...(m.ccRecipients ?? [])].map(graphAddress).filter((a) => a.address);
  // Sent Items is mail out. Anywhere else, it's out when one of us wrote it.
  const direction: "inbound" | "outbound" = folder.sent || (!!from.address && isInternal(from.address, ctx.team, ctx.domains)) ? "outbound" : "inbound";
  // Everyone on it who isn't us: the sender, To and Cc. A teammate who's also a person in the CRM doesn't count.
  const everyone = [from.address, ...to.map((a) => a.address)].filter(Boolean);
  const others = outsiders(everyone, ctx.team, ctx.domains);
  if (!others.length) return;
  // The teammate said never to sync mail with this address or domain, one of ours included. Nothing about it is kept.
  if (isBlocked(everyone, account.blocked)) return;
  // One of them has to be a person here. An organization's website matching isn't enough.
  const links = await linksForEmails(others, { peopleOnly: true });
  if (!links.personId) return;

  const sentAt = new Date(direction === "inbound" ? m.receivedDateTime! : (m.sentDateTime ?? m.receivedDateTime!));
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
  const text = stripQuoted(m.body?.contentType === "text" ? m.body.content : (m.body?.content ?? "").replace(/<[^>]+>/g, " "));
  const content = { subject: m.subject?.trim() || null, body: text ? sanitizeHtml(textToHtml(text)) : null };
  const keepPrivate = async (reason: string, score?: number | null) => {
    if (await save(base, "private", reason, score, content)) ctx.result.private++;
  };

  // Outlook's own sensitivity label is the sender's word for it: always kept out, before anything else, so no copy of it is ever stored.
  const sensitivity = outlookSensitivity(m.singleValueExtendedProperties);
  if (sensitivity) {
    if (await save(base, "withheld", `Marked ${sensitivity} in Outlook`)) await markWithheld(account, m);
    ctx.result.withheld++;
    return;
  }

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
    // Another copy of the same message was kept out, kept private, or deleted from the records: this copy follows it.
    const others = await db
      .select({ accountId: syncedEmails.accountId, status: syncedEmails.status, reason: syncedEmails.reason })
      .from(syncedEmails)
      .where(and(eq(syncedEmails.internetMessageId, m.internetMessageId), inArray(syncedEmails.status, ["withheld", "private"])))
      .limit(20);
    const keptOut = others.find((o) => o.status === "withheld");
    if (keptOut) {
      if (await save(base, "withheld", `Kept out on another copy: ${keptOut.reason ?? "withheld"}`.slice(0, 300))) await markWithheld(account, m);
      ctx.result.withheld++;
      return;
    }
    // Their own private copy, met again in another folder (moving a message gives it a new id): noted, not stored twice.
    if (others.some((o) => o.accountId === account.id)) {
      await save(base, "imported", "Already synced from another folder");
      return;
    }
    // Private on a teammate's copy, so private on this one: each of them sees their own, and either can share it.
    if (others.length) return keepPrivate("Kept private on a teammate's copy");
  }

  // The screen answers with how likely the email is to be sensitive: fine for the team, private to this teammate, or not stored.
  const verdict = await screenEmail({ from: from.display, to: to.map((a) => a.display), subject: m.subject ?? null, text, ourTeam: ctx.ourTeam }, ctx.workspaceName);
  if (verdict.decision === "withhold") {
    if (await save(base, "withheld", verdict.reason, verdict.score)) await markWithheld(account, m);
    ctx.result.withheld++;
    return;
  }
  if (verdict.decision === "private") return keepPrivate(verdict.reason, verdict.score);

  const row = await save(base, "imported", verdict.screened ? null : verdict.reason, verdict.score);
  if (!row) return;
  // Undone if the activity can't be saved, so the next sync tries the message again instead of skipping it.
  const undo = (err: unknown) => db.delete(syncedEmails).where(eq(syncedEmails.id, row.id)).then(() => Promise.reject(err));
  await db.insert(activities).values(activityFor({ ...base, id: row.id, ...content }, account.userId)).catch(undo);
  await touch(links, sentAt);
  ctx.result.imported++;
}

/** The timeline entry for a copied email. Mail they sent is theirs; mail in arrived by itself, like a connected inbox's. */
function activityFor(
  e: { id: string; direction: "inbound" | "outbound"; subject: string | null; body: string | null; sentAt: Date } & Links,
  mailboxUserId: string,
): typeof activities.$inferInsert {
  return {
    type: "email",
    direction: e.direction,
    subject: e.subject,
    body: e.body,
    occurredAt: e.sentAt,
    userId: e.direction === "outbound" ? mailboxUserId : null,
    assigneeId: e.direction === "outbound" ? mailboxUserId : null,
    syncedEmailId: e.id,
    personId: e.personId,
    organizationId: e.organizationId,
    clientId: e.clientId,
  };
}

/** Records what happened to a message, once: a concurrent sync that loses the race gets null and stops. */
async function save(
  base: Omit<typeof syncedEmails.$inferInsert, "status" | "reason"> & Links,
  status: "imported" | "private" | "withheld",
  reason: string | null,
  screenScore?: number | null,
  /** The email itself, kept only on a private row. */
  content?: { subject: string | null; body: string | null },
) {
  const db = await getDb();
  const [row] = await db
    .insert(syncedEmails)
    .values({ ...base, status, reason, screenScore: screenScore ?? null, ...(status === "private" ? content : {}) })
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
      private: sql<number>`count(*) filter (where ${syncedEmails.status} = 'private')::int`,
      withheld: sql<number>`count(*) filter (where ${syncedEmails.status} = 'withheld')::int`,
      unscreened: sql<number>`count(*) filter (where ${syncedEmails.status} = 'private' and ${syncedEmails.reason} like 'Not screened%')::int`,
    })
    .from(syncedEmails)
    .where(and(eq(syncedEmails.accountId, accountId), sql`${syncedEmails.createdAt} > now() - interval '30 days'`));
  return row ?? { imported: 0, private: 0, withheld: 0, unscreened: 0 };
}

/**
 * What the sync stored from one mailbox, newest first, for that teammate's own
 * "My Outlook" list: mail on records for the team, and mail kept private to
 * them. Always called with the signed-in teammate's own account: nobody reads
 * another mailbox's list, whatever their role.
 */
export async function copiedMail(accountId: string, limit = 100) {
  const db = await getDb();
  const { people, organizations, clients } = schema;
  return db
    .select({
      id: syncedEmails.id,
      activityId: activities.id,
      status: syncedEmails.status,
      reason: syncedEmails.reason,
      direction: syncedEmails.direction,
      from: syncedEmails.from,
      to: syncedEmails.to,
      sentAt: syncedEmails.sentAt,
      subject: sql<string | null>`coalesce(${activities.subject}, ${syncedEmails.subject})`,
      body: sql<string | null>`coalesce(${activities.body}, ${syncedEmails.body})`,
      personId: syncedEmails.personId,
      personName: sql<string | null>`case when ${people.id} is null then null else ${people.firstName} || coalesce(' ' || ${people.lastName}, '') end`,
      organizationId: syncedEmails.organizationId,
      organizationName: organizations.name,
      clientId: syncedEmails.clientId,
      clientName: clients.name,
    })
    .from(syncedEmails)
    .leftJoin(activities, eq(activities.syncedEmailId, syncedEmails.id))
    .leftJoin(people, eq(people.id, syncedEmails.personId))
    .leftJoin(organizations, eq(organizations.id, syncedEmails.organizationId))
    .leftJoin(clients, eq(clients.id, syncedEmails.clientId))
    // On records through this mailbox's own copy, or private. Not the rows that only say "a teammate's copy is already there".
    .where(and(eq(syncedEmails.accountId, accountId), or(eq(syncedEmails.status, "private"), and(eq(syncedEmails.status, "imported"), isNotNull(activities.id)))))
    .orderBy(desc(syncedEmails.sentAt))
    .limit(limit);
}

export type PrivateMail = { id: string; direction: "inbound" | "outbound"; from: string | null; to: string[]; sentAt: Date; subject: string | null; body: string | null };

/**
 * A record's private mail for one teammate: what the sync kept from their own
 * mailbox without putting it on the record. The mailbox has to be theirs, so
 * a timeline shows it to them and to nobody else.
 */
const privateMailWhere = (entity: "person" | "organization" | "client", id: string, viewerId: string) => {
  const column = entity === "person" ? syncedEmails.personId : entity === "organization" ? syncedEmails.organizationId : syncedEmails.clientId;
  return and(eq(schema.connectedAccounts.userId, viewerId), eq(syncedEmails.status, "private"), eq(column, id));
};

export async function privateMailOn(entity: "person" | "organization" | "client", id: string, viewerId: string, o: { before?: Date | null; limit?: number } = {}): Promise<PrivateMail[]> {
  const db = await getDb();
  return db
    .select({ id: syncedEmails.id, direction: syncedEmails.direction, from: syncedEmails.from, to: syncedEmails.to, sentAt: syncedEmails.sentAt, subject: syncedEmails.subject, body: syncedEmails.body })
    .from(syncedEmails)
    .innerJoin(schema.connectedAccounts, eq(schema.connectedAccounts.id, syncedEmails.accountId))
    .where(and(privateMailWhere(entity, id, viewerId), o.before ? lt(syncedEmails.sentAt, o.before) : undefined))
    .orderBy(desc(syncedEmails.sentAt))
    .limit(o.limit ?? 100);
}

/** How many private emails the viewer has on a record (the timeline's Conversations count). */
export async function privateMailCount(entity: "person" | "organization" | "client", id: string, viewerId: string) {
  const db = await getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(syncedEmails)
    .innerJoin(schema.connectedAccounts, eq(schema.connectedAccounts.id, syncedEmails.accountId))
    .where(privateMailWhere(entity, id, viewerId));
  return row?.n ?? 0;
}

/** One synced email, only if it came from this teammate's own mailbox. */
async function ownSyncedEmail(userId: string, syncedEmailId: string) {
  const db = await getDb();
  const [row] = await db
    .select({ email: syncedEmails })
    .from(syncedEmails)
    .innerJoin(schema.connectedAccounts, eq(schema.connectedAccounts.id, syncedEmails.accountId))
    .where(and(eq(syncedEmails.id, syncedEmailId), eq(schema.connectedAccounts.userId, userId)));
  return row?.email ?? null;
}

const GONE = "That email isn't in your synced mail anymore.";

/**
 * Puts a private email on its record for the whole team. Only the teammate
 * whose mailbox it came from can. A teammate's private copy of the same
 * message stops being a separate entry, since it's on the record now.
 */
export async function shareSyncedEmail(userId: string, syncedEmailId: string) {
  const db = await getDb();
  const e = await ownSyncedEmail(userId, syncedEmailId);
  if (!e || e.status !== "private") throw new NotFoundError(GONE);
  if (!e.personId && !e.organizationId && !e.clientId) throw new ActionError("The record this email was with isn't in the CRM anymore, so there's nowhere to share it.");
  // Claimed first, so two clicks (or two tabs) put it on the record once.
  const claimed = await db
    .update(syncedEmails)
    .set({ status: "imported", reason: "Shared by its teammate", subject: null, body: null })
    .where(and(eq(syncedEmails.id, e.id), eq(syncedEmails.status, "private")))
    .returning({ id: syncedEmails.id });
  if (!claimed.length) return;
  await db
    .insert(activities)
    .values(activityFor(e, userId))
    .catch((err) =>
      db
        .update(syncedEmails)
        .set({ status: "private", reason: e.reason, subject: e.subject, body: e.body })
        .where(eq(syncedEmails.id, e.id))
        .then(() => Promise.reject(err)),
    );
  if (e.internetMessageId)
    await db
      .update(syncedEmails)
      .set({ status: "imported", reason: "Already on the record from a teammate's mailbox", subject: null, body: null })
      .where(and(eq(syncedEmails.internetMessageId, e.internetMessageId), eq(syncedEmails.status, "private")));
  await touch(e, e.sentAt);
}

/**
 * Takes an email off its record and keeps it for the teammate whose mailbox
 * it came from: they still see it, nobody else does. Returns what it was
 * linked to, for the history entry.
 */
export async function unshareSyncedEmail(userId: string, syncedEmailId: string): Promise<Links | null> {
  const db = await getDb();
  const e = await ownSyncedEmail(userId, syncedEmailId);
  if (!e || e.status !== "imported") throw new NotFoundError(GONE);
  const [activity] = await db.select().from(activities).where(eq(activities.syncedEmailId, e.id));
  if (!activity) throw new ActionError("This email is on the record from the CRM or a teammate's mailbox, not from yours, so it can't be made private here.");
  await db.update(syncedEmails).set({ status: "private", reason: "Made private by its teammate", subject: activity.subject, body: activity.body }).where(eq(syncedEmails.id, e.id));
  await db.delete(activities).where(eq(activities.id, activity.id));
  return { personId: activity.personId, organizationId: activity.organizationId, clientId: activity.clientId };
}

/** Deletes a private email from the CRM: its content is cleared and it's never synced again. It stays in Outlook. */
export async function removePrivateEmail(userId: string, syncedEmailId: string) {
  const db = await getDb();
  const e = await ownSyncedEmail(userId, syncedEmailId);
  if (!e || e.status !== "private") return;
  await db.update(syncedEmails).set({ status: "withheld", reason: "Deleted by its teammate", subject: null, body: null }).where(and(eq(syncedEmails.id, e.id), eq(syncedEmails.status, "private")));
}

/**
 * The folders a teammate can pick to sync: the top of their mailbox and the
 * folders inside Inbox. Inbox and Sent Items come back under their fixed
 * names (`INBOX`, `SENT_ITEMS`), which is how the sync recognizes them.
 */
export async function listMailFolders(account: ConnectedAccount): Promise<{ id: string; name: string }[]> {
  type F = { id: string; displayName: string };
  const [top, inbox, sent, inInbox] = await Promise.all([
    graphPages<F>(account, "/me/mailFolders?$top=100&$select=id,displayName", {}, 2),
    graph<F>(account, `/me/mailFolders/${INBOX}?$select=id,displayName`),
    graph<F>(account, `/me/mailFolders/${SENT_ITEMS}?$select=id,displayName`),
    graphPages<F>(account, `/me/mailFolders/${INBOX}/childFolders?$top=100&$select=id,displayName`, {}, 2),
  ]);
  const fixed = (f: F) => (f.id === inbox.id ? INBOX : f.id === sent.id ? SENT_ITEMS : f.id);
  return [...top.map((f) => ({ id: fixed(f), name: f.displayName })), ...inInbox.map((f) => ({ id: f.id, name: `${inbox.displayName} / ${f.displayName}` }))];
}

/**
 * Every teammate's connection, for an owner's overview in Settings: whose
 * mailbox and calendar, what it's used for and whether it's working. Never
 * the tokens, and nothing about the mail itself.
 */
export async function teamConnections() {
  const db = await getDb();
  const t = schema.connectedAccounts;
  return db
    .select({
      userId: t.userId,
      userName: schema.users.name,
      deactivated: sql<boolean>`${schema.users.deactivatedAt} is not null`,
      email: t.email,
      sendMail: t.sendMail,
      syncMail: t.syncMail,
      syncCalendar: t.syncCalendar,
      status: t.status,
      lastSyncAt: t.lastSyncAt,
    })
    .from(t)
    .innerJoin(schema.users, eq(schema.users.id, t.userId))
    .where(eq(t.provider, "microsoft"))
    .orderBy(schema.users.name);
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
    .set({ status: "withheld", reason: "Removed when the mailbox was disconnected", subject: null, body: null })
    .where(and(eq(syncedEmails.accountId, accountId), inArray(syncedEmails.status, ["imported", "private"])));
}

/**
 * Forgets a mailbox's private mail, on every disconnect: once the connection
 * is gone nobody could see it, so its content doesn't stay behind.
 */
export async function clearPrivateMail(accountId: string) {
  const db = await getDb();
  await db
    .update(syncedEmails)
    .set({ status: "withheld", reason: "Private, and cleared when the mailbox was disconnected", subject: null, body: null })
    .where(and(eq(syncedEmails.accountId, accountId), eq(syncedEmails.status, "private")));
}
