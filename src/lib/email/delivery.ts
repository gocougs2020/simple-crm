import "server-only";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { DeliveryStatus } from "@/db/schema";
import { recordEvent } from "@/lib/crm/events";
import { getResend } from "@/lib/email";
import { appConfig } from "@/app.config";
import { addressProblem, deliveryDetail, deliveryRank, engagementEvent, eventStatus, eventTag, movesForward, percent, statusFromLastEvent, type EmailEventData } from "./delivery-status";

/**
 * Delivery reports from Resend's webhook (/api/webhooks/resend). Each report
 * moves the matching outbound_emails row forward (sent → delivered, or
 * bounced, complained…), counts opens and clicks when this deployment tracks
 * them (`email` in app.config.ts), and, for a permanent
 * bounce or a spam complaint, protects the sending address: campaigns stop
 * going to that person, and their history says why.
 *
 * Reports for email this CRM didn't send (a Resend account shared with
 * another app) match no row and are acknowledged and ignored.
 */

const o = schema.outboundEmails;

/** Emails sent with these "type" tags always get a row (direct sends and campaigns). */
const recordedTypes = new Set(["campaign", "direct"]);
/** How long a report may wait for its row before it's let go (the send crashed before saving it). */
const ROW_GRACE_MS = 60 * 60_000;

const rankCase = sql`case ${o.deliveryStatus} ${sql.raw(
  Object.entries(deliveryRank)
    .map(([s, r]) => `when '${s}' then ${r}`)
    .join(" "),
)} else 0 end`;

/**
 * Moves rows for a Resend email id to `status` unless they already hold a
 * later one. One conditional UPDATE, so two reports arriving together can't
 * both pass the check and leave the earlier one last.
 */
export async function applyDeliveryStatus(resendId: string, status: DeliveryStatus, at: Date, detail?: string | null) {
  const db = await getDb();
  return db
    .update(o)
    .set({ deliveryStatus: status, deliveryStatusAt: at, ...(detail ? { deliveryDetail: detail.slice(0, 500) } : {}) })
    .where(and(eq(o.resendId, resendId), sql`${rankCase} <= ${deliveryRank[status]}`))
    .returning({ id: o.id, personId: o.personId, to: o.to });
}

/**
 * Stops campaigns to an address that bounced for good, and unsubscribes
 * anyone who marked an email as spam. Writes a history entry on each person
 * it changes. One-off emails from a record still send, so a teammate can
 * reach someone who fixed their address.
 */
