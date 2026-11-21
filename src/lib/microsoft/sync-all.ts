import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { microsoftConfigured, syncEveryMinutes } from "@/lib/microsoft/config";
import { GraphError } from "@/lib/microsoft/graph";
import { mailboxesToSync, mailboxSyncContext, syncMailbox } from "@/lib/microsoft/mail";

/** Whether this quarter-hour slot is one `microsoft.syncEveryMinutes` (15, 30 or 60) syncs on. */
export function microsoftSlotDue(now = new Date()) {
  const slot = Math.round((now.getUTCHours() * 60 + now.getUTCMinutes()) / 15) * 15;
  return slot % syncEveryMinutes() === 0;
}

/**
 * Syncs every connected Microsoft 365 mailbox, longest-waiting first, until
 * `budgetMs` is spent; the rest go first next time. What every mailbox needs
 * to know about the team is read once for the whole run.
 */
export async function syncAllMailboxes({ budgetMs = 240_000 } = {}) {
  if (!microsoftConfigured()) return { skipped: "Microsoft 365 isn't set up." };
  const started = Date.now();
  const accounts = (await mailboxesToSync()).sort((a, b) => (a.lastSyncAt?.getTime() ?? 0) - (b.lastSyncAt?.getTime() ?? 0));
  if (!accounts.length) return { mailboxes: 0, results: [] };
  const [db, shared] = await Promise.all([getDb(), mailboxSyncContext()]);
  const results: { email: string; imported?: number; withheld?: number; error?: string }[] = [];
  const one = async (account: (typeof accounts)[number]) => {
    try {
      results.push({ email: account.email, ...(await syncMailbox(account, shared)) });
    } catch (err) {
      const message = err instanceof GraphError ? err.message : "The sync failed. It's tried again next time.";
      if (!(err instanceof GraphError)) console.error("[cron microsoft]", account.email, err);
      await db.update(schema.connectedAccounts).set({ lastError: message, lastSyncAt: new Date(), updatedAt: new Date() }).where(eq(schema.connectedAccounts.id, account.id));
      results.push({ email: account.email, error: message });
    }
  };
  // One mailbox at a time. Teammates' mailboxes often hold the same email (both on the thread), and a
  // message is put on the record from the first mailbox that gets to it: two syncs at once could both
  // check before either saved, and log it twice.
  for (const account of accounts) {
    if (Date.now() - started > budgetMs) break;
    await one(account);
  }
  return { mailboxes: accounts.length, results };
}
