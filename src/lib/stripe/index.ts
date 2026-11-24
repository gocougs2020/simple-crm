import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { parseStripeAccounts, type StripeAccount } from "./accounts";
import type { Form } from "./changes";
import type { StripePriceOption } from "./types";
import { discountShare, invoiceItems, lineProduct, type InvoiceLine } from "./rules";

/**
 * Stripe, for one or more Stripe accounts. Plain REST with a restricted key
 * per account. Almost everything here reads; the few changes (starting,
 * editing and canceling subscriptions, at the bottom) are for admins only
 * (src/actions/billing.ts) and need a key with write access to Subscriptions.
 *
 * Each account is one environment variable: STRIPE_SECRET_KEY_<NAME> (and
 * STRIPE_SECRET_KEY, the account called "default"). The daily sync
 * (src/lib/stripe/sync.ts) copies customers and subscriptions into the
 * database so clients can be matched by email; a client's page reads the
 * detail (invoices, payments, cards) live.
 */
const accounts = parseStripeAccounts(process.env);

/** A local stand-in for Stripe's API, for development and tests only. Refused on Vercel like the other local fallbacks. */
const base = (!process.env.VERCEL && process.env.STRIPE_API_URL) || "https://api.stripe.com";

export type { StripeAccount, StripePriceOption };

/** The connected accounts, without their keys. */
export function stripeAccounts(): { id: string; label: string }[] {
  return accounts.map(({ id, label }) => ({ id, label }));
}

export function stripeConfigured() {
  return accounts.length > 0;
}

export function stripeAccountLabel(id: string) {
  return accounts.find((a) => a.id === id)?.label ?? id;
}

export class StripeError extends Error {}

type Params = Record<string, string | string[] | number | undefined>;

function accountOf(accountId: string) {
  const account = accounts.find((a) => a.id === accountId);
  if (!account) throw new StripeError("That Stripe account isn't connected anymore. Check the STRIPE_SECRET_KEY variables in the environment.");
  return account;
}

async function get<T>(accountId: string, path: string, params: Params = {}): Promise<T> {
  const account = accountOf(accountId);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) qs.append(k, x);
    else qs.set(k, String(v));
  }
  const res = await fetch(`${base}/v1/${path}${qs.size ? `?${qs}` : ""}`, {
    headers: { Authorization: `Bearer ${account.key}` },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!res.ok) throw new StripeError(body?.error?.message ?? `Stripe answered ${res.status}.`);
  return body as T;
}

/** A change. Stripe replays the answer for a repeated idempotency key, so a double click can't start two subscriptions. */
async function send<T>(accountId: string, method: "POST" | "DELETE", path: string, form: Form = {}, idempotencyKey?: string): Promise<T> {
  const account = accountOf(accountId);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) if (v !== undefined) body.set(k, String(v));
  const res = await fetch(`${base}/v1/${path}`, {
    method,
    headers: { Authorization: `Bearer ${account.key}`, "Content-Type": "application/x-www-form-urlencoded", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
    body: body.size ? body : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => null)) as { error?: { message?: string; type?: string } } | null;
  if (res.status === 403 || json?.error?.type === "permission_error")
    throw new StripeError(`Nothing changed: the Stripe key${accounts.length > 1 ? ` for ${account.label}` : ""} can only read billing. Give it write access to Subscriptions in Stripe to make changes from here.`);
  if (!res.ok) throw new StripeError(json?.error?.message ?? `Stripe answered ${res.status}.`);
  return json as T;
}

type List<T> = { data: T[]; has_more: boolean; next_page?: string | null };

/** Every item of a list endpoint, 100 at a time, up to `max`. */
async function listAll<T extends { id: string }>(accountId: string, path: string, params: Params = {}, max = 50_000): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  while (out.length < max) {
    const page = await get<List<T>>(accountId, path, { ...params, limit: 100, starting_after: after });
    out.push(...page.data);
    if (!page.has_more || !page.data.length) break;
    after = page.data.at(-1)!.id;
  }
  return out;
}

export type StripeCustomer = {
  id: string;
  name: string | null;
  email: string | null;
  balance: number;
  currency: string | null;
  delinquent: boolean | null;
  created: number;
  deleted?: boolean;
  invoice_settings?: { default_payment_method: string | null } | null;
};

export type StripeSubscriptionStatus = "active" | "past_due" | "unpaid" | "canceled" | "incomplete" | "incomplete_expired" | "trialing" | "paused";

export type StripePrice = {
  id: string;
  nickname: string | null;
  unit_amount: number | null;
  currency: string;
  product: string;
  recurring: { interval: "day" | "week" | "month" | "year"; interval_count: number; usage_type?: string | null } | null;
};

