/**
 * Billing activity: every invoice and payment in the connected Stripe
 * accounts, as the daily sync copies them into `stripe_activity` for the
 * Billing page. Pure and free of server-only imports, so the rules can be
 * tested and the browser can share the labels.
 */

import type { Tone } from "@/components/ui/badge";
import { brandName } from "./rules";

export type ActivityKind = "invoice" | "payment";

/** One row of `stripe_activity`, as the sync writes it. */
export type ActivityRecord = {
  account: string;
  id: string;
  kind: ActivityKind;
  customerId: string | null;
  /** Stripe's own status: an invoice's open/paid/void/uncollectible, a payment's succeeded/pending/failed, or "uncaptured" for a payment only authorized so far. */
  status: string;
  /** An invoice's total, or what a payment collected (what was authorized, for one not captured yet), in cents. */
  amount: number;
  /** Refunded off a payment. */
  refunded: number;
  /** Left to pay on an invoice. */
  remaining: number;
  currency: string;
  createdAt: Date;
  dueAt: Date | null;
  number: string | null;
  description: string | null;
  /** "Visa ···· 4242", for payments. */
  method: string | null;
  failure: string | null;
  /** The hosted invoice page or the payment's receipt. */
  url: string | null;
  pdf: string | null;
  /** The invoice a payment paid, when it paid one. */
  invoiceId: string | null;
};

type InvoiceIn = {
  id: string;
  number: string | null;
  status: string | null;
  total: number;
  amount_remaining: number;
  customer?: string | null;
  currency: string;
  created: number;
  due_date: number | null;
  hosted_invoice_url: string | null;
  invoice_pdf?: string | null;
  description?: string | null;
  lines?: { data?: { description?: string | null }[] } | null;
};

type ChargeIn = {
  id: string;
  amount: number;
  amount_captured?: number | null;
  captured?: boolean;
  amount_refunded: number;
  customer?: string | null;
  currency: string;
  status: string;
  created: number;
  description: string | null;
  failure_message: string | null;
  receipt_url: string | null;
  invoice?: string | { id: string } | null;
  payment_method_details: { type: string; card?: { brand: string; last4: string } } | null;
};

const at = (unix: number | null | undefined) => (unix ? new Date(unix * 1000) : null);

/** "Visa ···· 4242", "Bank account", or the payment type as people write it. */
export function methodLabel(d: ChargeIn["payment_method_details"]) {
  if (d?.card) return `${brandName(d.card.brand)} ···· ${d.card.last4}`;
  if (d?.type === "us_bank_account") return "Bank account";
  return d?.type ? brandName(d.type) : null;
}

/** An invoice as a row. Drafts aren't activity yet: nothing was sent. */
export function invoiceActivity(account: string, i: InvoiceIn): ActivityRecord | null {
  if (!i.status || i.status === "draft") return null;
  return {
    account,
    id: i.id,
    kind: "invoice",
    customerId: i.customer ?? null,
    status: i.status,
    amount: i.total,
    refunded: 0,
    remaining: i.status === "open" ? i.amount_remaining : 0,
    currency: i.currency,
    createdAt: at(i.created)!,
    dueAt: at(i.due_date),
    number: i.number,
    description: i.description || i.lines?.data?.find((l) => l.description)?.description || null,
    method: null,
    failure: null,
    url: i.hosted_invoice_url,
    pdf: i.invoice_pdf ?? null,
    invoiceId: null,
  };
}

/**
 * A payment as a row. One only authorized so far collected nothing yet, and
 * one captured for less than was authorized collected what was captured, so
 * refunds are weighed against that.
 */
export function chargeActivity(account: string, c: ChargeIn): ActivityRecord {
  const uncaptured = c.status === "succeeded" && c.captured === false;
  return {
    account,
    id: c.id,
    kind: "payment",
    customerId: c.customer ?? null,
    status: uncaptured ? "uncaptured" : c.status,
    amount: uncaptured ? c.amount : (c.amount_captured ?? c.amount),
    refunded: c.amount_refunded ?? 0,
    remaining: 0,
    currency: c.currency,
    createdAt: at(c.created)!,
    dueAt: null,
    number: null,
    description: c.description,
    method: methodLabel(c.payment_method_details),
    failure: c.status === "failed" ? c.failure_message : null,
    url: c.receipt_url,
    pdf: null,
    invoiceId: typeof c.invoice === "object" ? (c.invoice?.id ?? null) : (c.invoice ?? null),
  };
}

