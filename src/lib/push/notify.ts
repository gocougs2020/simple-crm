import "server-only";
import { after } from "next/server";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
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
  notifyEach(
    userIds.map((userId) => ({ userId, notices: [notice] })),
    opts,
  );
}

/**
 * One event, told to each teammate once: each of their devices gets the first
 * of their notices it wants. A note on Sam's client that mentions Sam is
 * "mentioned you" on a device that wants mentions, else "added a note on Acme"
 * on one that wants activity on Sam's records, else nothing. The first
 * notice's dedupe key stands for them all, so a retry sends nothing twice. `targets` can be
 * a function, for recipients that take a query to find: it runs after the
 * response too.
 */
type Target = { userId: string | null | undefined; notices: Notice[] };

export function notifyEach(targets: Target[] | (() => Promise<Target[]>), opts: { except?: string | null } = {}) {
  if (Array.isArray(targets) && !targets.some((t) => t.userId && t.userId !== opts.except)) return;
  const work = async () => {
    const seen = new Set<string>();
    const list = (typeof targets === "function" ? await targets() : targets).filter((t): t is { userId: string; notices: Notice[] } => {
      if (!t.userId || t.userId === opts.except || !t.notices.length || seen.has(t.userId)) return false;
      seen.add(t.userId);
      return true;
    });
    await Promise.all(list.map((t) => deliver(t.userId, t.notices)));
  };
  const guarded = () => work().catch((err) => console.error("[push] notify", err));
  try {
    after(guarded);
  } catch {
    // Outside a request (a script): send now.
    void guarded();
  }
}

/**
 * Records the notification and sends it to every device of this teammate that
 * wants it. With several notices (most specific first), each device gets the
 * first one it wants. Returns how many devices got it.
 */
export async function deliver(userId: string, notices: Notice | Notice[]): Promise<number> {
  const list = Array.isArray(notices) ? notices : [notices];
  if (!list.length) return 0;
  const vapid = await getVapid();
  if (!vapid) return 0;
  const db = await getDb();
  const test = list.some((n) => n.kind === "test");
  // Only active teammates: a deactivated one's devices get nothing, though they're kept in case they come back.
  const devices = (
    await db
      .select({ device: subs })
      .from(subs)
      .innerJoin(schema.users, eq(schema.users.id, subs.userId))
      .where(and(eq(subs.userId, userId), isNull(schema.users.deactivatedAt), test ? undefined : or(...list.map((n) => sql`${subs.alerts} @> ${JSON.stringify([n.kind])}::jsonb`))))
  ).map((r) => r.device);
  // Stored before the push-host check existed, or edited by hand: never sent to.
  const valid = devices
    .filter((d) => isPushEndpoint(d.endpoint))
    .map((d) => ({ ...d, notice: list.find((n) => n.kind === "test" || d.alerts.includes(n.kind)) }))
    .filter((d): d is typeof d & { notice: Notice } => !!d.notice);
  if (!valid.length) return 0;

  // One row per event, as the most specific notice any device is getting.
  const first = list.find((n) => valid.some((d) => d.notice === n)) ?? list[0];
  const [row] = await db
    .insert(notifications)
    .values({ userId, kind: first.kind, title: first.title.slice(0, 200), body: first.body?.slice(0, 500) ?? null, url: first.url, dedupeKey: list[0].dedupeKey ?? null })
    .onConflictDoNothing()
    .returning({ id: notifications.id });
  if (!row) return 0;

  const webpush = await loadWebPush();
  const payload = (n: Notice) => JSON.stringify({ title: n.title.slice(0, 200), body: n.body?.slice(0, 500) ?? "", url: n.url, tag: list[0].dedupeKey ?? row.id, kind: n.kind });
  const results = await Promise.allSettled(
    valid.map((d) =>
      webpush.sendNotification({ endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }, payload(d.notice), {
        vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        TTL: TTL_SECONDS,
        urgency: d.notice.kind === "task_due" || d.notice.kind === "meeting_soon" || d.notice.kind === "test" ? "high" : "normal",
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
