/** What the billing card gets from the server. Free of server-only imports so the browser can share the types. */

export type SubStatus = "active" | "past_due" | "unpaid" | "canceled" | "incomplete" | "incomplete_expired" | "trialing" | "paused";

/** One Stripe customer on a client, trimmed to what the page shows (src/lib/stripe/client-billing.ts). */
export type CustomerBilling = {
  account: string;
  accountLabel: string;
  dashboardUrl: string;
  matchedEmail: string | null;
  byHand: boolean;
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
    monthly: number;
    items: { name: string; amount: number | null; quantity: number; currency: string; interval: string | null; intervalCount: number }[];
  }[];
  invoices: { id: string; number: string | null; status: "draft" | "open" | "paid" | "uncollectible" | "void" | null; overdue: boolean; total: number; remaining: number; currency: string; created: number; dueDate: number | null; url: string | null; pdf: string | null }[];
  charges: { id: string; amount: number; refunded: boolean; currency: string; status: "succeeded" | "pending" | "failed"; created: number; description: string | null; failure: string | null; receipt: string | null; method: string | null }[];
  /** Null when the key can't read payment methods. */
  paymentMethods: { id: string; type: string; isDefault: boolean; label: string; expires: string | null; expired: boolean }[] | null;
};