export type StripeSubscription = {
  id: string;
  customer: string;
  status: StripeSubscriptionStatus;
  currency: string;
  created: number;
  start_date?: number;
  cancel_at_period_end: boolean;
  cancel_at: number | null;
  canceled_at: number | null;
  ended_at: number | null;
  trial_end: number | null;
  current_period_end?: number;
  collection_method?: "charge_automatically" | "send_invoice";
  days_until_due?: number | null;
  default_payment_method?: string | { id: string } | null;
  /** Payment collection paused in Stripe: the subscription stays active, but nothing is collected until `resumes_at` (or until someone resumes it). */
  pause_collection?: { behavior: "keep_as_draft" | "mark_uncollectible" | "void"; resumes_at: number | null } | null;
  /** Expanded where the list asks for it: what was last billed, for discounts. */
  latest_invoice?: string | { id: string; subtotal?: number | null; total?: number | null; total_discount_amounts?: { amount: number }[] | null } | null;
  items: { data: { id: string; quantity: number | null; current_period_end?: number; price: StripePrice }[] };
};


export type StripeInvoice = {
  id: string;
  number: string | null;
  status: "draft" | "open" | "paid" | "uncollectible" | "void" | null;
  amount_due: number;
  amount_paid: number;
  amount_remaining: number;
  total: number;
  subtotal?: number | null;
  total_discount_amounts?: { amount: number }[] | null;
  customer?: string | null;
  currency: string;
  created: number;
  due_date: number | null;
  hosted_invoice_url: string | null;
  invoice_pdf?: string | null;
  description?: string | null;
  /** The first page of its lines (Stripe includes up to 10), for what it was for. */
  lines?: { data: InvoiceLine[]; has_more?: boolean } | null;
};

export type StripeCharge = {
  id: string;
  amount: number;
  amount_refunded: number;
  amount_captured?: number | null;
  /** False while a payment is only authorized: nothing was collected yet. */
  captured?: boolean;
  customer?: string | null;
  currency: string;
  status: "succeeded" | "pending" | "failed";
  refunded: boolean;
  created: number;
  description: string | null;
  failure_message: string | null;
  receipt_url: string | null;
  /** The invoice this payment paid, when it paid one. */
  invoice?: string | { id: string } | null;
  payment_method_details: { type: string; card?: { brand: string; last4: string } } | null;
};

export type StripePaymentMethod = {
  id: string;
  type: string;
  created: number;
  card?: { brand: string; last4: string; exp_month: number; exp_year: number; funding?: string } | null;
  us_bank_account?: { bank_name: string | null; last4: string | null; account_type?: string | null; account_holder_type?: string | null } | null;
  billing_details?: { name: string | null } | null;
};

export function stripeDashboardUrl(accountId: string, customerId: string) {
  const key = accounts.find((a) => a.id === accountId)?.key;
  return `https://dashboard.stripe.com/${key?.startsWith("sk_test") || key?.startsWith("rk_test") ? "test/" : ""}customers/${customerId}`;
}

export async function getCustomer(accountId: string, id: string) {
  const c = await get<StripeCustomer>(accountId, `customers/${encodeURIComponent(id)}`);
  if (c.deleted) throw new StripeError("That Stripe customer was deleted.");
  return c;
}

