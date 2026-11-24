"use server";

import { refresh } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { run, type Result } from "@/lib/action";
import { ActionError, actionEditor, actionOwner, actionUser } from "@/lib/auth";
import { recordEvent } from "@/lib/crm/events";
import { calendarSharings } from "@/lib/constants";
import { microsoftConfigured } from "@/lib/microsoft/config";
import { emailBrand } from "@/lib/brand";
import { composerSignature } from "@/lib/email/signature";
import { accountOf, GraphError } from "@/lib/microsoft/graph";
import { clearPrivateMail, INBOX, listMailFolders, removePrivateEmail, removeSyncedMail, SENT_ITEMS, shareSyncedEmail, syncMailbox, unshareSyncedEmail } from "@/lib/microsoft/mail";
import { MAX_BLOCKED, parseBlockList } from "@/lib/microsoft/sync-rules";
import { sanitizeSignatureHtml, signatureHasContent } from "@/lib/safe-html";

/**
 * A teammate's own connected Microsoft 365 account: what it's used for, who
 * sees their calendar, syncing now, and disconnecting. Each teammate manages
 * only their own. The one exception is `disconnectTeammateMicrosoft`: an
 * owner can cut anyone's connection, and nothing more.
 */

const t = schema.connectedAccounts;

/** The mailbox the email composer can send from, if the signed-in teammate connected one that can send. */
export async function myMailbox() {
  const user = await actionUser();
  if (!microsoftConfigured()) return null;
  const account = await accountOf(user.id);
  if (!account || !account.sendMail) return null;
  return { email: account.email, name: account.name, needsReconnect: account.status !== "active" };
}

/** The signature the composer offers under email from the teammate's Outlook: their own, or the workspace's. Null when there's neither. */
export async function myEmailSignature() {
  const user = await actionUser();
  return composerSignature(user, (await emailBrand()).signature);
}

const signatureInput = z.object({
  /** The signature as the editor wrote it. Sanitized before it's saved; empty removes it. */
  html: z.string().max(100_000, "That signature is too long. Use smaller or fewer images, or shorten it."),
  /** Put it on every Outlook email to start with. */
  auto: z.boolean(),
});

/** Saves the teammate's own email signature, and whether it goes on every email they send from Outlook. */
export async function updateEmailSignature(input: z.input<typeof signatureInput>): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const data = signatureInput.parse(input);
    const html = sanitizeSignatureHtml(data.html);
    if (html.length > 20_000) throw new ActionError("That signature is too long. Shorten it, or use fewer images.");
    const db = await getDb();
    await db
      .update(schema.users)
      .set({ emailSignature: signatureHasContent(html) ? html : null, signatureAuto: data.auto })
      .where(eq(schema.users.id, user.id));
    refresh();
  });
}

const settingsInput = z.object({
  sendMail: z.boolean().optional(),
  syncMail: z.boolean().optional(),
  syncCalendar: z.boolean().optional(),
  calendarSharing: z.enum(calendarSharings).optional(),
  /** The block list as typed: addresses and domains, one per line or separated by commas. */
  blocked: z.string().max(20_000).optional(),
  /** The folders to sync, or null for Inbox and Sent Items. */
  mailFolders: z.array(z.object({ id: z.string().min(1).max(300), name: z.string().min(1).max(200) })).min(1).max(25).nullable().optional(),
});

export async function updateMicrosoftAccount(input: z.input<typeof settingsInput>): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const { blocked, ...data } = settingsInput.parse(input);
    const list = blocked === undefined ? undefined : parseBlockList(blocked);
    if (list?.invalid.length) throw new ActionError(`These aren't email addresses or domains: ${list.invalid.slice(0, 5).join(", ")}. Use one per line, like jo@acme.com or acme.com.`);
    if (list?.tooMany) throw new ActionError(`A block list holds up to ${MAX_BLOCKED} addresses and domains.`);
    const db = await getDb();
    // Inbox or Sent Items coming back into the sync starts from now, not from wherever it was left months ago.
    let mailCursor: Record<string, string> | undefined;
    if (data.mailFolders !== undefined) {
      const account = await accountOf(user.id);
      if (account) {
        const synced = (folders: { id: string }[] | null) => (folders?.length ? folders.map((f) => f.id) : [INBOX, SENT_ITEMS]);
        const before = synced(account.mailFolders);
        const now = new Date().toISOString();
        mailCursor = { ...account.mailCursor };
        for (const [id, key] of [[INBOX, "inbox"], [SENT_ITEMS, "sent"]] as const) if (synced(data.mailFolders).includes(id) && !before.includes(id)) mailCursor[key] = now;
      }
    }
    const rows = await db
      .update(t)
      .set({ ...data, ...(list ? { blocked: list.entries } : {}), ...(mailCursor ? { mailCursor } : {}), updatedAt: new Date() })
      .where(and(eq(t.userId, user.id), eq(t.provider, "microsoft")))
      .returning({ id: t.id });
    if (!rows.length) throw new ActionError("Your Microsoft account isn't connected anymore. Connect it again.");
    refresh();
  });
}

/** Runs the mailbox sync for the signed-in teammate right away. */
export async function syncMyMailbox(): Promise<Result<{ imported: number; private: number; withheld: number }>> {
  return run(async () => {
    const user = await actionUser();
    const account = await accountOf(user.id);
    if (!account) throw new ActionError("Connect your Microsoft account first.");
    if (!account.syncMail) throw new ActionError("Mail sync is off. Turn it on first.");
    try {
      const result = await syncMailbox(account);
      refresh();
      return result;
    } catch (err) {
      if (err instanceof GraphError) {
        const db = await getDb();
        await db.update(t).set({ lastError: err.message, updatedAt: new Date() }).where(eq(t.id, account.id));
        refresh();
        throw new ActionError(err.message);
      }
      throw err;
    }
  });
}

