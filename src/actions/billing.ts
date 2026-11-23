"use server";

import { refresh, updateTag } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { run, type Result } from "@/lib/action";
import { ActionError, actionAdmin } from "@/lib/auth";
import { recordEvent } from "@/lib/crm/events";
import { id } from "@/lib/crm/schemas";
import { formatMoney } from "@/lib/format";
import {
  cancelSubscription,
  createSubscription,
  getPrice,
  getSubscription,
  keepSubscription,
  productNames,
  recurringPrices,
  stripeAccountLabel,
  stripeCustomerTag,
  StripeError,
  updateSubscription,
  type StripePriceOption,
  type StripeSubscription,
} from "@/lib/stripe";
import { changeSubscriptionForm, newSubscriptionForm, per, type Line } from "@/lib/stripe/changes";
import { customersOfClient, syncClient } from "@/lib/stripe/sync";

/**
 * Changes to a client's billing, made in Stripe. Admins only: everything here
 * starts, changes or ends what a customer pays. Each one checks the Stripe
 * customer is one of this client's (matched by email or linked by hand),
 * writes the change to the client's history, and reads the client back from
 * Stripe so the card and the Clients table show it straight away.
 *
 * Not an API operation or MCP tool on purpose: the agent never changes billing.
 */

const account = z.string().regex(/^[a-z0-9_]+$/).max(60);
const customerId = z.string().regex(/^cus_[A-Za-z0-9]+$/);
const subscriptionId = z.string().regex(/^sub_[A-Za-z0-9]+$/);
const priceId = z.string().regex(/^price_[A-Za-z0-9]+$/);
const itemId = z.string().regex(/^si_[A-Za-z0-9]+$/);
const paymentMethod = z.string().regex(/^(pm|card|ba|src)_[A-Za-z0-9]+$/).nullish();
/** A request from one click: Stripe answers a repeat of the same key with the first answer. */
const requestKey = z.string().uuid();
const collection = z.enum(["charge_automatically", "send_invoice"]);
const daysUntilDue = z.number().int().min(0, "Days to pay can't be negative.").max(365, "Give them at most 365 days to pay.").nullish();
const amount = z.number().int().min(0, "Amounts can't be negative.").max(99_999_999, "That amount is larger than Stripe takes.").nullish();
const line = z.object({ priceId, amount, quantity: z.number().int().min(1, "Quantity is at least 1.").max(10_000) });

/** A Stripe refusal becomes a sentence for the person; anything else is a bug and stays generic. */
async function stripe<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StripeError) throw new ActionError(err.message);
    throw err;
  }
}

async function clientOf(clientId: string, acct: string, customer: string) {
  const db = await getDb();
  const [client] = await db.select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.id, id.parse(clientId)));
  if (!client) throw new ActionError("This client was deleted.");
  const mine = await customersOfClient(client.id);
  if (!mine.some((c) => c.account === acct && c.customerId === customer)) throw new ActionError("That Stripe customer isn't on this client anymore. Reload the page to see its billing now.");
  return client;
}

/** The subscription, read from Stripe, once it's clear it belongs to this client. */
async function subscriptionOf(clientId: string, acct: string, subId: string) {
  const sub = await stripe(() => getSubscription(acct, subId));
  const client = await clientOf(clientId, acct, sub.customer);
  return { client, sub };
}

/** Reads the client back from Stripe and drops the card's two-minute copy, so the page shows the change. A slow Stripe here doesn't undo the change. */
async function reread(clientId: string, acct: string, customer: string) {
  await syncClient(clientId).catch((err) => console.warn("[stripe] after change", (err as Error).message));
  updateTag(stripeCustomerTag(acct, customer));
  refresh();
}

async function nameOf(acct: string, sub: StripeSubscription) {
  const names = await productNames(acct, [...new Set(sub.items.data.map((i) => i.price.product))]).catch(() => new Map<string, string>());
  return sub.items.data.map((i) => names.get(i.price.product) ?? i.price.nickname ?? "Subscription").join(", ") || "Subscription";
}

const priceText = (sub: StripeSubscription) =>
  sub.items.data
    .map((i) => (i.price.unit_amount != null ? `${formatMoney(i.price.unit_amount * (i.quantity ?? 1), i.price.currency.toUpperCase())}${per(i.price.recurring?.interval ?? null, i.price.recurring?.interval_count)}` : null))
    .filter(Boolean)
    .join(" + ");

const iso = (unix: number | null | undefined) => (unix ? new Date(unix * 1000).toISOString() : null);
const periodEndOf = (s: StripeSubscription) => s.current_period_end ?? s.items.data.map((i) => i.current_period_end).find(Boolean) ?? null;

/** A line as Stripe takes it: the price as is, or a different amount on its product and billing period. */
async function toLine(acct: string, l: z.infer<typeof line>, current?: { id: string; price: string; amount: number | null }): Promise<Line> {
  const price = await stripe(() => getPrice(acct, l.priceId));
  if (!price.recurring) throw new ActionError("That price isn't a recurring one. Pick a plan billed every month, year or week.");
  const custom = l.amount != null && l.amount !== price.unit_amount && !(current && current.price === l.priceId && current.amount === l.amount);
  return {
    id: current?.id,
    price: price.id,
    custom: custom ? { product: price.product, currency: price.currency, unitAmount: l.amount!, interval: price.recurring.interval, intervalCount: price.recurring.interval_count || 1 } : undefined,
    quantity: l.quantity,
  };
}

/** The recurring prices in one account, for the plan pickers. */
export async function billingPrices(acctInput: string): Promise<Result<StripePriceOption[]>> {
  return run(async () => {
    await actionAdmin();
    return stripe(() => recurringPrices(account.parse(acctInput)));
  });
}

