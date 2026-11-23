"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { run, type Result } from "@/lib/action";
import { ActionError, actionAdmin, actionUser } from "@/lib/auth";
import { stripeConfigured } from "@/lib/stripe";
import { activitySorts, activityStates, mappingSorts } from "@/lib/stripe/activity";
import { listBillingActivity, listStripeCustomers } from "@/lib/stripe/billing-page";
import { syncStripe } from "@/lib/stripe/sync";

/**
 * The Billing page: more rows as its tables are scrolled, and a sync on
 * demand. Mapping a customer to a client goes through linkStripeCustomer and
 * removeStripeCustomer (src/actions/clients.ts), the same as on a client's
 * page, so it's checked and recorded in one place.
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates look like 2026-01-31.");
const account = z.string().regex(/^[a-z0-9_]+$/).max(60).optional();
const dir = z.enum(["asc", "desc"]).optional();
const q = z.string().max(120).optional();

const activityFilter = z.object({
  q,
  kind: z.enum(["invoice", "payment"]).optional(),
  state: z.enum(activityStates).optional(),
  mapped: z.enum(["mapped", "unmapped"]).optional(),
  account,
  from: day.optional(),
  to: day.optional(),
  sort: z.enum(activitySorts).optional(),
  dir,
});

const mappingFilter = z.object({ q, mapped: z.enum(["mapped", "unmapped", "by_hand"]).optional(), account, sort: z.enum(mappingSorts).optional(), dir });

const range = z.object({ offset: z.number().int().min(0).max(1_000_000), limit: z.number().int().min(1).max(500) });

export async function moreBillingActivity(filter: z.input<typeof activityFilter>, r: z.input<typeof range>): Promise<Result<Awaited<ReturnType<typeof listBillingActivity>>>> {
  return run(async () => {
    await actionUser();
    return listBillingActivity(activityFilter.parse(filter), range.parse(r));
  });
}

export async function moreStripeCustomers(filter: z.input<typeof mappingFilter>, r: z.input<typeof range>): Promise<Result<Awaited<ReturnType<typeof listStripeCustomers>>>> {
  return run(async () => {
    await actionUser();
    return listStripeCustomers(mappingFilter.parse(filter), range.parse(r));
  });
}

/** Copies every connected account now instead of waiting for the daily run. Admins only: it's the whole account, a few dozen requests or more. */
export async function syncStripeNow(): Promise<Result<{ failed: string[] }>> {
  return run(async () => {
    await actionAdmin();
    if (!stripeConfigured()) throw new ActionError("Stripe isn't connected. Add a STRIPE_SECRET_KEY to the environment first.");
    const report = await syncStripe();
    refresh();
    return { failed: report.accounts.filter((a) => a.error).map((a) => a.account) };
  });
}
