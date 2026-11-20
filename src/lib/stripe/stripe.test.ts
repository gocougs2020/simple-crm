import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseStripeAccounts } from "./accounts";
import { collected, discountShare, monthlyAmount, netMonthly, perMonth, rollUpStatus } from "./rules";

describe("Stripe accounts from the environment", () => {
  it("reads one account per STRIPE_SECRET_KEY variable, named by its suffix", () => {
    const accounts = parseStripeAccounts({
      STRIPE_SECRET_KEY_B: "rk_live_b",
      STRIPE_SECRET_KEY_A: " rk_live_a ",
      STRIPE_ACCOUNT_LABEL_A: "CoRecruit and TalentScout",
      STRIPE_SECRET_KEY_EMPTY: "",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
    });
    assert.deepEqual(accounts, [
      { id: "a", label: "CoRecruit and TalentScout", key: "rk_live_a" },
      { id: "b", label: "B", key: "rk_live_b" },
    ]);
  });

  it("keeps the single-key setup working as the default account", () => {
    assert.deepEqual(parseStripeAccounts({ STRIPE_SECRET_KEY: "rk_live_x" }), [{ id: "default", label: "Stripe", key: "rk_live_x" }]);
    assert.deepEqual(parseStripeAccounts({}), []);
  });

  it("labels an unlabeled account from its variable name", () => {
    assert.equal(parseStripeAccounts({ STRIPE_SECRET_KEY_THIRD_POOL: "k" })[0].label, "Third pool");
    assert.equal(parseStripeAccounts({ STRIPE_SECRET_KEY_THIRD_POOL: "k" })[0].id, "third_pool");
  });
});

describe("Stripe subscriptions as a monthly amount", () => {
  const item = (unit_amount: number | null, interval: "day" | "week" | "month" | "year", interval_count = 1, quantity: number | null = 1) => ({ quantity, price: { unit_amount, recurring: { interval, interval_count } } });

  it("normalizes each billing period to a month", () => {
    assert.equal(monthlyAmount([item(120_000, "year")]), 10_000);
    assert.equal(monthlyAmount([item(30_000, "month", 3)]), 10_000);
    assert.equal(monthlyAmount([item(10_000, "month")]), 10_000);
  });

  it("counts every 4 weeks as 13 payments a year", () => {
    assert.equal(perMonth({ interval: "week", interval_count: 4 }), 13 / 12);
    assert.equal(monthlyAmount([item(120_000, "week", 4)]), 130_000);
  });

  it("multiplies by quantity, adds lines, and skips usage-based and one-time prices", () => {
    assert.equal(monthlyAmount([item(5_000, "month", 1, 3), item(1_000, "month"), item(null, "month"), { quantity: 1, price: { unit_amount: 99_900, recurring: null } }]), 16_000);
  });
});

describe("One billing status per client", () => {
  it("puts a payment problem ahead of a healthy subscription", () => {
    assert.equal(rollUpStatus(["active", "past_due", "canceled"]), "past_due");
    assert.equal(rollUpStatus(["canceled", "unpaid"]), "past_due");
  });

  it("falls through active, trial, paused, then canceled", () => {
    assert.equal(rollUpStatus(["canceled", "active", "trialing"]), "active");
    assert.equal(rollUpStatus(["trialing", "paused"]), "trialing");
    assert.equal(rollUpStatus(["paused", "canceled"]), "paused");
    assert.equal(rollUpStatus(["canceled", "incomplete_expired"]), "canceled");
  });

  it("calls a customer with no subscriptions a customer", () => {
    assert.equal(rollUpStatus([]), "customer");
  });
});

describe("Discounts and what was collected", () => {
  it("reads the discount off the latest invoice, as a share of its subtotal", () => {
    assert.equal(discountShare({ subtotal: 135_000, total_discount_amounts: [{ amount: 13_500 }] }), 0.1);
    assert.equal(discountShare({ subtotal: 100_000, total_discount_amounts: [{ amount: 20_000 }, { amount: 5_000 }] }), 0.25);
    assert.equal(netMonthly(146_250, 0.1), 131_625);
  });

  it("counts no discount when there's no invoice, no subtotal or none applied", () => {
    assert.equal(discountShare(null), 0);
    assert.equal(discountShare({ subtotal: 0, total_discount_amounts: [{ amount: 500 }] }), 0);
    assert.equal(discountShare({ subtotal: 50_000, total_discount_amounts: null }), 0);
  });

  it("never takes off more than the whole price", () => {
    assert.equal(discountShare({ subtotal: 10_000, total_discount_amounts: [{ amount: 25_000 }] }), 1);
    assert.equal(netMonthly(10_000, 1), 0);
  });

  it("counts a payment as what was captured, less refunds, and nothing for failed ones", () => {
    assert.equal(collected({ status: "succeeded", amount: 135_000, amount_captured: 135_000, amount_refunded: 0 }), 135_000);
    assert.equal(collected({ status: "succeeded", amount: 135_000, amount_refunded: 35_000 }), 100_000);
    assert.equal(collected({ status: "failed", amount: 135_000 }), 0);
    assert.equal(collected({ status: "pending", amount: 135_000 }), 0);
  });
});
