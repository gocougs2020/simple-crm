/**
 * How Stripe subscriptions become what the CRM shows on a client: a monthly
 * amount and one billing status. Pure, so they can be tested, and shared by
 * the sync and the billing card.
 */

type Recurring = { interval: "day" | "week" | "month" | "year"; interval_count: number } | null;

/** How many of this billing period fit in a month. Every 4 weeks is 13 a year. */
export function perMonth(r: Recurring) {
  if (!r) return 0;
  const n = r.interval_count || 1;
  if (r.interval === "month") return 1 / n;
  if (r.interval === "year") return 1 / (12 * n);
  if (r.interval === "week") return 52 / 12 / n;
  return 365 / 12 / n;
}

/** A subscription's price lines as a monthly amount, in cents. List prices: discounts and usage-based prices aren't counted. */
export function monthlyAmount(items: { quantity: number | null; price: { unit_amount: number | null; recurring: Recurring } }[]) {
  return Math.round(items.reduce((sum, i) => sum + (i.price.unit_amount ?? 0) * (i.quantity ?? 1) * perMonth(i.price.recurring), 0));
}

/**
 * How much of a subscription's list price its discounts take off, from 0 to 1,
 * read off its latest invoice: what Stripe actually billed says more than
 * working coupons out by hand, and covers every kind of discount. Zero when
 * there's no invoice yet.
 */
export function discountShare(invoice: { subtotal?: number | null; total_discount_amounts?: { amount: number }[] | null } | null | undefined) {
  if (!invoice?.subtotal || invoice.subtotal <= 0) return 0;
  const off = (invoice.total_discount_amounts ?? []).reduce((sum, d) => sum + d.amount, 0);
  return Math.min(1, Math.max(0, off / invoice.subtotal));
}

/** The monthly amount after discounts. */
export const netMonthly = (monthly: number, share: number) => Math.round(monthly * (1 - share));

/** What a payment brought in: what was captured, less what was refunded. Failed and pending payments bring in nothing. */
export function collected(charge: { status: string; amount: number; amount_captured?: number | null; amount_refunded?: number | null }) {
  if (charge.status !== "succeeded") return 0;
  return Math.max(0, (charge.amount_captured ?? charge.amount) - (charge.amount_refunded ?? 0));
}

/** Subscriptions that are still running, whether or not the last payment went through. */
export const liveStatuses = ["active", "trialing", "past_due", "unpaid", "paused"] as const;

/**
 * One status for a client from all their subscriptions, worst news first:
 * a payment problem outranks a healthy subscription. `customer` means they
 * exist in Stripe with no subscription (one-off invoices only).
 */
export const billingStatuses = ["past_due", "active", "trialing", "paused", "canceled", "customer"] as const;
export type BillingStatus = (typeof billingStatuses)[number];
export const billingStatusLabels: Record<BillingStatus, string> = { past_due: "Past due", active: "Active", trialing: "Trial", paused: "Paused", canceled: "Canceled", customer: "No subscription" };

export function rollUpStatus(statuses: string[]): BillingStatus {
  if (statuses.some((s) => s === "past_due" || s === "unpaid")) return "past_due";
  if (statuses.includes("active")) return "active";
  if (statuses.includes("trialing")) return "trialing";
  if (statuses.includes("paused")) return "paused";
  return statuses.length ? "canceled" : "customer";
}
