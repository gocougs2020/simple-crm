import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { microsoftConfigured, syncEveryMinutes } from "@/lib/microsoft/config";
import { GraphError } from "@/lib/microsoft/graph";
import { mailboxesToSync, mailboxSyncContext, syncMailbox } from "@/lib/microsoft/mail";

/** Mailboxes synced at the same time. Each mailbox's own folders and messages still go one at a time, in order. */
const MAILBOXES_AT_ONCE = 3;

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
  // A few mailboxes at a time (each is mostly waiting on Graph and the screen), in the same longest-waiting order.
  const queue = [...accounts];
  await Promise.all(
    Array.from({ length: Math.min(MAILBOXES_AT_ONCE, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        if (Date.now() - started > budgetMs) return;
        await one(next);
      }
    }),
  );
  return { mailboxes: accounts.length, results };
}
