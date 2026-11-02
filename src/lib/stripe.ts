import "server-only";

/**
 * Read-only Stripe, for the billing card on current and past clients:
 * subscriptions, invoices, payments and balance, fetched live so they're
 * never stale. Plain REST with a restricted key; nothing here can charge or
 * change anything. Without STRIPE_SECRET_KEY the card explains how to connect.
 */
const key = process.env.STRIPE_SECRET_KEY ?? null;

export function stripeConfigured() {
  return !!key;
}

export class StripeError extends Error {}

async function get<T>(path: string, params: Record<string, string | string[] | number | undefined> = {}): Promise<T> {
  if (!key) throw new StripeError("Stripe isn't connected. Add STRIPE_SECRET_KEY to the environment.");
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) qs.append(k, x);
    else qs.set(k, String(v));
  }
  const res = await fetch(`https://api.stripe.com/v1/${path}${qs.size ? `?${qs}` : ""}`, {
    headers: { Authorization: `Bearer ${key}` },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!res.ok) throw new StripeError(body?.error?.message ?? `Stripe answered ${res.status}.`);
  return body as T;
}

type List<T> = { data: T[]; has_more: boolean };

export type StripeCustomer = { id: string; name: string | null; email: string | null; balance: number; currency: string | null; delinquent: boolean | null; created: number; deleted?: boolean };

export type StripeSubscription = {
  id: string;
  status: "active" | "past_due" | "unpaid" | "canceled" | "incomplete" | "incomplete_expired" | "trialing" | "paused";
  currency: string;
  created: number;
  cancel_at_period_end: boolean;
  cancel_at: number | null;
  canceled_at: number | null;
  ended_at: number | null;
  trial_end: number | null;
  items: { data: { id: string; quantity: number | null; current_period_end?: number; price: { id: string; nickname: string | null; unit_amount: number | null; currency: string; product: string; recurring: { interval: "day" | "week" | "month" | "year"; interval_count: number } | null } }[] };
};

export type StripeInvoice = {
  id: string;
  number: string | null;
  status: "draft" | "open" | "paid" | "uncollectible" | "void" | null;
  amount_due: number;
  amount_paid: number;
  amount_remaining: number;
  total: number;
  currency: string;
  created: number;
  due_date: number | null;
  hosted_invoice_url: string | null;
};

export type StripeCharge = {
  id: string;
  amount: number;
  amount_refunded: number;
  currency: string;
  status: "succeeded" | "pending" | "failed";
  refunded: boolean;
  created: number;
  description: string | null;
  failure_message: string | null;
  receipt_url: string | null;
  payment_method_details: { type: string; card?: { brand: string; last4: string } } | null;
};

export function stripeDashboardUrl(customerId: string) {
  return `https://dashboard.stripe.com/${key?.startsWith("sk_test") || key?.startsWith("rk_test") ? "test/" : ""}customers/${customerId}`;
}

export async function getCustomer(id: string) {
  const c = await get<StripeCustomer>(`customers/${encodeURIComponent(id)}`);
  if (c.deleted) throw new StripeError("That Stripe customer was deleted.");
  return c;
}

/** Customers matching an email or name, for linking a client. */
export async function searchCustomers(q: string) {
  const term = q.trim().replace(/["\\]/g, "");
  if (!term) return [];
  if (/^cus_[A-Za-z0-9]+$/.test(term)) return [await getCustomer(term)];
  if (term.includes("@")) return (await get<List<StripeCustomer>>("customers", { email: term, limit: 10 })).data;
  return (await get<List<StripeCustomer>>("customers/search", { query: `name~"${term}" OR email~"${term}"`, limit: 10 })).data;
}

/** Everything the billing card shows, in parallel. Product names are looked up in one call. */
export async function billingFor(customerId: string) {
  const [customer, subs, invoices, charges] = await Promise.all([
    getCustomer(customerId),
    get<List<StripeSubscription>>("subscriptions", { customer: customerId, status: "all", limit: 10 }),
    get<List<StripeInvoice>>("invoices", { customer: customerId, limit: 12 }),
    get<List<StripeCharge>>("charges", { customer: customerId, limit: 10 }),
  ]);
  const productIds = [...new Set(subs.data.flatMap((s) => s.items.data.map((i) => i.price.product)))];
  const products = productIds.length ? (await get<List<{ id: string; name: string }>>("products", { "ids[]": productIds, limit: 100 })).data : [];
  const productName = new Map(products.map((p) => [p.id, p.name]));
  return {
    customer,
    subscriptions: subs.data.map((s) => ({
      ...s,
      items: s.items.data.map((i) => ({ ...i, name: i.price.nickname ?? productName.get(i.price.product) ?? "Subscription" })),
      periodEnd: s.items.data.map((i) => i.current_period_end).find(Boolean) ?? null,
    })),
    invoices: invoices.data.filter((i) => i.status !== "draft").map((i) => ({ ...i, overdue: i.status === "open" && !!i.due_date && i.due_date * 1000 < Date.now() })),
    charges: charges.data,
  };
}

export type Billing = Awaited<ReturnType<typeof billingFor>>;
