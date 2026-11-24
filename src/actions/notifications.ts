"use server";

import { headers } from "next/headers";
import { refresh } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { run, type Result } from "@/lib/action";
import { ActionError, actionUser } from "@/lib/auth";
import { defaultNotificationKinds, emailDigestKinds, notificationKinds } from "@/lib/constants";
import { sendAgenda } from "@/lib/notifications/agenda";
import { rateLimit } from "@/lib/rate-limit";
import { deviceLabel, isPushEndpoint } from "@/lib/push/device";
import { deliver } from "@/lib/push/notify";
import { getVapid } from "@/lib/push/vapid";

/**
 * A teammate's devices for push notifications. Every device belongs to one
 * teammate and only they can change it. Signing in as someone else on the
 * same browser moves that browser to them.
 */

const { pushSubscriptions: subs } = schema;
const MAX_DEVICES = 20;

const subscription = z.object({
  endpoint: z.url().max(1000).refine(isPushEndpoint, "This browser's push service isn't supported. Try Chrome, Edge, Firefox or Safari."),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});
const alerts = z.array(z.enum(notificationKinds)).max(notificationKinds.length);
const deviceId = z.uuid("That device was removed.");

export async function subscribeDevice(input: z.input<typeof subscription>, opts: { standalone?: boolean } = {}): Promise<Result<{ id: string }>> {
  return run(async () => {
    const user = await actionUser();
    if (!(await getVapid())) throw new ActionError("Push notifications aren't set up on this deployment. An admin can add VAPID keys (docs/DEPLOYING.md).");
    const data = subscription.parse(input);
    const db = await getDb();
    const mine = await db.select({ id: subs.id, endpoint: subs.endpoint }).from(subs).where(eq(subs.userId, user.id));
    if (mine.length >= MAX_DEVICES && !mine.some((d) => d.endpoint === data.endpoint)) throw new ActionError(`You can get notifications on up to ${MAX_DEVICES} devices. Remove one you no longer use first.`);
    const label = deviceLabel((await headers()).get("user-agent"), !!opts.standalone);
    const [row] = await db
      .insert(subs)
      .values({ userId: user.id, endpoint: data.endpoint, p256dh: data.keys.p256dh, auth: data.keys.auth, label, alerts: defaultNotificationKinds })
      // The same browser again (new keys, or someone else signed in on it): it's this teammate's now.
      .onConflictDoUpdate({
        target: subs.endpoint,
        set: {
          // Someone else signed in on this browser: their alert choices don't carry over.
          alerts: sql`case when ${subs.userId} = ${user.id} then ${subs.alerts} else ${JSON.stringify(defaultNotificationKinds)}::jsonb end`,
          userId: user.id,
          p256dh: data.keys.p256dh,
          auth: data.keys.auth,
          label,
          failures: 0,
        },
      })
      .returning({ id: subs.id });
    refresh();
    return row;
  });
}

export async function setDeviceAlerts(id: string, kinds: string[]): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const db = await getDb();
    const [row] = await db
      .update(subs)
      .set({ alerts: alerts.parse(kinds) })
      .where(and(eq(subs.id, deviceId.parse(id)), eq(subs.userId, user.id)))
      .returning({ id: subs.id });
    if (!row) throw new ActionError("That device was removed. Turn notifications on again on it.");
    refresh();
  });
}

export async function removeDevice(id: string): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const db = await getDb();
    await db.delete(subs).where(and(eq(subs.id, deviceId.parse(id)), eq(subs.userId, user.id)));
    refresh();
  });
}

/** Sends a test to every device of the teammate, so they can check notifications actually arrive. */
export async function sendTestNotification(): Promise<Result<{ delivered: number }>> {
  return run(async () => {
    const user = await actionUser();
    const db = await getDb();
    const devices = await db.select({ id: subs.id }).from(subs).where(eq(subs.userId, user.id));
    if (!devices.length) throw new ActionError("Turn on notifications on a device first.");
    const delivered = await deliver(user.id, { kind: "test", title: "Notifications are on", body: "This is how alerts from the CRM will look on this device.", url: "/settings/notifications", dedupeKey: `test:${Date.now()}` });
    if (!delivered) throw new ActionError("The test didn't reach any device. Turn notifications off and on again on this device.");
    refresh();
    return { delivered };
  });
}

const digests = z.object({ daily: z.boolean(), weekly: z.boolean() });

/** Turns the daily and weekly agenda emails on or off for the signed-in teammate. */
export async function setEmailDigests(input: z.input<typeof digests>): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const data = digests.parse(input);
    const db = await getDb();
    // Merged in the database, so a view preference saved at the same moment isn't lost.
    await db
      .update(schema.users)
      .set({ prefs: sql`coalesce(${schema.users.prefs}, '{}'::jsonb) || ${JSON.stringify({ emailDigests: data })}::jsonb` })
      .where(eq(schema.users.id, user.id));
    refresh();
  });
}

const mentionEmails = z.object({ note: z.boolean(), chat: z.boolean() });

/** Turns the emails sent when a teammate mentions them in a note or the team chat on or off. */
export async function setMentionEmails(input: z.input<typeof mentionEmails>): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const data = mentionEmails.parse(input);
    const db = await getDb();
    // Merged in the database, so a view preference saved at the same moment isn't lost.
    await db
      .update(schema.users)
      .set({ prefs: sql`coalesce(${schema.users.prefs}, '{}'::jsonb) || ${JSON.stringify({ emailMentions: data })}::jsonb` })
      .where(eq(schema.users.id, user.id));
    refresh();
  });
}

/** Sends this morning's agenda now, so a teammate can see what it looks like. */
export async function sendAgendaPreview(kind: string): Promise<Result<{ to: string }>> {
  return run(async () => {
    const user = await actionUser();
    const which = z.enum(emailDigestKinds).parse(kind);
    if ((await rateLimit("agenda-preview", user.id, { limit: 10, windowMs: 3600_000 })).limited) throw new ActionError("That's a lot of previews. Try again in an hour.");
    await sendAgenda(user, which, new Date(), { preview: true });
    return { to: user.email };
  });
}
