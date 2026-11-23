"use client";

import { useState, useTransition, type ReactNode } from "react";
import clsx from "clsx";
import { ArrowPathIcon, ArrowTopRightOnSquareIcon, BanknotesIcon, DocumentTextIcon, EllipsisHorizontalIcon, LinkIcon, PencilSquareIcon, PlusIcon, XCircleIcon } from "@heroicons/react/20/solid";
import { keepStripeSubscription } from "@/actions/billing";
import { findStripeCustomers, linkStripeCustomer, refreshStripe, removeStripeCustomer } from "@/actions/clients";
import { useApp } from "@/components/app-context";
import { SideCard } from "@/components/records/inline-field";
import { StatusBadge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/field";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { billingStatusLabels, rollUpStatus, type BillingStatus } from "@/lib/stripe/rules";
import type { CustomerBilling } from "@/lib/stripe/types";
import { CancelSubscriptionDialog, EditSubscriptionDialog, NewSubscriptionDialog } from "./billing-manage";
import { cancelsAt, day, isEnded, isLive, money, netOf, priceOf, SubBadge, subName, whenOf, type Sub } from "./billing-shared";
import { PaymentCard } from "./payment-card";

const statusTone: Record<BillingStatus, Tone> = { past_due: "error", active: "success", trialing: "info", paused: "warning", canceled: "neutral", customer: "neutral" };

/** One figure with its label, for the rows of numbers on the card and in the details. */
function Stat({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: "error" | "warning" }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[11.5px] text-muted">{label}</dt>
      <dd className={clsx("truncate text-[14px] font-semibold tabular-nums", tone === "error" ? "text-error" : tone === "warning" ? "text-warning" : "text-primary")}>{value}</dd>
      {note ? <dd className="truncate text-[11.5px] text-muted tabular-nums">{note}</dd> : null}
    </div>
  );
}

const overdueOf = (invoices: CustomerBilling["invoices"]) => invoices.filter((i) => i.status === "open" && i.overdue);
const sum = (invoices: CustomerBilling["invoices"]) => invoices.reduce((t, i) => t + i.remaining, 0);

