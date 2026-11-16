import { connection, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { cronAuthorized } from "@/lib/cron";
import { microsoftConfigured, syncEveryMinutes } from "@/lib/microsoft/config";
import { GraphError } from "@/lib/microsoft/graph";
import { mailboxesToSync, syncMailbox } from "@/lib/microsoft/mail";

export const maxDuration = 300;

/** Stop starting new mailboxes after this, so the run finishes inside maxDuration. The rest go first next time. */
const BUDGET_MS = 240_000;

/**
 * Vercel Cron, on the quarter hour with the other jobs: syncs every connected
 * Microsoft 365 mailbox. Runs only on the quarter hours that fit
 * `microsoft.syncEveryMinutes` (every 15, 30 or 60 minutes), so a deployment
 * can sync less often to let the database sleep longer.
 */
export async function GET(request: Request) {
  await connection();
  if (!cronAuthorized(request)) return new NextResponse("Unauthorized", { status: 401 });
  if (!microsoftConfigured()) return NextResponse.json({ skipped: "Microsoft 365 isn't set up." });
  const every = syncEveryMinutes();
  const now = new Date();
  const slot = Math.round((now.getUTCHours() * 60 + now.getUTCMinutes()) / 15) * 15;
  if (slot % every !== 0 && !new URL(request.url).searchParams.has("force")) return NextResponse.json({ skipped: `Syncing every ${every} minutes.` });

  const started = Date.now();
  // Longest-waiting first, so a run that runs out of time doesn't starve the same mailboxes.
  const accounts = (await mailboxesToSync()).sort((a, b) => (a.lastSyncAt?.getTime() ?? 0) - (b.lastSyncAt?.getTime() ?? 0));
  const db = await getDb();
  const results: { email: string; imported?: number; withheld?: number; error?: string }[] = [];
  for (const account of accounts) {
    if (Date.now() - started > BUDGET_MS) break;
    try {
      results.push({ email: account.email, ...(await syncMailbox(account)) });
    } catch (err) {
      const message = err instanceof GraphError ? err.message : "The sync failed. It's tried again next time.";
      if (!(err instanceof GraphError)) console.error("[cron microsoft]", account.email, err);
      await db.update(schema.connectedAccounts).set({ lastError: message, lastSyncAt: new Date(), updatedAt: new Date() }).where(eq(schema.connectedAccounts.id, account.id));
      results.push({ email: account.email, error: message });
    }
  }
  return NextResponse.json({ mailboxes: accounts.length, results });
}
