"use server";

import { refresh } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { run, type Result } from "@/lib/action";
import { ActionError, actionUser } from "@/lib/auth";
import { calendarSharings } from "@/lib/constants";
import { microsoftConfigured } from "@/lib/microsoft/config";
import { accountOf, GraphError } from "@/lib/microsoft/graph";
import { removeSyncedMail, syncMailbox } from "@/lib/microsoft/mail";

/**
 * A teammate's own connected Microsoft 365 account: what it's used for, who
 * sees their calendar, syncing now, and disconnecting. Each teammate manages
 * only their own; nothing here reaches anyone else's connection.
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

const settingsInput = z.object({
  sendMail: z.boolean().optional(),
  syncMail: z.boolean().optional(),
  syncCalendar: z.boolean().optional(),
  calendarSharing: z.enum(calendarSharings).optional(),
});

export async function updateMicrosoftAccount(input: z.input<typeof settingsInput>): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const data = settingsInput.parse(input);
    const db = await getDb();
    const rows = await db
      .update(t)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(t.userId, user.id), eq(t.provider, "microsoft")))
      .returning({ id: t.id });
    if (!rows.length) throw new ActionError("Your Microsoft account isn't connected anymore. Connect it again.");
    refresh();
  });
}

/** Runs the mailbox sync for the signed-in teammate right away. */
export async function syncMyMailbox(): Promise<Result<{ imported: number; withheld: number }>> {
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
    const db = await getDb();
    await db.delete(t).where(eq(t.id, account.id));
    refresh();
  });
}
