import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseStripeAccounts } from "./accounts";
import { monthlyAmount, perMonth, rollUpStatus } from "./rules";

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
