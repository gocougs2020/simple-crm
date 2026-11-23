import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activityState, chargeActivity, invoiceActivity, methodLabel } from "./activity";

const invoice = (over: Partial<Parameters<typeof invoiceActivity>[1]> = {}) => ({
  id: "in_1",
  number: "A-0001",
  status: "paid",
  total: 50_000,
  amount_remaining: 0,
  customer: "cus_1",
  currency: "usd",
  created: 1_760_000_000,
  due_date: null,
  hosted_invoice_url: "https://invoice.stripe.com/i/1",
  invoice_pdf: "https://pay.stripe.com/invoice/1/pdf",
  ...over,
});

const charge = (over: Partial<Parameters<typeof chargeActivity>[1]> = {}) => ({
  id: "ch_1",
  amount: 50_000,
  amount_refunded: 0,
  customer: "cus_1",
  currency: "usd",
  status: "succeeded",
  created: 1_760_000_000,
  description: "Subscription update",
  failure_message: null,
  receipt_url: "https://pay.stripe.com/receipts/1",
  invoice: "in_1",
  payment_method_details: { type: "card", card: { brand: "visa", last4: "4242" } },
  ...over,
});

describe("Billing activity rows", () => {
  it("copies an invoice, leaving drafts out", () => {
    const r = invoiceActivity("default", invoice());
    assert.equal(r?.kind, "invoice");
    assert.equal(r?.amount, 50_000);
    assert.equal(r?.createdAt.toISOString(), new Date(1_760_000_000 * 1000).toISOString());
    assert.equal(r?.pdf, "https://pay.stripe.com/invoice/1/pdf");
    assert.equal(invoiceActivity("default", invoice({ status: "draft" })), null);
    assert.equal(invoiceActivity("default", invoice({ status: null })), null);
  });

  it("only counts what's left on open invoices", () => {
    assert.equal(invoiceActivity("a", invoice({ status: "open", amount_remaining: 20_000 }))?.remaining, 20_000);
    assert.equal(invoiceActivity("a", invoice({ status: "void", amount_remaining: 20_000 }))?.remaining, 0);
  });

  it("falls back to the first line's description for an invoice without one", () => {
    assert.equal(invoiceActivity("a", invoice({ description: null, lines: { data: [{ description: null }, { description: "1 × Retained recruiting" }] } }))?.description, "1 × Retained recruiting");
  });

  it("copies a payment with its method and the invoice it paid", () => {
    const r = chargeActivity("default", charge());
    assert.equal(r.kind, "payment");
    assert.equal(r.method, "Visa ···· 4242");
    assert.equal(r.invoiceId, "in_1");
    assert.equal(r.failure, null);
    assert.equal(chargeActivity("a", charge({ invoice: { id: "in_2" } })).invoiceId, "in_2");
    assert.equal(chargeActivity("a", charge({ status: "failed", failure_message: "Your card was declined." })).failure, "Your card was declined.");
  });

  it("counts what was captured, not what was authorized", () => {
    const held = chargeActivity("a", charge({ captured: false, amount_captured: 0 }));
    assert.equal(held.status, "uncaptured");
    assert.equal(held.amount, 50_000);
    assert.equal(activityState(held), "pending");
    const partial = chargeActivity("a", charge({ captured: true, amount_captured: 30_000, amount_refunded: 30_000 }));
    assert.equal(partial.amount, 30_000);
    assert.equal(activityState(partial), "refunded");
  });

  it("names payment methods as people write them", () => {
    assert.equal(methodLabel({ type: "us_bank_account" }), "Bank account");
    assert.equal(methodLabel({ type: "sepa_debit" }), "Sepa debit");
    assert.equal(methodLabel(null), null);
  });
});

describe("Billing activity states", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  const inv = (status: string, dueAt: string | null = null) => ({ kind: "invoice" as const, status, amount: 100, refunded: 0, dueAt });
  const pay = (status: string, refunded = 0) => ({ kind: "payment" as const, status, amount: 100, refunded, dueAt: null });

  it("calls an open invoice overdue once its due date has passed", () => {
    assert.equal(activityState(inv("open", "2026-05-31T00:00:00Z"), now), "overdue");
    assert.equal(activityState(inv("open", "2026-06-02T00:00:00Z"), now), "unpaid");
    assert.equal(activityState(inv("open"), now), "unpaid");
  });

  it("keeps an invoice's own status otherwise", () => {
    assert.equal(activityState(inv("paid"), now), "paid");
    assert.equal(activityState(inv("void"), now), "void");
    assert.equal(activityState(inv("uncollectible"), now), "uncollectible");
  });

  it("tells refunded payments from partly refunded ones", () => {
    assert.equal(activityState(pay("succeeded"), now), "succeeded");
    assert.equal(activityState(pay("succeeded", 40), now), "partly_refunded");
    assert.equal(activityState(pay("succeeded", 100), now), "refunded");
    assert.equal(activityState(pay("failed"), now), "failed");
    assert.equal(activityState(pay("pending"), now), "pending");
  });
});