/**
 * One state per row for the page to show and filter on. An open invoice is
 * overdue once its due date has passed; a payment is refunded when all of it
 * came back.
 */
export const activityStates = ["paid", "succeeded", "unpaid", "overdue", "failed", "pending", "refunded", "partly_refunded", "void", "uncollectible"] as const;
export type ActivityState = (typeof activityStates)[number];

export const activityStateLabels: Record<ActivityState, { label: string; tone: Tone }> = {
  paid: { label: "Paid", tone: "success" },
  succeeded: { label: "Succeeded", tone: "success" },
  unpaid: { label: "Unpaid", tone: "warning" },
  overdue: { label: "Overdue", tone: "error" },
  failed: { label: "Failed", tone: "error" },
  pending: { label: "Pending", tone: "warning" },
  refunded: { label: "Refunded", tone: "neutral" },
  partly_refunded: { label: "Partly refunded", tone: "neutral" },
  void: { label: "Void", tone: "neutral" },
  uncollectible: { label: "Uncollectible", tone: "error" },
};

export function activityState(r: { kind: ActivityKind; status: string; amount: number; refunded: number; dueAt: Date | string | null }, now = new Date()): ActivityState {
  if (r.kind === "invoice") {
    if (r.status === "open") return r.dueAt && new Date(r.dueAt).getTime() < now.getTime() ? "overdue" : "unpaid";
    if (r.status === "void" || r.status === "uncollectible") return r.status;
    return "paid";
  }
  if (r.status === "failed" || r.status === "pending") return r.status;
  if (r.status === "uncaptured") return "pending";
  if (r.refunded && r.refunded >= r.amount) return "refunded";
  return r.refunded ? "partly_refunded" : "succeeded";
}

/** The Billing page's filters, as the URL carries them. */
export type ActivityFilter = {
  q?: string;
  kind?: ActivityKind;
  state?: ActivityState;
  /** "mapped": a client has the customer; "unmapped": nobody does yet. */
  mapped?: "mapped" | "unmapped";
  account?: string;
  /** YYYY-MM-DD, in UTC, inclusive. */
  from?: string;
  to?: string;
  sort?: ActivitySort;
  dir?: "asc" | "desc";
};

export const activitySorts = ["date", "amount", "customer", "client", "state", "kind", "account"] as const;
export type ActivitySort = (typeof activitySorts)[number];

/** The customers list on the mapping tab. */
export type MappingFilter = { q?: string; mapped?: "mapped" | "unmapped" | "by_hand"; account?: string; sort?: MappingSort; dir?: "asc" | "desc" };
export const mappingSorts = ["customer", "email", "client", "activity", "collected", "last"] as const;
export type MappingSort = (typeof mappingSorts)[number];

/** Who a customer belongs to: matched by email, or linked by hand. */
export type MappedClient = { id: string; name: string; byHand: boolean; email: string | null };

export type ActivityRow = {
  account: string;
  id: string;
  kind: ActivityKind;
  state: ActivityState;
  customerId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  clients: MappedClient[];
  amount: number;
  refunded: number;
  remaining: number;
  currency: string;
  createdAt: string;
  dueAt: string | null;
  number: string | null;
  description: string | null;
  method: string | null;
  failure: string | null;
  url: string | null;
  pdf: string | null;
};

export type MappingRow = {
  account: string;
  customerId: string;
  name: string | null;
  email: string | null;
  clients: MappedClient[];
  activity: number;
  collectedYear: number;
  currency: string | null;
  lastAt: string | null;
};

/** Totals for what the filters show, per currency. */
export type ActivityTotals = {
  rows: number;
  /** Payments that went through, less refunds. */
  collected: Record<string, number>;
  /** Invoices sent. */
  invoiced: Record<string, number>;
  /** Left to pay on open invoices. */
  outstanding: Record<string, number>;
  /** Rows whose customer no client has, and how many customers that is. */
  unmappedRows: number;
  unmappedCustomers: number;
};
