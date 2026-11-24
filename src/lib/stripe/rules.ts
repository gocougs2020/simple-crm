/**
 * How Stripe subscriptions become what the CRM shows on a client: a monthly
 * amount and one billing status. Pure, so they can be tested, and shared by
 * the sync and the billing card.
 */

type Recurring = { interval: "day" | "week" | "month" | "year"; interval_count: number; usage_type?: string | null } | null;

/** How many of this billing period fit in a month. Every 4 weeks is 13 a year. */
export function perMonth(r: Recurring) {
  // A metered price's amount is per unit used, not per period: there's no fixed monthly amount to count.
  if (!r || r.usage_type === "metered") return 0;
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

/** What a subscription bills next, inferred from it rather than asked of Stripe: when, and roughly how much. */
export type NextCharge = {
  /** Unix seconds: the end of the current period, or of the trial. */
  at: number;
  /** In cents, after the discount its latest invoice had; null when every line is usage based. */
  amount: number | null;
  /** Some lines are usage based, so the amount covers only the fixed ones. */
  partial: boolean;
};

/**
 * The next time a subscription bills: when its current period (or trial)
 * ends, for the fixed price lines at the discount its latest invoice had.
 * Null when nothing more is billed: it's paused, ended, unpaid, or set to
 * cancel by then, or its payment collection is paused past then (Stripe
 * keeps such a subscription active). Tax, proration and credits aren't counted, so it's an
 * estimate, not Stripe's upcoming invoice.
 */
export function nextCharge(s: {
  status: string;
  periodEnd: number | null;
  trial_end: number | null;
  cancel_at: number | null;
  cancel_at_period_end: boolean;
  pause_collection?: { resumes_at: number | null } | null;
  discountShare: number;
  items: { quantity: number | null; price: { unit_amount: number | null; recurring: Recurring } }[];
}): NextCharge | null {
  if (!["active", "trialing", "past_due"].includes(s.status)) return null;
  const at = s.status === "trialing" && s.trial_end ? s.trial_end : s.periodEnd;
  if (!at) return null;
  if (s.cancel_at_period_end && (!s.periodEnd || at >= s.periodEnd)) return null;
  if (s.cancel_at && s.cancel_at <= at) return null;
  if (s.pause_collection && (!s.pause_collection.resumes_at || s.pause_collection.resumes_at > at)) return null;
  const fixed = s.items.filter((i) => i.price.unit_amount != null && i.price.recurring?.usage_type !== "metered");
  const partial = fixed.length < s.items.length;
  if (!fixed.length) return { at, amount: null, partial };
  const list = fixed.reduce((sum, i) => sum + (i.price.unit_amount ?? 0) * (i.quantity ?? 1), 0);
  return { at, amount: Math.round(list * (1 - s.discountShare)), partial };
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

const brands: Record<string, string> = { visa: "Visa", mastercard: "Mastercard", amex: "American Express", discover: "Discover", diners: "Diners Club", jcb: "JCB", unionpay: "UnionPay", cartes_bancaires: "Cartes Bancaires", eftpos_au: "eftpos" };
/** A card brand or payment type as people write it: "visa" is Visa, "us_bank_account" is Us bank account. */
export const brandName = (brand: string) => brands[brand] ?? (brand.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) || "Card");

/** One line of a Stripe invoice, as much as `invoiceItems` reads. Older API versions put the product on `price`, newer ones on `pricing.price_details`. */
export type InvoiceLine = {
  description?: string | null;
  quantity?: number | null;
  price?: { product?: string | { id: string } | null } | null;
  pricing?: { price_details?: { product?: string | null } | null } | null;
};

/** The product a line bills, whichever API version Stripe answered in. */
export const lineProduct = (l: InvoiceLine) => l.pricing?.price_details?.product ?? (typeof l.price?.product === "string" ? l.price.product : (l.price?.product?.id ?? null));

/**
 * What an invoice was for, from its lines: each product once, by name
 * ("Pro × 3"), or a one-off line's own description. Proration lines name
 * the same product as the plan they adjust, so they don't add one.
 */
export function invoiceItems(lines: readonly InvoiceLine[], names: ReadonlyMap<string, string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    const product = lineProduct(l);
    const name = product ? names.get(product) : undefined;
    // "1 × Pro (at $50.00 / month)" is how Stripe writes a subscription line: the name is the middle.
    const own = l.description?.trim().replace(/^\d+\s*×\s*/, "").replace(/\s*\(at [^)]*\)$/, "") || null;
    const key = product ?? own;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const label = name ?? own;
    if (!label) continue;
    out.push(name && (l.quantity ?? 1) > 1 ? `${name} × ${l.quantity}` : label);
  }
  return out;
}