/** Customers matching an email, a name or an ID, in every connected account, for linking one by hand. An account that fails is left out. */
export async function searchCustomers(q: string) {
  const term = q.trim().replace(/["\\]/g, "");
  if (!term) return [];
  const one = async (accountId: string): Promise<StripeCustomer[]> => {
    if (/^cus_[A-Za-z0-9]+$/.test(term)) return [await getCustomer(accountId, term)];
    if (term.includes("@")) return (await get<List<StripeCustomer>>(accountId, "customers", { email: term, limit: 10 })).data;
    return (await get<List<StripeCustomer>>(accountId, "customers/search", { query: `name~"${term}" OR email~"${term}"`, limit: 10 })).data;
  };
  const found = await Promise.allSettled(accounts.map(async (a) => (await one(a.id)).map((c) => ({ ...c, account: a.id }))));
  if (found.length && found.every((r) => r.status === "rejected")) throw (found[0] as PromiseRejectedResult).reason;
  return found.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

/**
 * The customers in one account with any of these emails. Stripe's search
 * takes 10 emails a query; if the key can't search, it falls back to one
 * lookup per email. Matching is by lowercased email.
 */
export async function customersByEmail(accountId: string, emails: string[]): Promise<StripeCustomer[]> {
  const wanted = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e && !/["\\\s]/.test(e)))];
  const out = new Map<string, StripeCustomer>();
  const keep = (list: StripeCustomer[]) => {
    for (const c of list) if (c.email && wanted.includes(c.email.toLowerCase())) out.set(c.id, c);
  };
  try {
    for (let i = 0; i < wanted.length; i += 10) {
      const query = wanted.slice(i, i + 10).map((e) => `email:"${e}"`).join(" OR ");
      keep((await get<List<StripeCustomer>>(accountId, "customers/search", { query, limit: 100 })).data);
    }
  } catch (err) {
    if (!(err instanceof StripeError)) throw err;
    for (const e of wanted) keep((await get<List<StripeCustomer>>(accountId, "customers", { email: e, limit: 20 })).data);
  }
  return [...out.values()];
}

// ─── Everything in an account, for the sync ──────────────────────────────

export const allCustomers = (accountId: string) => listAll<StripeCustomer>(accountId, "customers");
/** Each subscription comes with its latest invoice, which says what its discounts take off. */
const withInvoice = { status: "all", "expand[]": ["data.latest_invoice"] };
export const allSubscriptions = (accountId: string) => listAll<StripeSubscription>(accountId, "subscriptions", withInvoice);
export const subscriptionsOf = (accountId: string, customerId: string) => listAll<StripeSubscription>(accountId, "subscriptions", { ...withInvoice, customer: customerId }, 100);

/** Payments since a time (unix seconds), for one customer or the whole account: what was actually collected. */
export const chargesSince = (accountId: string, since: number, customerId?: string) => listAll<StripeCharge>(accountId, "charges", { "created[gte]": since, customer: customerId }, 200_000);
/** Invoices made since a time (unix seconds), or ever without one, for the billing activity. Drafts come too; the sync leaves them out. */
export const invoicesSince = (accountId: string, since?: number) => listAll<StripeInvoice>(accountId, "invoices", { "created[gte]": since }, 200_000);
/** One invoice, for one the daily window no longer reaches. */
export const getInvoice = (accountId: string, id: string) => get<StripeInvoice>(accountId, `invoices/${encodeURIComponent(id)}`);
/** Invoices sent and not yet paid, for one customer or the whole account. */
export const openInvoices = (accountId: string, customerId?: string) => listAll<StripeInvoice>(accountId, "invoices", { status: "open", customer: customerId });

/** Product names by id. With `ids`, only those (100 at a time); without, every product in the account. */
export async function productNames(accountId: string, ids?: string[]) {
  const names = new Map<string, string>();
  if (!ids) for (const p of await listAll<{ id: string; name: string }>(accountId, "products")) names.set(p.id, p.name);
  else for (let i = 0; i < ids.length; i += 100) for (const p of (await get<List<{ id: string; name: string }>>(accountId, "products", { "ids[]": ids.slice(i, i + 100), limit: 100 })).data) names.set(p.id, p.name);
  return names;
}

// ─── One customer, live, for the client page ─────────────────────────────

/** How many invoices of a customer the detail view reads. Older ones are a click away in Stripe. */
export const INVOICE_HISTORY = 60;

/** Everything the billing card and its detail view show for one customer, in parallel. Saved cards need the key to read payment methods; without that they're left out. */
export async function billingFor(accountId: string, customerId: string) {
  const [customer, subs, invoices, charges, methods] = await Promise.all([
    getCustomer(accountId, customerId),
    get<List<StripeSubscription>>(accountId, "subscriptions", { customer: customerId, status: "all", limit: 20, "expand[]": ["data.latest_invoice"] }),
    get<List<StripeInvoice>>(accountId, "invoices", { customer: customerId, limit: INVOICE_HISTORY }),
    get<List<StripeCharge>>(accountId, "charges", { customer: customerId, limit: 25 }),
    get<List<StripePaymentMethod>>(accountId, `customers/${encodeURIComponent(customerId)}/payment_methods`, { limit: 20 }).catch(() => null),
  ]);
  // One lookup names the products of both the subscriptions and the invoice lines.
  const productIds = [...subs.data.flatMap((s) => s.items.data.map((i) => i.price.product)), ...invoices.data.flatMap((i) => (i.lines?.data ?? []).map(lineProduct))];
  const names = await productNames(accountId, [...new Set(productIds.filter((id): id is string => !!id))]);
  return {
    account: accountId,
    accountLabel: stripeAccountLabel(accountId),
    dashboardUrl: stripeDashboardUrl(accountId, customerId),
    customer,
    subscriptions: subs.data.map((s) => ({
      ...s,
      items: s.items.data.map((i) => ({ ...i, name: names.get(i.price.product) ?? i.price.nickname ?? "Subscription" })),
      periodEnd: s.current_period_end ?? s.items.data.map((i) => i.current_period_end).find(Boolean) ?? null,
      /** How much of the list price discounts take off, 0 to 1. */
      discountShare: discountShare(typeof s.latest_invoice === "object" ? s.latest_invoice : null),
    })),
    invoices: invoices.data
      .filter((i) => i.status !== "draft")
      .map((i) => ({ ...i, overdue: i.status === "open" && !!i.due_date && i.due_date * 1000 < Date.now(), items: invoiceItems(i.lines?.data ?? [], names), moreItems: !!i.lines?.has_more })),
    charges: charges.data,
    /** Null when the key can't read payment methods. */
    paymentMethods: methods ? methods.data.map((m) => ({ ...m, isDefault: m.id === customer.invoice_settings?.default_payment_method })) : null,
  };
}

export type Billing = Awaited<ReturnType<typeof billingFor>>;

/** The cache tag on one customer's billing: "Check Stripe now" expires it (`updateTag`). */
export const stripeCustomerTag = (accountId: string, customerId: string) => `stripe-customer:${accountId}:${customerId}`;

/**
 * `billingFor`, kept for two minutes per customer: the billing card makes six
 * Stripe requests per customer, and a page is often opened again within
 * minutes. Only Stripe is read in here, never the database. In-memory
 * (`use cache`), so customers' billing details stay out of a shared store.
 * "Check Stripe now" expires the tag, so it always reads live.
 */
export async function cachedBillingFor(accountId: string, customerId: string): Promise<Billing> {
  "use cache";
  cacheTag(stripeCustomerTag(accountId, customerId));
  cacheLife({ stale: 60, revalidate: 120, expire: 120 });
  return billingFor(accountId, customerId);
}

// ─── Changes, for admins ─────────────────────────────────────────────────

const sub = (id: string) => `subscriptions/${encodeURIComponent(id)}`;

export const getSubscription = (accountId: string, id: string) => get<StripeSubscription>(accountId, sub(id));
export const getPrice = (accountId: string, id: string) => get<StripePrice & { active: boolean }>(accountId, `prices/${encodeURIComponent(id)}`);

/**
 * The fixed, recurring prices in an account whose product is still sold, for
 * starting a subscription or moving one to another plan. Usage-based and
 * tiered prices have no single amount and are left out.
 */
export async function recurringPrices(accountId: string): Promise<StripePriceOption[]> {
  type Expanded = Omit<StripePrice, "product"> & { active: boolean; product: string | { id: string; name: string; active: boolean; deleted?: boolean } };
  const list = await listAll<Expanded>(accountId, "prices", { active: "true", type: "recurring", "expand[]": ["data.product"] }, 1000);
  const out: StripePriceOption[] = [];
  for (const p of list) {
    const product = typeof p.product === "object" ? p.product : null;
    if (!product || product.deleted || !product.active || p.unit_amount == null || !p.recurring || p.recurring.usage_type === "metered") continue;
    out.push({ id: p.id, productId: product.id, productName: product.name, nickname: p.nickname, unitAmount: p.unit_amount, currency: p.currency, interval: p.recurring.interval, intervalCount: p.recurring.interval_count || 1 });
  }
  return out.sort((a, b) => a.productName.localeCompare(b.productName) || a.unitAmount - b.unitAmount);
}

export const createSubscription = (accountId: string, form: Form, idempotencyKey: string) => send<StripeSubscription>(accountId, "POST", "subscriptions", form, idempotencyKey);
export const updateSubscription = (accountId: string, id: string, form: Form, idempotencyKey: string) => send<StripeSubscription>(accountId, "POST", sub(id), form, idempotencyKey);

/** Ends a subscription now (Stripe bills nothing more and refunds nothing), or at the end of the period they've paid for. */
export function cancelSubscription(accountId: string, id: string, when: "now" | "period_end", idempotencyKey: string) {
  return when === "now" ? send<StripeSubscription>(accountId, "DELETE", sub(id), {}, idempotencyKey) : send<StripeSubscription>(accountId, "POST", sub(id), { cancel_at_period_end: true }, idempotencyKey);
}

/** Takes back a cancellation that hasn't happened yet. */
export function keepSubscription(accountId: string, s: { id: string; cancel_at_period_end: boolean }, idempotencyKey: string) {
  return send<StripeSubscription>(accountId, "POST", sub(s.id), s.cancel_at_period_end ? { cancel_at_period_end: false } : { cancel_at: "" }, idempotencyKey);
}