/**
 * Forgets the connection: its tokens are deleted at once, so the CRM can't
 * reach the mailbox again. Mail already copied to records stays unless
 * `removeMail` is set. Meetings already on their calendar stay there.
 */
export async function disconnectMicrosoft(input: { removeMail?: boolean } = {}): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const account = await accountOf(user.id);
    if (!account) return;
    if (input.removeMail === true) await removeSyncedMail(account.id);
    else await clearPrivateMail(account.id);
    const db = await getDb();
    await db.delete(t).where(eq(t.id, account.id));
    refresh();
  });
}

const teammateInput = z.object({ userId: z.uuid(), removeMail: z.boolean().optional() });

/**
 * An owner cuts a teammate's connection (they left, a device was lost): the
 * tokens are deleted at once, exactly as if the teammate had disconnected.
 * It never reads the mailbox, and only the teammate can connect it again.
 */
export async function disconnectTeammateMicrosoft(input: z.input<typeof teammateInput>): Promise<Result<{ email: string | null }>> {
  return run(async () => {
    const owner = await actionOwner();
    const data = teammateInput.parse(input);
    const account = await accountOf(data.userId);
    if (!account) {
      refresh();
      return { email: null };
    }
    if (data.removeMail === true) await removeSyncedMail(account.id);
    else await clearPrivateMail(account.id);
    const db = await getDb();
    await db.delete(t).where(eq(t.id, account.id));
    console.info(`[microsoft] owner ${owner.id} disconnected the account of user ${data.userId}${data.removeMail ? ", copied mail removed" : ""}`);
    refresh();
    return { email: account.email };
  });
}

/** The signed-in teammate's own mail folders, for choosing which ones sync. */
export async function myMailFolders(): Promise<Result<{ id: string; name: string }[]>> {
  return run(async () => {
    const user = await actionUser();
    const account = await accountOf(user.id);
    if (!account) throw new ActionError("Connect your Microsoft account first.");
    try {
      return await listMailFolders(account);
    } catch (err) {
      if (err instanceof GraphError) throw new ActionError(err.message);
      throw err;
    }
  });
}

const visibilityInput = z.object({ id: z.uuid(), visibility: z.enum(["public", "private"]) });

/**
 * Shares a private synced email with the team, or takes a shared one back to
 * private. Only for mail from the signed-in teammate's own mailbox: the
 * lookup is by their session, so no id reaches anyone else's.
 */
export async function setSyncedEmailVisibility(input: z.input<typeof visibilityInput>): Promise<Result> {
  return run(async () => {
    const user = await actionEditor();
    const data = visibilityInput.parse(input);
    if (data.visibility === "public") await shareSyncedEmail(user.id, data.id);
    else {
      const links = await unshareSyncedEmail(user.id, data.id);
      const entity = links?.clientId ? ("client" as const) : links?.personId ? ("person" as const) : links?.organizationId ? ("organization" as const) : null;
      // The history says an email came off the record, never what it was about.
      if (links && entity) await recordEvent({ entityType: entity, entityId: (links.clientId ?? links.personId ?? links.organizationId)!, action: "activity_deleted", data: { type: "email" }, userId: user.id });
    }
    refresh();
  });
}

/** Deletes one of the signed-in teammate's private synced emails from the CRM. It stays in their Outlook and is never synced again. */
export async function deletePrivateEmail(id: string): Promise<Result> {
  return run(async () => {
    const user = await actionEditor();
    await removePrivateEmail(user.id, z.uuid().parse(id));
    refresh();
  });
}

const blockInput = z.object({ entry: z.string().trim().min(1).max(320) });

/**
 * Puts one address or domain on the signed-in teammate's block list, so mail
 * with it on is never synced from their mailbox again (`isBlocked`). Mail
 * already synced stays until they delete it. Adding one that's there is fine.
 */
export async function blockMailSender(input: z.input<typeof blockInput>): Promise<Result<{ entry: string }>> {
  return run(async () => {
    const user = await actionUser();
    const { entry } = blockInput.parse(input);
    const account = await accountOf(user.id);
    if (!account) throw new ActionError("Your Microsoft account isn't connected anymore. Connect it again.");
    const list = parseBlockList([...account.blocked, entry]);
    if (list.invalid.length) throw new ActionError(`${list.invalid[0]} isn't an email address or domain. Use one like jo@acme.com or acme.com.`);
    if (list.tooMany) throw new ActionError(`A block list holds up to ${MAX_BLOCKED} addresses and domains. Remove some first.`);
    const db = await getDb();
    await db.update(t).set({ blocked: list.entries, updatedAt: new Date() }).where(eq(t.id, account.id));
    refresh();
    return { entry: parseBlockList([entry]).entries[0]! };
  });
}

/** Takes one address or domain off the signed-in teammate's block list. Mail with it on syncs again from the next sync; what was skipped meanwhile isn't brought back. */
export async function unblockMailSender(input: z.input<typeof blockInput>): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const entry = blockInput.parse(input).entry.toLowerCase().replace(/^@/, "");
    const account = await accountOf(user.id);
    if (!account) throw new ActionError("Your Microsoft account isn't connected anymore. Connect it again.");
    const db = await getDb();
    await db
      .update(t)
      .set({ blocked: account.blocked.filter((b) => b !== entry), updatedAt: new Date() })
      .where(eq(t.id, account.id));
    refresh();
  });
}
