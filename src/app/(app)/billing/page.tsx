import type { Metadata } from "next";
import { Suspense } from "react";
import { BillingView } from "@/components/billing/billing-view";
import { PageSkeleton } from "@/components/ui/skeleton";
import { requireUser } from "@/lib/auth";
import { stripeAccounts, stripeConfigured } from "@/lib/stripe";
import { activitySorts, activityStates, mappingSorts, type ActivityFilter, type MappingFilter } from "@/lib/stripe/activity";
import { billingActivityTotals, billingPageSize, countStripeCustomers, lastStripeSync, listBillingActivity, listStripeCustomers } from "@/lib/stripe/billing-page";

export const metadata: Metadata = { title: "Billing" };

/** "Sync now" copies every connected Stripe account, which can take a while on a big one. */
export const maxDuration = 300;

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
const pick = <T extends string>(v: string | undefined, options: readonly T[]) => options.find((o) => o === v);
const ymd = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined);

export default function BillingPage({ searchParams }: PageProps<"/billing">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Billing searchParams={searchParams} />
    </Suspense>
  );
}

async function Billing({ searchParams }: Pick<PageProps<"/billing">, "searchParams">) {
  const sp = await searchParams;
  await requireUser();
  if (!stripeConfigured()) return <BillingView connected={false} />;
  const accounts = stripeAccounts();
  const account = pick(one(sp.account), accounts.map((a) => a.id));
  const q = one(sp.q)?.slice(0, 120) || undefined;
  const dir = pick(one(sp.dir), ["asc", "desc"] as const);
  const tab = one(sp.tab) === "mapping" ? "mapping" : "activity";
  const unmappedFilter: MappingFilter = { mapped: "unmapped" };
  const [unmappedCustomers, syncedAt] = await Promise.all([countStripeCustomers(unmappedFilter), lastStripeSync()]);

  if (tab === "mapping") {
    // Customers nobody has yet come first: that's what this tab is for.
    const mapped = one(sp.mapped) === "all" ? undefined : (pick(one(sp.mapped), ["mapped", "unmapped", "by_hand"] as const) ?? "unmapped");
    const filter: MappingFilter = { q, mapped, account, sort: pick(one(sp.sort), mappingSorts), dir };
    const [rows, total] = await Promise.all([listStripeCustomers(filter, { limit: billingPageSize }), countStripeCustomers(filter)]);
    return <BillingView connected tab="mapping" accounts={accounts} syncedAt={syncedAt} unmappedCustomers={unmappedCustomers} mapping={{ rows, total, filter, pageSize: billingPageSize }} />;
  }

  const filter: ActivityFilter = {
    q,
    kind: pick(one(sp.kind), ["invoice", "payment"] as const),
    state: pick(one(sp.state), activityStates),
    mapped: pick(one(sp.mapped), ["mapped", "unmapped"] as const),
    account,
    from: ymd(one(sp.from)),
    to: ymd(one(sp.to)),
    sort: pick(one(sp.sort), activitySorts),
    dir,
  };
  const [rows, totals] = await Promise.all([listBillingActivity(filter, { limit: billingPageSize }), billingActivityTotals(filter)]);
  return <BillingView connected tab="activity" accounts={accounts} syncedAt={syncedAt} unmappedCustomers={unmappedCustomers} activity={{ rows, totals, filter, pageSize: billingPageSize }} />;
}