export async function protectAddress(addresses: string[], problem: "bounced" | "complained", at: Date, detail: string | null) {
  const list = [...new Set(addresses.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!list.length) return [];
  const db = await getDb();
  const p = schema.people;
  const matches = inArray(sql`lower(${p.email})`, list);
  const changed = await db
    .update(p)
    .set(problem === "bounced" ? { emailBouncedAt: at } : { unsubscribedAt: at, marketingOptIn: false })
    .where(and(matches, problem === "bounced" ? isNull(p.emailBouncedAt) : isNull(p.unsubscribedAt)))
    .returning({ id: p.id, email: p.email });
  for (const person of changed) {
    await recordEvent({ entityType: "person", entityId: person.id, action: problem === "bounced" ? "email_bounced" : "email_complained", data: { email: person.email, detail }, userId: null });
  }
  return changed;
}

export type EmailEvent = { type: string; created_at?: string; data?: EmailEventData };

export async function recordEmailEvent(event: EmailEvent): Promise<{ handled: boolean; status?: DeliveryStatus; retryLater?: boolean }> {
  // An open or click means it was delivered; one this deployment doesn't track is ignored.
  const engaged = engagementEvent(event.type, appConfig.email);
  const status = engaged ? "delivered" : eventStatus[event.type];
  const d = event.data ?? {};
  const id = d.email_id;
  if (!status || !id) return { handled: false };
  const at = new Date(event.created_at ?? d.created_at ?? Date.now());
  const db = await getDb();

  /**
   * No row for this email. A report can beat the insert that follows the send, so for email we
   * always record, ask Resend to deliver it again rather than lose it. Anything else is someone
   * else's email on a shared account: acknowledge it and touch nothing.
   */
  const noRow = () =>
    recordedTypes.has(eventTag(d.tags, "type") ?? "") && Date.now() - at.getTime() < ROW_GRACE_MS ? { handled: false, status, retryLater: true } : { handled: false };

  if (engaged) {
    const counted = await db
      .update(o)
      .set(
        engaged === "opened"
          ? { openCount: sql`${o.openCount} + 1`, firstOpenedAt: sql`coalesce(${o.firstOpenedAt}, ${at})` }
          : { clickCount: sql`${o.clickCount} + 1`, firstClickedAt: sql`coalesce(${o.firstClickedAt}, ${at})` },
      )
      .where(eq(o.resendId, id))
      .returning({ id: o.id });
    if (!counted.length) return noRow();
  }

  const updated = await applyDeliveryStatus(id, status, at, deliveryDetail(status, d));
  if (!updated.length) {
    const [exists] = await db.select({ id: o.id }).from(o).where(eq(o.resendId, id)).limit(1);
    if (!exists) return noRow();
  }

  const problem = addressProblem(status, d);
  // Only for email this CRM sent: the row exists, so the address is one of ours to protect.
  if (problem) await protectAddress(d.to ?? [], problem, at, deliveryDetail(status, d));
  return { handled: true, status };
}

// ─── Reports ─────────────────────────────────────────────────────────────

export type CampaignDelivery = {
  /** Emails handed to Resend. */
  sent: number;
  /** Reached the inbox (spam complaints included: those were delivered too). */
  delivered: number;
  /** Bounced, failed, or skipped because the address was suppressed. */
  notDelivered: number;
  complained: number;
  /** Recipients who opened or clicked, when tracked (`appConfig.email`). */
  opened: number;
  clicked: number;
  /** No final report yet. */
  pending: number;
  /** Whether any report has come in. */
  reported: boolean;
  deliveryRate: number;
  /** Shares of delivered emails, 0–100. */
  openRate: number;
  clickRate: number;
};

/** Delivery counts for campaigns, keyed by campaign id. */
export async function campaignDelivery(campaignIds: string[]): Promise<Map<string, CampaignDelivery>> {
  const out = new Map<string, CampaignDelivery>();
  if (!campaignIds.length) return out;
  const db = await getDb();
  const rows = await db
    .select({
      campaignId: sql<string>`${o.campaignId}`,
      sent: sql<number>`count(*)::int`,
      delivered: sql<number>`(count(*) filter (where ${o.deliveryStatus} in ('delivered', 'complained')))::int`,
      notDelivered: sql<number>`(count(*) filter (where ${o.deliveryStatus} in ('bounced', 'failed', 'suppressed')))::int`,
      complained: sql<number>`(count(*) filter (where ${o.deliveryStatus} = 'complained'))::int`,
      opened: sql<number>`(count(*) filter (where ${o.firstOpenedAt} is not null))::int`,
      clicked: sql<number>`(count(*) filter (where ${o.firstClickedAt} is not null))::int`,
      reported: sql<number>`(count(*) filter (where ${o.deliveryStatus} is not null))::int`,
    })
    .from(o)
    .where(inArray(o.campaignId, campaignIds))
    .groupBy(o.campaignId);
  for (const r of rows)
    out.set(r.campaignId, {
      ...r,
      pending: r.sent - r.delivered - r.notDelivered,
      reported: r.reported > 0,
      deliveryRate: percent(r.delivered, r.sent),
      openRate: percent(r.opened, r.delivered),
      clickRate: percent(r.clicked, r.delivered),
    });
  return out;
}

export const recipientFilters = ["all", "delivered", "opened", "clicked", "problems", "pending"] as const;
export type RecipientFilter = (typeof recipientFilters)[number];

const RECIPIENT_PAGE = 100;

/** Everyone a campaign went to, with each email's latest status, 100 at a time, optionally narrowed to one group. */
export async function campaignRecipients(campaignId: string, filter: RecipientFilter = "all", page = 0) {
  const db = await getDb();
  const where = and(
    eq(o.campaignId, campaignId),
    filter === "delivered"
      ? inArray(o.deliveryStatus, ["delivered", "complained"])
      : filter === "opened"
        ? isNotNull(o.firstOpenedAt)
        : filter === "clicked"
          ? isNotNull(o.firstClickedAt)
          : filter === "problems"
            ? inArray(o.deliveryStatus, ["bounced", "failed", "suppressed", "complained"])
            : filter === "pending"
              ? sql`(${o.deliveryStatus} is null or ${o.deliveryStatus} in ('sent', 'delayed'))`
              : undefined,
  );
  const p = schema.people;
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: o.id,
        personId: o.personId,
        name: sql<string | null>`case when ${p.id} is null then null else ${p.firstName} || coalesce(' ' || ${p.lastName}, '') end`,
        to: o.to,
        status: o.deliveryStatus,
        statusAt: o.deliveryStatusAt,
        detail: o.deliveryDetail,
        openedAt: o.firstOpenedAt,
        clickedAt: o.firstClickedAt,
      })
      .from(o)
      .leftJoin(p, eq(p.id, o.personId))
      .where(where)
      .orderBy(o.to)
      .limit(RECIPIENT_PAGE)
      .offset(Math.max(0, page) * RECIPIENT_PAGE),
    db.select({ total: sql<number>`count(*)::int` }).from(o).where(where),
  ]);
  return { rows, total, pageSize: RECIPIENT_PAGE };
}

