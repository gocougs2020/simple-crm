import "server-only";
import { cachedBillingFor, type Billing } from "@/lib/stripe";
import { brandName, monthlyAmount, netMonthly, nextCharge } from "./rules";
import { customersOfClient, syncClient } from "./sync";
import type { CustomerBilling } from "./types";

/** A client whose Stripe data is older than this is looked up again when its page opens. The daily sync normally keeps it fresher. */
const STALE_MS = 26 * 60 * 60 * 1000;
/** At most this many customers are read live for one client. */
const MAX_CUSTOMERS = 8;

/** Only what the page shows goes to the browser: Stripe's objects are many times larger. */
function slim(b: Billing, c: { matchedEmail: string | null; byHand: boolean; collectedMonth: number; collectedYear: number }): CustomerBilling {
  return {
    account: b.account,
    accountLabel: b.accountLabel,
    dashboardUrl: b.dashboardUrl,
    matchedEmail: c.matchedEmail,
    byHand: c.byHand,
    collectedMonth: c.collectedMonth,
    collectedYear: c.collectedYear,
    customer: { id: b.customer.id, name: b.customer.name, email: b.customer.email, balance: b.customer.balance, currency: b.customer.currency, delinquent: !!b.customer.delinquent, created: b.customer.created },
    subscriptions: b.subscriptions.map((s) => ({
      id: s.id,
      status: s.status,
      currency: s.currency,
      started: s.start_date ?? s.created,
      cancelAtPeriodEnd: s.cancel_at_period_end,
      cancelAt: s.cancel_at,
      endedAt: s.ended_at,
      trialEnd: s.trial_end,
      periodEnd: s.periodEnd,
      collection: s.collection_method ?? "charge_automatically",
      daysUntilDue: s.days_until_due ?? null,
      paymentMethod: typeof s.default_payment_method === "object" ? (s.default_payment_method?.id ?? null) : (s.default_payment_method ?? null),
      monthly: monthlyAmount(s.items),
      discount: monthlyAmount(s.items) - netMonthly(monthlyAmount(s.items), s.discountShare),
      next: nextCharge(s),
      items: s.items.map((i) => ({ id: i.id, priceId: i.price.id, productId: i.price.product, name: i.name, amount: i.price.unit_amount, quantity: i.quantity ?? 1, currency: i.price.currency, interval: i.price.recurring?.interval ?? null, intervalCount: i.price.recurring?.interval_count ?? 1 })),
    })),
    invoices: b.invoices.map((i) => ({ id: i.id, number: i.number, status: i.status, overdue: i.overdue, total: i.total, discount: (i.total_discount_amounts ?? []).reduce((sum, d) => sum + d.amount, 0), remaining: i.amount_remaining, currency: i.currency, created: i.created, dueDate: i.due_date, url: i.hosted_invoice_url, pdf: i.invoice_pdf ?? null, items: i.items, moreItems: i.moreItems, memo: i.description?.trim() || null })),
    charges: b.charges.map((c) => ({
      id: c.id,
      amount: c.amount,
      refunded: c.refunded,
      refundedAmount: c.amount_refunded ?? 0,
      currency: c.currency,
      status: c.status,
      created: c.created,
      description: c.description,
      invoice: typeof c.invoice === "string" ? c.invoice : (c.invoice?.id ?? null),
      failure: c.failure_message,
      receipt: c.receipt_url,
      method: c.payment_method_details?.card
        ? `${brandName(c.payment_method_details.card.brand)} ···· ${c.payment_method_details.card.last4}`
        : c.payment_method_details?.type === "us_bank_account"
          ? "Bank account"
          : c.payment_method_details?.type
            ? brandName(c.payment_method_details.type)
            : null,
    })),
    paymentMethods: b.paymentMethods
      ? b.paymentMethods.map((m) => ({
          id: m.id,
          type: m.type,
          kind: m.card ? "card" : m.us_bank_account ? "bank" : "other",
          isDefault: m.isDefault,
          label: m.card ? `${brandName(m.card.brand)} ···· ${m.card.last4}` : m.us_bank_account ? `${m.us_bank_account.bank_name ?? "Bank account"} ···· ${m.us_bank_account.last4 ?? ""}` : brandName(m.type),
          brand: m.card?.brand ?? m.us_bank_account?.bank_name ?? null,
          last4: m.card?.last4 ?? m.us_bank_account?.last4 ?? null,
          detail: m.card?.funding ?? m.us_bank_account?.account_type ?? null,
          holder: m.billing_details?.name ?? b.customer.name ?? null,
          expires: m.card ? `${String(m.card.exp_month).padStart(2, "0")}/${String(m.card.exp_year).slice(-2)}` : null,
          expired: m.card ? new Date(m.card.exp_year, m.card.exp_month, 1).getTime() < Date.now() : false,
        }))
      : null,
  };
}

/**
 * Everything the billing card shows for one client: its matched customers,
 * each read live from Stripe. A client the daily sync hasn't reached (or
 * reached too long ago) is looked up first. A customer Stripe doesn't answer
 * for is counted in `failed`, not thrown.
 */
export async function clientBilling(clientId: string, syncedAt: Date | null) {
  // First view since Stripe was connected, or the daily sync hasn't reached this client: ask Stripe now.
  if (!syncedAt || Date.now() - syncedAt.getTime() > STALE_MS) await syncClient(clientId).catch((err) => console.warn("[stripe] on open", (err as Error).message));
  const matched = await customersOfClient(clientId);
  const results = await Promise.allSettled(matched.slice(0, MAX_CUSTOMERS).map(async (c) => slim(await cachedBillingFor(c.account, c.customerId), c)));
  const customers = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  return { customers, failed: results.length - customers.length, more: Math.max(0, matched.length - MAX_CUSTOMERS) };
}
