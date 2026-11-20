"use client";

import { useState, useTransition, type ReactNode } from "react";
import { ArrowPathIcon, ArrowTopRightOnSquareIcon, EllipsisHorizontalIcon, LinkIcon } from "@heroicons/react/20/solid";
import { findStripeCustomers, linkStripeCustomer, refreshStripe, removeStripeCustomer } from "@/actions/clients";
import { useApp } from "@/components/app-context";
import { SideCard } from "@/components/records/inline-field";
import { StatusBadge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/field";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { formatMoney } from "@/lib/format";
import { billingStatusLabels, liveStatuses, rollUpStatus, type BillingStatus } from "@/lib/stripe/rules";
import type { CustomerBilling, SubStatus } from "@/lib/stripe/types";

const day = (unix: number) => new Date(unix * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const money = (cents: number, currency: string | null) => formatMoney(cents, (currency ?? "usd").toUpperCase());

const subTone: Record<SubStatus, Tone> = { active: "success", trialing: "info", past_due: "error", unpaid: "error", incomplete: "warning", incomplete_expired: "neutral", canceled: "neutral", paused: "warning" };
const subLabel: Record<SubStatus, string> = { active: "Active", trialing: "Trial", past_due: "Past due", unpaid: "Unpaid", incomplete: "Incomplete", incomplete_expired: "Expired", canceled: "Canceled", paused: "Paused" };
const statusTone: Record<BillingStatus, Tone> = { past_due: "error", active: "success", trialing: "info", paused: "warning", canceled: "neutral", customer: "neutral" };
const invoiceTone = { paid: "success", open: "warning", uncollectible: "error", void: "neutral", draft: "neutral" } as const;

const isLive = (s: { status: string }) => (liveStatuses as readonly string[]).includes(s.status);
const every = (i: { interval: string | null; intervalCount: number }) => (i.interval ? `/${i.intervalCount > 1 ? `${i.intervalCount} ` : ""}${i.interval}${i.intervalCount > 1 ? "s" : ""}` : "");
const priceOf = (s: CustomerBilling["subscriptions"][number]) =>
  s.items
    .map((i) => (i.amount != null ? `${money(i.amount * i.quantity, i.currency)}${every(i)}` : null))
    .filter(Boolean)
    .join(" + ");
/** What a subscription is billed after its discounts, when it has any: "$1,215/mo after discounts". */
const netOf = (s: CustomerBilling["subscriptions"][number]) => (s.discount ? `${money(s.monthly - s.discount, s.currency)}/mo after discounts` : null);
const whenOf = (s: CustomerBilling["subscriptions"][number]) => (s.endedAt ? `ended ${day(s.endedAt)}` : s.cancelAt ? `ends ${day(s.cancelAt)}` : s.cancelAtPeriodEnd && s.periodEnd ? `ends ${day(s.periodEnd)}` : s.periodEnd ? `renews ${day(s.periodEnd)}` : "");

function SubBadge({ s }: { s: CustomerBilling["subscriptions"][number] }) {
  return <StatusBadge tone={subTone[s.status]}>{s.cancelAtPeriodEnd && s.status === "active" ? "Canceling" : subLabel[s.status]}</StatusBadge>;
}

/**
 * The billing card: what Stripe says about this client across every
 * connected account. The card is the highlights (status, monthly amount,
 * what's owed, running subscriptions); "See details" opens each customer's
 * subscriptions, saved cards, invoice history and payments.
 */
export function BillingView({
  clientId,
  customers,
  failed,
  more,
  accounts,
  suggest,
}: {
  clientId: string;
  customers: CustomerBilling[];
  /** Customers Stripe didn't answer for. */
  failed: number;
  /** Matched customers beyond the ones read. */
  more: number;
  accounts: { id: string; label: string }[];
  suggest: string | null;
}) {
  const { canEdit } = useApp();
  const [details, setDetails] = useState(false);
  const [linking, setLinking] = useState(false);
  const [pending, start] = useTransition();
  const several = accounts.length > 1;

  const subs = customers.flatMap((c) => c.subscriptions.map((s) => ({ ...s, customer: c })));
  const live = subs.filter(isLive);
  const currency = live[0]?.currency ?? customers[0]?.customer.currency ?? customers[0]?.invoices[0]?.currency ?? "usd";
  const running = live.filter((s) => s.status !== "paused");
  const discount = running.reduce((sum, s) => sum + s.discount, 0);
  const monthly = running.reduce((sum, s) => sum + s.monthly, 0) - discount;
  const collectedYear = customers.reduce((sum, c) => sum + c.collectedYear, 0);
  const credit = customers.reduce((sum, c) => sum + Math.max(0, -c.customer.balance), 0);
  const open = customers.flatMap((c) => c.invoices.filter((i) => i.status === "open"));
  const owed = open.reduce((sum, i) => sum + i.remaining, 0);
  const overdue = open.filter((i) => i.overdue).length;
  const status = customers.length ? rollUpStatus(subs.map((s) => s.status)) : null;
  const lastPaid = customers.flatMap((c) => c.charges.filter((x) => x.status === "succeeded" && !x.refunded)).sort((a, b) => b.created - a.created)[0];
  const delinquent = customers.some((c) => c.customer.delinquent);

  const refresh = () =>
    start(async () => {
      const r = await refreshStripe(clientId);
      if (!r.ok) toast.error(r.error);
      else toast.success("Billing is up to date with Stripe");
    });

  const menu = (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="-mr-1 rounded p-1 text-faint hover:text-primary" aria-label="More for billing" disabled={pending}>
          <EllipsisHorizontalIcon className="size-4" />
        </button>
      </MenuTrigger>
      <MenuContent className="w-52">
        <MenuItem icon={<ArrowPathIcon />} onSelect={refresh}>
          Check Stripe now
        </MenuItem>
        {canEdit ? (
          <MenuItem icon={<LinkIcon />} onSelect={() => setLinking(true)}>
            Link a customer by hand
          </MenuItem>
        ) : null}
      </MenuContent>
    </Menu>
  );

  return (
    <SideCard
      title={
        <span className="inline-flex items-center gap-2">
          Billing
          {status ? <StatusBadge tone={statusTone[status]}>{billingStatusLabels[status]}</StatusBadge> : null}
        </span>
      }
      action={menu}
    >
      {!customers.length ? (
        <p className="py-1 text-[12.5px] text-muted">
          {failed
            ? "Stripe didn't answer. Reload to try again."
            : `No Stripe customer has the email of anyone on this client${several ? `, in ${accounts.map((a) => a.label).join(" or ")}` : ""}. Add their billing email to a person here, or link a customer by hand from the menu.`}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-2 gap-x-2 gap-y-2.5">
            <div>
              <dt className="text-[11.5px] text-muted">Subscriptions</dt>
              <dd className="text-[14px] font-semibold text-primary tabular-nums">{running.length ? `${money(monthly, currency)}/mo` : "None running"}</dd>
              {discount ? <dd className="text-[11.5px] text-muted tabular-nums">after {money(discount, currency)}/mo in discounts</dd> : null}
            </div>
            <div>
              <dt className="text-[11.5px] text-muted">Open invoices</dt>
              <dd className={owed ? "text-[14px] font-semibold text-warning tabular-nums" : "text-[14px] font-semibold text-primary tabular-nums"}>
                {money(owed, currency)}
                {overdue ? <span className="ml-1 text-[11.5px] font-medium text-error">{overdue} overdue</span> : null}
              </dd>
            </div>
            <div>
              <dt className="text-[11.5px] text-muted">Collected, last 12 months</dt>
              <dd className="text-[14px] font-semibold text-primary tabular-nums">{money(collectedYear, currency)}</dd>
            </div>
            {credit ? (
              <div>
                <dt className="text-[11.5px] text-muted">Credit on account</dt>
                <dd className="text-[14px] font-semibold text-primary tabular-nums">{money(credit, currency)}</dd>
              </div>
            ) : null}
          </dl>
          {delinquent ? <p className="text-[12px] text-error">Stripe marks a customer here as delinquent: a recent payment failed.</p> : null}

          {live.length ? (
            <ul className="flex flex-col gap-1.5">
              {live.slice(0, 6).map((s) => (
                <li key={`${s.customer.account}:${s.id}`} className="text-[12.5px]">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium text-primary">{s.items.map((i) => i.name).join(", ")}</span>
                    <SubBadge s={s} />
                  </div>
                  <p className="truncate text-[11.5px] text-muted tabular-nums">{[priceOf(s), netOf(s), whenOf(s), several ? s.customer.accountLabel : null].filter(Boolean).join(" · ")}</p>
                </li>
              ))}
            </ul>
          ) : subs.length ? (
            <p className="text-[12.5px] text-muted">
              {subs.length} past subscription{subs.length === 1 ? "" : "s"}, none running now.
            </p>
          ) : null}

          <p className="text-[11.5px] text-muted">
            {customers.length} customer{customers.length === 1 ? "" : "s"}
            {several ? ` in ${[...new Set(customers.map((c) => c.accountLabel))].join(" and ")}` : ""}
            {lastPaid ? ` · last paid ${money(lastPaid.amount, lastPaid.currency)} on ${day(lastPaid.created)}` : ""}
            {failed ? ` · ${failed} more didn't load` : ""}
            {more ? ` · ${more} more not shown` : ""}
          </p>

          <Button size="sm" variant="outline" className="self-start" onClick={() => setDetails(true)}>
            See details
          </Button>
        </div>
      )}
      {details ? <BillingDetails clientId={clientId} customers={customers} several={several} canEdit={canEdit} onClose={() => setDetails(false)} /> : null}
      {linking ? <StripeLinker clientId={clientId} suggest={suggest} several={several} onClose={() => setLinking(false)} /> : null}
    </SideCard>
  );
}

function Block({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section>
      <h4 className="mb-1 text-[11.5px] font-semibold tracking-wide text-muted uppercase">
        {title}
        {count ? <span className="ml-1 font-medium tabular-nums">{count}</span> : null}
      </h4>
      {children}
    </section>
  );
}

/** Everything about each customer: who they are in Stripe, every subscription, saved cards, the invoice history and payments. */
function BillingDetails({ clientId, customers, several, canEdit, onClose }: { clientId: string; customers: CustomerBilling[]; several: boolean; canEdit: boolean; onClose: () => void }) {
  const [shown, setShown] = useState(0);
  const [allInvoices, setAllInvoices] = useState(false);
  const [pending, start] = useTransition();
  const c = customers[Math.min(shown, customers.length - 1)];
  const label = (x: CustomerBilling) => x.customer.name ?? x.customer.email ?? x.customer.id;
  const invoices = allInvoices ? c.invoices : c.invoices.slice(0, 12);
  const remove = () =>
    start(async () => {
      if (!confirm(`Take ${label(c)} off this client? Their billing stops showing here until someone links them again.`)) return;
      const r = await removeStripeCustomer(clientId, c.account, c.customer.id);
      if (!r.ok) return void toast.error(r.error);
      toast.success("Customer taken off this client");
      onClose();
    });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Billing" description="Read from Stripe just now; collected totals are from the last sync. Nothing here changes anything in Stripe." size="xl">
      {customers.length > 1 ? (
        <div className="mb-4 flex flex-wrap gap-1" role="tablist" aria-label="Stripe customers">
          {customers.map((x, i) => (
            <button
              key={`${x.account}:${x.customer.id}`}
              type="button"
              role="tab"
              aria-selected={i === shown}
              onClick={() => {
                setShown(i);
                setAllInvoices(false);
              }}
              className={i === shown ? "rounded-full bg-accent px-3 py-1 text-[12.5px] font-medium text-accent-foreground" : "rounded-full bg-sunken px-3 py-1 text-[12.5px] font-medium text-secondary hover:text-primary"}
            >
              {label(x)}
              {several ? <span className="opacity-70"> · {x.accountLabel}</span> : null}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-5">
        <header className="flex flex-wrap items-start gap-x-6 gap-y-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-semibold text-primary">{label(c)}</p>
            <p className="text-[12.5px] text-muted">
              {[c.customer.email, several ? c.accountLabel : null, `Customer since ${day(c.customer.created)}`].filter(Boolean).join(" · ")}
            </p>
            <p className="text-[12px] text-faint">{c.byHand ? "Linked by hand" : c.matchedEmail ? `Matched on ${c.matchedEmail}` : ""}</p>
          </div>
          <dl className="flex flex-wrap gap-x-6 gap-y-2">
            <div>
              <dt className="text-[11.5px] text-muted">Collected, 12 months</dt>
              <dd className="text-[14px] font-semibold text-primary tabular-nums">{money(c.collectedYear, c.customer.currency)}</dd>
            </div>
            <div>
              <dt className="text-[11.5px] text-muted">Last 30 days</dt>
              <dd className="text-[14px] font-semibold text-primary tabular-nums">{money(c.collectedMonth, c.customer.currency)}</dd>
            </div>
            <div>
              <dt className="text-[11.5px] text-muted">{c.customer.balance < 0 ? "Credit" : "Balance"}</dt>
              <dd className="text-[14px] font-semibold text-primary tabular-nums">{money(Math.abs(c.customer.balance), c.customer.currency)}</dd>
            </div>
            <div>
              <dt className="text-[11.5px] text-muted">Open invoices</dt>
              <dd className="text-[14px] font-semibold text-primary tabular-nums">{money(c.invoices.filter((i) => i.status === "open").reduce((s, i) => s + i.remaining, 0), c.customer.currency ?? c.invoices[0]?.currency ?? null)}</dd>
            </div>
          </dl>
          <span className="flex items-center gap-1">
            <a href={c.dashboardUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12.5px] font-medium text-secondary hover:bg-sunken hover:text-primary">
              Open in Stripe
              <ArrowTopRightOnSquareIcon className="size-3.5" />
            </a>
            {canEdit ? (
              <Menu>
                <MenuTrigger asChild>
                  <button type="button" className="rounded p-1 text-faint hover:text-primary" aria-label={`More for ${label(c)}`} disabled={pending}>
                    <EllipsisHorizontalIcon className="size-4" />
                  </button>
                </MenuTrigger>
                <MenuContent className="w-56">
                  <MenuItem destructive onSelect={remove}>
                    Not this client&apos;s customer
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem onSelect={() => navigator.clipboard?.writeText(c.customer.id)}>Copy customer ID</MenuItem>
                </MenuContent>
              </Menu>
            ) : null}
          </span>
        </header>
        {c.customer.delinquent ? <p className="text-[12.5px] text-error">Stripe marks this customer as delinquent: a recent payment failed.</p> : null}

        <Block title="Subscriptions" count={c.subscriptions.length}>
          {c.subscriptions.length ? (
            <ul className="divide-y divide-line">
              {[...c.subscriptions.filter(isLive), ...c.subscriptions.filter((s) => !isLive(s))].map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-2 text-[13px]">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-primary">{s.items.map((i) => (i.quantity > 1 ? `${i.name} × ${i.quantity}` : i.name)).join(", ")}</span>
                    <span className="block text-[12px] text-muted tabular-nums">{[`Started ${day(s.started)}`, whenOf(s), s.trialEnd && s.status === "trialing" ? `trial ends ${day(s.trialEnd)}` : null].filter(Boolean).join(" · ")}</span>
                  </span>
                  <SubBadge s={s} />
                  <span className="w-48 text-right tabular-nums">
                    <span className="block text-primary">{priceOf(s) || "Usage based"}</span>
                    {s.discount ? <span className="block text-[12px] text-muted">{netOf(s)}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">No subscriptions. They may be billed with one-off invoices.</p>
          )}
        </Block>

        <Block title="Saved cards and payment methods" count={c.paymentMethods?.length}>
          {c.paymentMethods === null ? (
            <p className="text-[13px] text-muted">This Stripe key can&apos;t read payment methods. Give it read access to Payment Methods to see saved cards here.</p>
          ) : c.paymentMethods.length ? (
            <ul className="flex flex-wrap gap-2">
              {c.paymentMethods.map((m) => (
                <li key={m.id} className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-[13px]">
                  <span className="font-medium text-primary capitalize">{m.label}</span>
                  {m.expires ? <span className={m.expired ? "text-error tabular-nums" : "text-muted tabular-nums"}>{m.expired ? `Expired ${m.expires}` : `Expires ${m.expires}`}</span> : null}
                  {m.isDefault ? <StatusBadge tone="info">Default</StatusBadge> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">Nothing saved.</p>
          )}
        </Block>

        <Block title="Invoices" count={c.invoices.length}>
          {c.invoices.length ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[13px]">
                  <thead className="text-[11.5px] text-muted">
                    <tr>
                      <th className="py-1 pr-3 font-medium">Date</th>
                      <th className="py-1 pr-3 font-medium">Invoice</th>
                      <th className="py-1 pr-3 font-medium">Status</th>
                      <th className="py-1 pr-3 text-right font-medium">Discount</th>
                      <th className="py-1 pr-3 text-right font-medium">Total</th>
                      <th className="py-1 pr-3 text-right font-medium">Owed</th>
                      <th className="py-1 font-medium">
                        <span className="sr-only">Links</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {invoices.map((i) => (
                      <tr key={i.id}>
                        <td className="py-1.5 pr-3 whitespace-nowrap text-muted tabular-nums">{day(i.created)}</td>
                        <td className="py-1.5 pr-3 text-secondary">{i.number ?? "Invoice"}</td>
                        <td className="py-1.5 pr-3">
                          {i.status ? <StatusBadge tone={invoiceTone[i.status]}>{i.overdue ? "Overdue" : i.status[0].toUpperCase() + i.status.slice(1)}</StatusBadge> : null}
                          {i.status === "open" && i.dueDate ? <span className="ml-1.5 text-[12px] text-muted">due {day(i.dueDate)}</span> : null}
                        </td>
                        <td className="py-1.5 pr-3 text-right text-muted tabular-nums">{i.discount ? `−${money(i.discount, i.currency)}` : <span className="text-faint">—</span>}</td>
                        <td className="py-1.5 pr-3 text-right text-primary tabular-nums">{money(i.total, i.currency)}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{i.remaining ? money(i.remaining, i.currency) : <span className="text-faint">—</span>}</td>
                        <td className="py-1.5 text-right whitespace-nowrap">
                          {i.url ? (
                            <a href={i.url} target="_blank" rel="noopener noreferrer" className="text-[12.5px] text-secondary underline-offset-2 hover:underline">
                              View
                            </a>
                          ) : null}
                          {i.pdf ? (
                            <a href={i.pdf} target="_blank" rel="noopener noreferrer" className="ml-3 text-[12.5px] text-secondary underline-offset-2 hover:underline">
                              PDF
                            </a>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {c.invoices.length > invoices.length ? (
                <Button size="sm" variant="ghost" className="mt-1 -ml-2 text-muted" onClick={() => setAllInvoices(true)}>
                  Show all {c.invoices.length}
                </Button>
              ) : null}
              {c.invoices.length >= 60 ? <p className="mt-1 text-[12px] text-muted">The latest {c.invoices.length}. Open the customer in Stripe for older ones.</p> : null}
            </>
          ) : (
            <p className="text-[13px] text-muted">No invoices yet.</p>
          )}
        </Block>

        <Block title="Payments" count={c.charges.length}>
          {c.charges.length ? (
            <ul className="divide-y divide-line">
              {c.charges.map((x) => (
                <li key={x.id} className="flex flex-wrap items-center gap-x-3 py-1.5 text-[13px]">
                  <span className="w-28 shrink-0 text-muted tabular-nums">{day(x.created)}</span>
                  <span className="min-w-0 flex-1 truncate text-secondary">
                    <span className="capitalize">{x.method ?? "Payment"}</span>
                    {x.status === "failed" && x.failure ? <span className="text-error"> · {x.failure}</span> : x.description ? <span className="text-muted"> · {x.description}</span> : null}
                  </span>
                  {x.status === "failed" ? <StatusBadge tone="error">Failed</StatusBadge> : x.refunded ? <StatusBadge tone="neutral">Refunded</StatusBadge> : x.status === "pending" ? <StatusBadge tone="warning">Pending</StatusBadge> : null}
                  <span className="w-24 shrink-0 text-right text-primary tabular-nums">{money(x.amount, x.currency)}</span>
                  {x.receipt ? (
                    <a href={x.receipt} target="_blank" rel="noopener noreferrer" className="text-[12.5px] text-secondary underline-offset-2 hover:underline">
                      Receipt
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">No payments yet.</p>
          )}
        </Block>
      </div>
    </Dialog>
  );
}

/** Finds a Stripe customer by email, name or ID in every connected account and puts it on the client, for one the email matching can't find. */
function StripeLinker({ clientId, suggest, several, onClose }: { clientId: string; suggest: string | null; several: boolean; onClose: () => void }) {
  const [q, setQ] = useState(suggest ?? "");
  const [results, setResults] = useState<{ account: string; accountLabel: string; id: string; name: string | null; email: string | null }[] | null>(null);
  const [pending, start] = useTransition();
  const search = () =>
    start(async () => {
      const r = await findStripeCustomers(q);
      if (!r.ok) return void toast.error(r.error);
      setResults(r.data);
    });
  const link = (account: string, id: string) =>
    start(async () => {
      const r = await linkStripeCustomer(clientId, account, id);
      if (!r.ok) return void toast.error(r.error);
      toast.success("Stripe customer linked");
      onClose();
    });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Link a Stripe customer"
      description="Customers are matched by the emails of this client's people. Use this for one whose billing email isn't on anyone here. Search by email, name, or paste a customer ID (cus_…)."
      size="sm"
    >
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <Input value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder="billing@acme.com" aria-label="Search Stripe customers" />
        <Button type="submit" variant="outline" loading={pending}>
          Search
        </Button>
      </form>
      {results ? (
        results.length ? (
          <ul className="-mx-2 mt-3">
            {results.map((c) => (
              <li key={`${c.account}:${c.id}`}>
                <button type="button" onClick={() => link(c.account, c.id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-sunken" disabled={pending}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-primary">{c.name ?? c.email ?? c.id}</span>
                    <span className="block truncate text-[11.5px] text-muted">{[c.email, several ? c.accountLabel : null, c.id].filter(Boolean).join(" · ")}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-[13px] text-muted">No customers match. Try their billing email or paste the ID from Stripe.</p>
        )
      ) : null}
    </Dialog>
  );
}
