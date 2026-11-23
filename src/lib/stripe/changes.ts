/**
 * How a change to a subscription made in the CRM becomes a Stripe request.
 * Pure, so the forms can be tested and the browser can share the wording.
 * The requests themselves are in src/lib/stripe/index.ts; the admin-only
 * actions that send them are in src/actions/billing.ts.
 */

/** Form fields, already flattened the way Stripe reads them ("items[0][price]"). An empty string unsets a field. */
export type Form = Record<string, string | number | boolean | undefined>;

export type Interval = "day" | "week" | "month" | "year";

/** One line of a subscription: an existing price, or a different amount on the same product and billing period. */
export type Line = {
  /** The subscription item (si_…) being changed. Absent on a new subscription. */
  id?: string;
  price: string;
  /** Set when they pay a different amount than the price's: Stripe makes a one-off price for it. */
  custom?: { product: string; currency: string; unitAmount: number; interval: Interval; intervalCount: number };
  quantity: number;
};

export type Collection = "charge_automatically" | "send_invoice";
export type Proration = "create_prorations" | "always_invoice" | "none";

export const prorationLabels: Record<Proration, { label: string; hint: string }> = {
  create_prorations: { label: "Prorate on the next invoice", hint: "Stripe works out the difference for the rest of this period and adds it to their next invoice." },
  always_invoice: { label: "Prorate and bill the difference now", hint: "Stripe works out the difference for the rest of this period and invoices it straight away." },
  none: { label: "No proration", hint: "Nothing changes for this period. The new amount starts at the next renewal." },
};

/**
 * Moving to a different billing period (monthly to annual) starts a new period
 * today, and Stripe bills the new amount straight away whatever the proration:
 * the only choice left is whether the unused part of this period is credited.
 */
export const periodChangeLabels: Partial<Record<Proration, { label: string; hint: string }>> = {
  always_invoice: { label: "Credit the unused part of this period", hint: "Stripe bills the new amount today and takes what's left of the current period off that invoice." },
  none: { label: "No credit", hint: "Stripe bills the full new amount today, with nothing taken off for the current period." },
};

function lineForm(lines: Line[]): Form {
  const form: Form = {};
  lines.forEach((l, i) => {
    const k = `items[${i}]`;
    if (l.id) form[`${k}[id]`] = l.id;
    if (l.custom) {
      form[`${k}[price_data][currency]`] = l.custom.currency;
      form[`${k}[price_data][product]`] = l.custom.product;
      form[`${k}[price_data][unit_amount]`] = l.custom.unitAmount;
      form[`${k}[price_data][recurring][interval]`] = l.custom.interval;
      form[`${k}[price_data][recurring][interval_count]`] = l.custom.intervalCount;
    } else form[`${k}[price]`] = l.price;
    form[`${k}[quantity]`] = l.quantity;
  });
  return form;
}

function paymentForm(p: { collection: Collection; daysUntilDue?: number | null; paymentMethod?: string | null }): Form {
  return {
    collection_method: p.collection,
    // Stripe refuses days_until_due on a subscription it charges by itself.
    days_until_due: p.collection === "send_invoice" ? (p.daysUntilDue ?? 30) : undefined,
    default_payment_method: p.collection === "charge_automatically" ? (p.paymentMethod ?? undefined) : undefined,
  };
}

/**
 * A new subscription. One Stripe charges by itself fails outright when the
 * first payment doesn't go through (`error_if_incomplete`), instead of
 * leaving an incomplete subscription behind: the admin sees why straight away.
 */
export function newSubscriptionForm(input: { customer: string; lines: Line[]; collection: Collection; daysUntilDue?: number | null; paymentMethod?: string | null; trialDays?: number | null }): Form {
  return {
    customer: input.customer,
    ...lineForm(input.lines),
    ...paymentForm(input),
    trial_period_days: input.trialDays || undefined,
    payment_behavior: input.collection === "charge_automatically" && !input.trialDays ? "error_if_incomplete" : undefined,
  };
}

/** A change to a running subscription. Only the lines that changed are sent, so a payment-only edit prorates nothing. */
export function changeSubscriptionForm(input: { lines: Line[]; proration: Proration; collection: Collection; daysUntilDue?: number | null; paymentMethod?: string | null }): Form {
  return {
    ...lineForm(input.lines),
    ...paymentForm(input),
    // Stripe expects an empty string to clear the saved method; "default" here means the customer's own default.
    ...(input.collection === "charge_automatically" && !input.paymentMethod ? { default_payment_method: "" } : {}),
    proration_behavior: input.lines.length ? input.proration : undefined,
  };
}

/** "/month", "/3 months". */
export function per(interval: string | null, count = 1) {
  if (!interval) return "";
  return `/${count > 1 ? `${count} ` : ""}${interval}${count > 1 ? "s" : ""}`;
}

/** Dollars typed into a field as cents; null when it isn't an amount. */
export function toCents(typed: string) {
  const v = typed.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(v)) return null;
  return Math.round(Number(v) * 100);
}