/**
 * The billing card: what Stripe says about this client across every
 * connected account. The card is the highlights (monthly amount, what's
 * overdue, what they paid in the last 12 months, running subscriptions);
 * "See details" opens each customer's subscriptions, saved cards and billing
 * history. Admins can start, change and cancel subscriptions there.
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
  const { canEdit, isAdmin } = useApp();
  const [details, setDetails] = useState(false);
  const [linking, setLinking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [pending, start] = useTransition();
  const several = accounts.length > 1;

  const subs = customers.flatMap((c) => c.subscriptions.map((s) => ({ ...s, customer: c })));
  const live = subs.filter(isLive);
  const currency = live[0]?.currency ?? customers[0]?.customer.currency ?? customers[0]?.invoices[0]?.currency ?? "usd";
  const running = live.filter((s) => s.status !== "paused");
  const discount = running.reduce((t, s) => t + s.discount, 0);
  const monthly = running.reduce((t, s) => t + s.monthly, 0) - discount;
  const collectedYear = customers.reduce((t, c) => t + c.collectedYear, 0);
  const credit = customers.reduce((t, c) => t + Math.max(0, -c.customer.balance), 0);
  const overdue = customers.flatMap((c) => overdueOf(c.invoices));
  const overdueOwed = sum(overdue);
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
        {isAdmin && customers.length ? (
          <MenuItem icon={<PlusIcon />} onSelect={() => setCreating(true)}>
            Start a subscription
          </MenuItem>
        ) : null}
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
          <dl className="grid grid-cols-3 gap-x-3">
            <Stat label="Subscriptions" value={running.length ? `${money(monthly, currency)}/mo` : "None"} note={discount ? `${money(discount, currency)}/mo off` : undefined} />
            <Stat label="Overdue invoices" value={money(overdueOwed, currency)} tone={overdueOwed ? "error" : undefined} note={overdue.length ? `${overdue.length} invoice${overdue.length === 1 ? "" : "s"}` : undefined} />
            <Stat label="Collected LTM" value={money(collectedYear, currency)} />
          </dl>
          {credit ? <p className="text-[11.5px] text-muted tabular-nums">{money(credit, currency)} credit on account</p> : null}
          {delinquent ? <p className="text-[12px] text-error">Stripe marks a customer here as delinquent: a recent payment failed.</p> : null}

          {live.length ? (
            <ul className="flex flex-col gap-1.5">
              {live.slice(0, 6).map((s) => (
                <li key={`${s.customer.account}:${s.id}`} className="text-[12.5px]">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 truncate font-medium text-primary">{subName(s)}</span>
                    <SubBadge s={s} />
                  </div>
                  <p className="truncate text-[11.5px] text-muted tabular-nums">{[priceOf(s), netOf(s), whenOf(s)].filter(Boolean).join(" · ")}</p>
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
      {details ? <BillingDetails clientId={clientId} customers={customers} several={several} canEdit={canEdit} isAdmin={isAdmin} onClose={() => setDetails(false)} /> : null}
      {creating ? <NewSubscriptionDialog clientId={clientId} customers={customers} onClose={() => setCreating(false)} /> : null}
      {linking ? <StripeLinker clientId={clientId} suggest={suggest} several={several} onClose={() => setLinking(false)} /> : null}
    </SideCard>
  );
}

function Block({ title, count, action, children }: { title: string; count?: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-[11.5px] font-semibold tracking-wide text-muted uppercase">
          {title}
          {count ? <span className="ml-1 font-medium tabular-nums">{count}</span> : null}
        </h4>
        {action}
      </div>
      {children}
    </section>
  );
}

/** One subscription as a card: what it is, what it bills, when it started and ends, and what an admin can do with it. */
function SubscriptionCard({ s, c, isAdmin, onEdit, onCancel, onKeep, busy }: { s: Sub; c: CustomerBilling; isAdmin: boolean; onEdit: () => void; onCancel: () => void; onKeep: () => void; busy: boolean }) {
  const ends = cancelsAt(s);
  const ended = isEnded(s);
  const url = c.dashboardUrl.replace(/customers\/[^/]+$/, `subscriptions/${s.id}`);
  const method = s.collection === "send_invoice" ? `Invoiced, due in ${s.daysUntilDue ?? 30} days` : (() => {
    const m = c.paymentMethods?.find((x) => (s.paymentMethod ? x.id === s.paymentMethod : x.isDefault));
    return m ? `Charges ${m.label}` : "Charges automatically";
  })();
  return (
    <li className={clsx("flex flex-col gap-2 rounded-xl border p-3.5 text-[13px]", ended ? "border-line bg-sunken/60" : ends ? "border-warning-border" : "border-line")}>
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className={clsx("min-w-0 font-semibold break-words", ended ? "text-secondary" : "text-primary")}>{subName(s, true)}</span>
          <SubBadge s={s} />
        </div>
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className="-mt-0.5 -mr-1 rounded p-1 text-faint hover:text-primary" aria-label={`More for ${subName(s)}`} disabled={busy}>
              <EllipsisHorizontalIcon className="size-4" />
            </button>
          </MenuTrigger>
          <MenuContent className="w-52">
            {isAdmin && !ended ? (
              <>
                <MenuItem icon={<PencilSquareIcon />} onSelect={onEdit}>
                  Change subscription
                </MenuItem>
                {ends ? (
                  <MenuItem icon={<ArrowPathIcon />} onSelect={onKeep}>
                    Keep subscription
                  </MenuItem>
                ) : null}
                <MenuItem icon={<XCircleIcon />} destructive onSelect={onCancel}>
                  {ends ? "Cancel now instead" : "Cancel subscription"}
                </MenuItem>
                <MenuSeparator />
              </>
            ) : null}
            <MenuItem icon={<ArrowTopRightOnSquareIcon />} onSelect={() => window.open(url, "_blank", "noopener,noreferrer")}>
              Open in Stripe
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>

      <div className="tabular-nums">
        <p className={clsx("text-[15px] font-semibold", ended ? "text-secondary" : "text-primary")}>{priceOf(s) || "Usage based"}</p>
        {s.discount ? <p className="text-[12px] text-muted">{netOf(s)}</p> : null}
      </div>

      <dl className="grid grid-cols-2 gap-2 text-[12px] tabular-nums">
        <div>
          <dt className="text-muted">Started</dt>
          <dd className="text-secondary">{day(s.started)}</dd>
        </div>
        <div>
          <dt className="text-muted">{s.endedAt ? "Ended" : ends ? "Ends" : s.periodEnd ? "Renews" : "Ends"}</dt>
          <dd className={ends && !ended ? "font-medium text-warning" : "text-secondary"}>{s.endedAt ? day(s.endedAt) : ends ? day(ends) : s.periodEnd ? day(s.periodEnd) : "—"}</dd>
        </div>
      </dl>

      {s.status === "trialing" && s.trialEnd ? <p className="text-[12px] text-info">Free trial until {day(s.trialEnd)}</p> : null}
      {!ended ? <p className="truncate text-[12px] text-muted">{method}</p> : null}

      {ends && !ended ? (
        <div className="mt-auto flex flex-wrap items-center justify-between gap-2 rounded-lg bg-warning-surface px-2.5 py-2 text-[12px] text-warning">
          <span>Set to cancel on {day(ends)}. Nothing more is billed.</span>
          {isAdmin ? (
            <Button size="sm" variant="outline" className="h-7" onClick={onKeep} loading={busy}>
              Keep it
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

type HistoryRow = {
  id: string;
  kind: "invoice" | "payment";
  created: number;
  title: string;
  detail: ReactNode;
  status: { label: string; tone: Tone } | null;
  amount: number;
  owed: number | null;
  currency: string;
  links: { label: string; href: string }[];
};

const invoiceStatus = (i: CustomerBilling["invoices"][number]): HistoryRow["status"] => {
  if (!i.status) return null;
  if (i.status === "open") return i.overdue ? { label: "Overdue", tone: "error" } : { label: "Unpaid", tone: "warning" };
  return { paid: { label: "Paid", tone: "success" as Tone }, void: { label: "Void", tone: "neutral" as Tone }, uncollectible: { label: "Uncollectible", tone: "error" as Tone }, draft: { label: "Draft", tone: "neutral" as Tone } }[i.status];
};

const paymentStatus = (x: CustomerBilling["charges"][number]): HistoryRow["status"] =>
  x.status === "failed"
    ? { label: "Failed", tone: "error" }
    : x.status === "pending"
      ? { label: "Pending", tone: "warning" }
      : x.refunded
        ? { label: "Refunded", tone: "neutral" }
        : x.refundedAmount
          ? { label: "Partly refunded", tone: "neutral" }
          : { label: "Succeeded", tone: "success" };

/** Invoices and payments in one list, newest first. */
function historyOf(c: CustomerBilling): HistoryRow[] {
  const invoices = c.invoices.map(
    (i): HistoryRow => ({
      id: i.id,
      kind: "invoice",
      created: i.created,
      title: i.number ?? "Invoice",
      detail: [i.discount ? `${money(i.discount, i.currency)} off` : null, i.status === "open" && i.dueDate ? `due ${day(i.dueDate)}` : null].filter(Boolean).join(" · "),
      status: invoiceStatus(i),
      amount: i.total,
      owed: i.remaining || null,
      currency: i.currency,
      links: [i.url ? { label: "View", href: i.url } : null, i.pdf ? { label: "PDF", href: i.pdf } : null].filter((l): l is { label: string; href: string } => !!l),
    }),
  );
  const payments = c.charges.map(
    (x): HistoryRow => ({
      id: x.id,
      kind: "payment",
      created: x.created,
      title: x.method ?? "Payment",
      detail: x.status === "failed" && x.failure ? <span className="text-error">{x.failure}</span> : (x.description ?? ""),
      status: paymentStatus(x),
      amount: x.amount,
      owed: null,
      currency: x.currency,
      links: x.receipt ? [{ label: "Receipt", href: x.receipt }] : [],
    }),
  );
  return [...invoices, ...payments].sort((a, b) => b.created - a.created);
}

/** Everything about each customer: who they are in Stripe, every subscription, saved cards and payment methods, and their billing history. */
function BillingDetails({ clientId, customers, several, canEdit, isAdmin, onClose }: { clientId: string; customers: CustomerBilling[]; several: boolean; canEdit: boolean; isAdmin: boolean; onClose: () => void }) {
  const [shown, setShown] = useState(0);
  const [allHistory, setAllHistory] = useState(false);
  const [editing, setEditing] = useState<Sub | null>(null);
  const [canceling, setCanceling] = useState<Sub | null>(null);
  const [creating, setCreating] = useState(false);
  const [keeping, setKeeping] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const index = Math.min(shown, customers.length - 1);
  const c = customers[index];
  const label = (x: CustomerBilling) => x.customer.name ?? x.customer.email ?? x.customer.id;
  const history = historyOf(c);
  const rows = allHistory ? history : history.slice(0, 15);
  const currency = c.customer.currency ?? c.invoices[0]?.currency ?? null;
  const open = c.invoices.filter((i) => i.status === "open");
  const overdue = overdueOf(c.invoices);
  const subs = [...c.subscriptions.filter((s) => !isEnded(s)), ...c.subscriptions.filter(isEnded)];

  const remove = () =>
    start(async () => {
      if (!confirm(`Take ${label(c)} off this client? Their billing stops showing here until someone links them again.`)) return;
      const r = await removeStripeCustomer(clientId, c.account, c.customer.id);
      if (!r.ok) return void toast.error(r.error);
      toast.success("Customer taken off this client");
      onClose();
    });
  const keep = (s: Sub) =>
    start(async () => {
      setKeeping(s.id);
      const r = await keepStripeSubscription(clientId, { account: c.account, subscriptionId: s.id, requestKey: crypto.randomUUID() });
      setKeeping(null);
      if (!r.ok) return void toast.error(r.error);
      toast.success(`${subName(s)} won't cancel${s.periodEnd ? `. It renews on ${day(s.periodEnd)}` : ""}`);
    });

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Billing"
      description={isAdmin ? "Read from Stripe just now; collected totals are from the last sync. Changes you make here happen in Stripe straight away." : "Read from Stripe just now; collected totals are from the last sync. Only admins can change billing."}
      size="xl"
    >
      {customers.length > 1 ? (
        <div className="mb-4 flex flex-wrap gap-1" role="tablist" aria-label="Stripe customers">
          {customers.map((x, i) => (
            <button
              key={`${x.account}:${x.customer.id}`}
              type="button"
              role="tab"
              aria-selected={i === index}
              onClick={() => {
                setShown(i);
                setAllHistory(false);
              }}
              className={i === index ? "rounded-full bg-accent px-3 py-1 text-[12.5px] font-medium text-accent-foreground" : "rounded-full bg-sunken px-3 py-1 text-[12.5px] font-medium text-secondary hover:text-primary"}
            >
              {label(x)}
              {several ? <span className="opacity-70"> · {x.accountLabel}</span> : null}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-4">
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-semibold text-primary">{label(c)}</p>
              <p className="text-[12.5px] text-muted">{[c.customer.email, several ? c.accountLabel : null, `Customer since ${day(c.customer.created)}`].filter(Boolean).join(" · ")}</p>
              <p className="text-[12px] text-faint">{c.byHand ? "Linked by hand" : c.matchedEmail ? `Matched on ${c.matchedEmail}` : ""}</p>
            </div>
            <span className="flex shrink-0 items-center gap-1">
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
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border border-line px-4 py-3 sm:grid-cols-5">
            <Stat label="Collected LTM" value={money(c.collectedYear, currency)} />
            <Stat label="Last 30 days" value={money(c.collectedMonth, currency)} />
            <Stat label={c.customer.balance < 0 ? "Credit" : "Balance"} value={money(Math.abs(c.customer.balance), currency)} />
            <Stat label="Open invoices" value={money(sum(open), currency)} note={open.length ? `${open.length} unpaid` : undefined} tone={sum(open) ? "warning" : undefined} />
            <Stat label="Overdue invoices" value={money(sum(overdue), currency)} note={overdue.length ? `${overdue.length} past due` : undefined} tone={sum(overdue) ? "error" : undefined} />
          </dl>
        </header>
        {c.customer.delinquent ? <p className="text-[12.5px] text-error">Stripe marks this customer as delinquent: a recent payment failed.</p> : null}

        <Block
          title="Subscriptions"
          count={c.subscriptions.length}
          action={
            isAdmin ? (
              <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
                <PlusIcon />
                New subscription
              </Button>
            ) : null
          }
        >
          {subs.length ? (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {subs.map((s) => (
                <SubscriptionCard key={s.id} s={s} c={c} isAdmin={isAdmin} busy={pending && keeping === s.id} onEdit={() => setEditing(s)} onCancel={() => setCanceling(s)} onKeep={() => keep(s)} />
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
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
              {c.paymentMethods.map((m) => (
                <PaymentCard key={m.id} m={m} />
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">Nothing saved.</p>
          )}
        </Block>

        <Block title="Invoices and payments" count={history.length}>
          {history.length ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[13px]">
                  <thead className="text-[11.5px] text-muted">
                    <tr>
                      <th className="py-1 pr-3 font-medium">Date</th>
                      <th className="py-1 pr-3 font-medium">Type</th>
                      <th className="py-1 pr-3 font-medium">Details</th>
                      <th className="py-1 pr-3 font-medium">Status</th>
                      <th className="py-1 pr-3 text-right font-medium">Amount</th>
                      <th className="py-1 pr-3 text-right font-medium">Owed</th>
                      <th className="py-1 font-medium">
                        <span className="sr-only">Links</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td className="py-1.5 pr-3 whitespace-nowrap text-muted tabular-nums">{day(r.created)}</td>
                        <td className="py-1.5 pr-3 whitespace-nowrap">
                          <span className="inline-flex items-center gap-1 text-[12px] font-medium text-secondary">
                            {r.kind === "invoice" ? <DocumentTextIcon className="size-3.5 text-faint" aria-hidden /> : <BanknotesIcon className="size-3.5 text-faint" aria-hidden />}
                            {r.kind === "invoice" ? "Invoice" : "Payment"}
                          </span>
                        </td>
                        <td className="max-w-72 py-1.5 pr-3">
                          <span className="block truncate text-secondary">{r.title}</span>
                          {r.detail ? <span className="block truncate text-[12px] text-muted">{r.detail}</span> : null}
                        </td>
                        <td className="py-1.5 pr-3">{r.status ? <StatusBadge tone={r.status.tone}>{r.status.label}</StatusBadge> : null}</td>
                        <td className="py-1.5 pr-3 text-right text-primary tabular-nums">{money(r.amount, r.currency)}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{r.owed ? money(r.owed, r.currency) : <span className="text-faint">—</span>}</td>
                        <td className="py-1.5 text-right whitespace-nowrap">
                          {r.links.map((l, i) => (
                            <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer" className={clsx("text-[12.5px] text-secondary underline-offset-2 hover:underline", i && "ml-3")}>
                              {l.label}
                            </a>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {history.length > rows.length ? (
                <Button size="sm" variant="ghost" className="mt-1 -ml-2 text-muted" onClick={() => setAllHistory(true)}>
                  Show all {history.length}
                </Button>
              ) : null}
              {c.invoices.length >= 60 || c.charges.length >= 25 ? <p className="mt-1 text-[12px] text-muted">The latest 60 invoices and 25 payments. Open the customer in Stripe for older ones.</p> : null}
            </>
          ) : (
            <p className="text-[13px] text-muted">No invoices or payments yet.</p>
          )}
        </Block>
      </div>

      {editing ? <EditSubscriptionDialog clientId={clientId} customer={c} s={editing} onClose={() => setEditing(null)} /> : null}
      {canceling ? <CancelSubscriptionDialog clientId={clientId} customer={c} s={canceling} onClose={() => setCanceling(null)} /> : null}
      {creating ? <NewSubscriptionDialog clientId={clientId} customers={customers} initial={index} onClose={() => setCreating(false)} /> : null}
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