const createInput = z.object({
  account,
  customerId,
  line,
  collection,
  daysUntilDue,
  paymentMethod,
  trialDays: z.number().int().min(0).max(730, "Trials are at most two years.").nullish(),
  requestKey,
});

/** Starts a subscription for one of this client's Stripe customers. */
export async function createStripeSubscription(clientId: string, input: z.input<typeof createInput>): Promise<Result<{ id: string }>> {
  return run(async () => {
    const user = await actionAdmin();
    const v = createInput.parse(input);
    const client = await clientOf(clientId, v.account, v.customerId);
    const l = await toLine(v.account, v.line);
    const sub = await stripe(() =>
      createSubscription(v.account, newSubscriptionForm({ customer: v.customerId, lines: [l], collection: v.collection, daysUntilDue: v.daysUntilDue, paymentMethod: v.paymentMethod, trialDays: v.trialDays }), v.requestKey),
    );
    await recordEvent({
      entityType: "client",
      entityId: client.id,
      action: "stripe_subscription_created",
      data: { subscription: sub.id, name: await nameOf(v.account, sub), price: priceText(sub), account: stripeAccountLabel(v.account), trialEnds: iso(sub.trial_end) },
      userId: user.id,
    });
    await reread(client.id, v.account, v.customerId);
    return { id: sub.id };
  });
}

const updateInput = z.object({
  account,
  subscriptionId,
  lines: z.array(line.extend({ id: itemId })).min(1).max(20),
  proration: z.enum(["create_prorations", "always_invoice", "none"]),
  collection,
  daysUntilDue,
  paymentMethod,
  requestKey,
});

/** Moves a subscription to another plan or amount, changes its quantity, or how it's paid. */
export async function updateStripeSubscription(clientId: string, input: z.input<typeof updateInput>): Promise<Result> {
  return run(async () => {
    const user = await actionAdmin();
    const v = updateInput.parse(input);
    const { client, sub } = await subscriptionOf(clientId, v.account, v.subscriptionId);
    if (sub.status === "canceled" || sub.status === "incomplete_expired") throw new ActionError("This subscription has ended, so it can't be changed. Start a new one instead.");
    const lines: Line[] = [];
    for (const l of v.lines) {
      const now = sub.items.data.find((i) => i.id === l.id);
      if (!now) throw new ActionError("That subscription changed in Stripe since this page loaded. Reload and try again.");
      const same = now.price.id === l.priceId && (now.quantity ?? 1) === l.quantity && (l.amount == null || l.amount === now.price.unit_amount);
      if (!same) lines.push(await toLine(v.account, l, { id: now.id, price: now.price.id, amount: now.price.unit_amount }));
    }
    const before = priceText(sub);
    const updated = await stripe(() => updateSubscription(v.account, sub.id, changeSubscriptionForm({ lines, proration: v.proration, collection: v.collection, daysUntilDue: v.daysUntilDue, paymentMethod: v.paymentMethod }), v.requestKey));
    const after = priceText(updated);
    await recordEvent({
      entityType: "client",
      entityId: client.id,
      action: "stripe_subscription_changed",
      data: { subscription: sub.id, name: await nameOf(v.account, updated), from: before !== after ? before : null, to: before !== after ? after : null, proration: lines.length ? v.proration : null, account: stripeAccountLabel(v.account) },
      userId: user.id,
    });
    await reread(client.id, v.account, sub.customer);
  });
}

const cancelInput = z.object({ account, subscriptionId, when: z.enum(["now", "period_end"]), requestKey });

/** Cancels a subscription now, or at the end of the period they've paid for. Returns when it ends, in unix seconds. */
export async function cancelStripeSubscription(clientId: string, input: z.input<typeof cancelInput>): Promise<Result<{ endsAt: number | null }>> {
  return run(async () => {
    const user = await actionAdmin();
    const v = cancelInput.parse(input);
    const { client, sub } = await subscriptionOf(clientId, v.account, v.subscriptionId);
    if (sub.status === "canceled" || sub.status === "incomplete_expired") throw new ActionError("This subscription has already ended.");
    const done = await stripe(() => cancelSubscription(v.account, sub.id, v.when, v.requestKey));
    const endsAt = v.when === "now" ? (done.ended_at ?? done.canceled_at ?? Math.floor(Date.now() / 1000)) : (done.cancel_at ?? periodEndOf(done));
    await recordEvent({
      entityType: "client",
      entityId: client.id,
      action: "stripe_subscription_canceled",
      data: { subscription: sub.id, name: await nameOf(v.account, sub), when: v.when, endsAt: iso(endsAt), account: stripeAccountLabel(v.account) },
      userId: user.id,
    });
    await reread(client.id, v.account, sub.customer);
    return { endsAt };
  });
}

const keepInput = z.object({ account, subscriptionId, requestKey });

/** Takes back a cancellation that hasn't happened yet: the subscription renews as before. */
export async function keepStripeSubscription(clientId: string, input: z.input<typeof keepInput>): Promise<Result> {
  return run(async () => {
    const user = await actionAdmin();
    const v = keepInput.parse(input);
    const { client, sub } = await subscriptionOf(clientId, v.account, v.subscriptionId);
    if (sub.status === "canceled" || sub.status === "incomplete_expired") throw new ActionError("This subscription has already ended. Start a new one instead.");
    if (!sub.cancel_at_period_end && !sub.cancel_at) return;
    await stripe(() => keepSubscription(v.account, sub, v.requestKey));
    await recordEvent({ entityType: "client", entityId: client.id, action: "stripe_subscription_kept", data: { subscription: sub.id, name: await nameOf(v.account, sub), account: stripeAccountLabel(v.account) }, userId: user.id });
    await reread(client.id, v.account, sub.customer);
  });
}