// ─── The safety net ──────────────────────────────────────────────────────

const SETTLE_MS = 20 * 60_000;
const GIVE_UP_MS = 7 * 24 * 60 * 60_000;
const RECHECK_MS = 60 * 60_000;
/** Resend allows a few requests a second per team, shared with everything else on the account; stay well under it. */
const GAP_MS = 600;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A report can go missing (the webhook was off or down longer than Resend
 * retries), which would leave an email "sent" forever and a campaign's
 * numbers wrong. Hourly, emails with no final status after 20 minutes are
 * looked up in Resend directly and brought up to date. Each is checked at
 * most once an hour, for a week.
 */
export async function reconcileDeliveryStatuses({ limit = 150, budgetMs = 240_000 } = {}) {
  const resend = getResend();
  if (!resend) return { checked: 0, updated: 0, skipped: "RESEND_API_KEY isn't set" };
  const db = await getDb();
  const now = Date.now();
  const stale = await db
    .select({ id: o.id, resendId: o.resendId, status: o.deliveryStatus })
    .from(o)
    .where(
      and(
        // Written out so it matches outbound_emails_awaiting_idx's predicate.
        sql`${o.resendId} is not null and (${o.deliveryStatus} is null or ${o.deliveryStatus} in ('sent', 'delayed'))`,
        lte(o.createdAt, new Date(now - SETTLE_MS)),
        gte(o.createdAt, new Date(now - GIVE_UP_MS)),
        or(isNull(o.statusCheckedAt), lte(o.statusCheckedAt, new Date(now - RECHECK_MS))),
      ),
    )
    .orderBy(asc(sql`coalesce(${o.statusCheckedAt}, 'epoch'::timestamptz)`), asc(o.createdAt))
    .limit(limit);

  let checked = 0;
  let updated = 0;
  const errors: string[] = [];
  for (const row of stale) {
    if (Date.now() - now > budgetMs) break;
    if (checked) await sleep(GAP_MS);
    checked++;
    const { data, error } = await resend.emails.get(row.resendId!);
    await db.update(o).set({ statusCheckedAt: new Date() }).where(eq(o.id, row.id));
    if (error) {
      errors.push(error.message);
      // A run of errors usually means a rate limit or an outage: stop and try again next hour.
      if (errors.length >= 5) break;
      continue;
    }
    const status = statusFromLastEvent(data?.last_event);
    if (!status || status === row.status || !movesForward(row.status, status)) continue;
    const at = new Date();
    const changed = await applyDeliveryStatus(row.resendId!, status, at, status === "failed" && data?.last_event === "canceled" ? "The send was canceled in Resend." : null);
    if (!changed.length) continue;
    updated++;
    // Whether a bounce was permanent isn't in this response, so bounces are left to the webhook.
    if (status === "complained") await protectAddress(data?.to ?? [], "complained", at, null);
  }
  return { checked, updated, waiting: stale.length - checked, ...(errors.length ? { errors: [...new Set(errors)] } : {}) };
}
