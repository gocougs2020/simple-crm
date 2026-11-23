/** What the billing card gets from the server. Free of server-only imports so the browser can share the types. */

import type { NextCharge } from "./rules";

export type SubStatus = "active" | "past_due" | "unpaid" | "canceled" | "incomplete" | "incomplete_expired" | "trialing" | "paused";

/** One Stripe customer on a client, trimmed to what the page shows (src/lib/stripe/client-billing.ts). */
export type CustomerBilling = {
  account: string;
  accountLabel: string;
  dashboardUrl: string;
  matchedEmail: string | null;
  byHand: boolean;
  /** What they actually paid, less refunds, in the last 30 and 365 days, from the last sync. */
  collectedMonth: number;
  collectedYear: number;
  customer: { id: string; name: string | null; email: string | null; balance: number; currency: string | null; delinquent: boolean; created: number };
  subscriptions: {
    id: string;
    status: SubStatus;
    currency: string;
    started: number;
    cancelAtPeriodEnd: boolean;
    cancelAt: number | null;
    endedAt: number | null;
    trialEnd: number | null;
    periodEnd: number | null;
    collection: "charge_automatically" | "send_invoice";
    daysUntilDue: number | null;
    /** The saved method this subscription charges, when it has its own; otherwise the customer's default. */
    paymentMethod: string | null;
    /** Monthly amount at list price, and what discounts take off it. */
    monthly: number;
    discount: number;
    /** What it bills next and when, inferred from its period and prices (`nextCharge`); null when nothing more is billed. */
    next: NextCharge | null;
    items: { id: string; priceId: string; productId: string; name: string; amount: number | null; quantity: number; currency: string; interval: string | null; intervalCount: number }[];
  }[];
  invoices: { id: string; number: string | null; status: "draft" | "open" | "paid" | "uncollectible" | "void" | null; overdue: boolean; total: number; discount: number; remaining: number; currency: string; created: number; dueDate: number | null; url: string | null; pdf: string | null }[];
  charges: { id: string; amount: number; refunded: boolean; refundedAmount: number; currency: string; status: "succeeded" | "pending" | "failed"; created: number; description: string | null; failure: string | null; receipt: string | null; method: string | null }[];
  /** Null when the key can't read payment methods. */
  paymentMethods: PaymentMethod[] | null;
};

/** A saved card or bank account, with what its face shows. */
export type PaymentMethod = {
  id: string;
  type: string;
  kind: "card" | "bank" | "other";
  isDefault: boolean;
  /** "Visa ···· 4242", for lists and menus. */
  label: string;
  /** Card brand ("visa") or bank name. */
  brand: string | null;
  last4: string | null;
  /** "credit", "debit", "checking", "savings". */
  detail: string | null;
  holder: string | null;
  expires: string | null;
  expired: boolean;
};

/** A price a subscription can be started on or moved to, for the plan pickers. */
export type StripePriceOption = { id: string; productId: string; productName: string; nickname: string | null; unitAmount: number; currency: string; interval: "day" | "week" | "month" | "year"; intervalCount: number };
