import "server-only";
import { after } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { NotificationKind } from "@/lib/constants";
import { isPushEndpoint } from "./device";
import { getVapid, loadWebPush } from "./vapid";

/**
 * Sends push notifications to a teammate's devices. Everything here runs after
 * the response (or the cron's work), so a slow push service never slows the
 * change that caused it, and a failure never undoes it.
 */

export type Notice = {
  kind: NotificationKind | "test";
  title: string;
  body?: string | null;
  /** A path on this site; tapping the notification opens it. */
  url: string;
  /** Sending twice with the same key does nothing the second time. */
  dedupeKey?: string;
};

const { pushSubscriptions: subs, notifications } = schema;

/** Gone: the browser unsubscribed or the app was uninstalled. Delete the device. */
const GONE = new Set([404, 410]);
/** A device that fails this many times in a row (outside "gone") is dropped. */
const MAX_FAILURES = 5;
/** Notifications go stale: a "due now" an hour late is noise. Push services drop them after this. */
const TTL_SECONDS = 6 * 3600;

/** Queues a notification for each teammate, after the current request. Nobody is notified about their own change. */
export function notify(userIds: (string | null | undefined)[], notice: Notice, opts: { except?: string | null } = {}) {
  const ids = [...new Set(userIds.filter((id): id is string => !!id && id !== opts.except))];
  if (!ids.length) return;
  const work = () => Promise.all(ids.map((id) => deliver(id, notice))).catch((err) => console.error("[push] notify", err));
  try {
    after(work);
  } catch {
    // Outside a request (a script): send now.
    void work();
  }
}

/** Records the notification and sends it to every device of this teammate that wants this kind. Returns how many devices got it. */
export async function deliver(userId: string, notice: Notice): Promise<number> {
  const vapid = await getVapid();
  if (!vapid) return 0;
  const db = await getDb();
  const devices = await db
    .select()
    .from(subs)
    .where(and(eq(subs.userId, userId), notice.kind === "test" ? undefined : sql`${subs.alerts} @> ${JSON.stringify([notice.kind])}::jsonb`));
  // Stored before the push-host check existed, or edited by hand: never sent to.
  const valid = devices.filter((d) => isPushEndpoint(d.endpoint));
  if (!valid.length) return 0;

  const [row] = await db
    .insert(notifications)
    .values({ userId, kind: notice.kind, title: notice.title.slice(0, 200), body: notice.body?.slice(0, 500) ?? null, url: notice.url, dedupeKey: notice.dedupeKey ?? null })
    .onConflictDoNothing()
    .returning({ id: notifications.id });
  if (!row) return 0;

  const webpush = await loadWebPush();
  const payload = JSON.stringify({ title: notice.title.slice(0, 200), body: notice.body?.slice(0, 500) ?? "", url: notice.url, tag: notice.dedupeKey ?? row.id, kind: notice.kind });
  const results = await Promise.allSettled(
    valid.map((d) =>
      webpush.sendNotification({ endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }, payload, {
        vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        TTL: TTL_SECONDS,
        urgency: notice.kind === "task_due" || notice.kind === "test" ? "high" : "normal",
        timeout: 10_000,
      }),
    ),
  );

  const ok: string[] = [];
  const gone: string[] = [];
  const failed: string[] = [];
  results.forEach((r, i) => {
    const id = valid[i].id;
    if (r.status === "fulfilled") ok.push(id);
    else if (GONE.has((r.reason as { statusCode?: number })?.statusCode ?? 0)) gone.push(id);
    else {
      failed.push(id);
      console.error("[push] send", (r.reason as Error)?.message ?? r.reason);
    }
  });
  if (ok.length) await db.update(subs).set({ lastSentAt: new Date(), failures: 0 }).where(inArray(subs.id, ok));
  if (gone.length) await db.delete(subs).where(inArray(subs.id, gone));
  if (failed.length) {
    await db.update(subs).set({ failures: sql`${subs.failures} + 1` }).where(inArray(subs.id, failed));
    await db.delete(subs).where(and(inArray(subs.id, failed), sql`${subs.failures} >= ${MAX_FAILURES}`));
  }
  await db.update(notifications).set({ delivered: ok.length }).where(eq(notifications.id, row.id));
  return ok.length;
}
