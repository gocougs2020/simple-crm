"use client";

import { useState, useTransition, type ReactNode } from "react";
import clsx from "clsx";
import { ArrowPathIcon, ArrowTopRightOnSquareIcon, BanknotesIcon, CalendarDaysIcon, DocumentTextIcon, EllipsisHorizontalIcon, LinkIcon, PencilSquareIcon, PlusIcon, XCircleIcon } from "@heroicons/react/20/solid";
import { keepStripeSubscription } from "@/actions/billing";
import { Segmented } from "@/components/activity/composer";
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
import { ProductNames } from "./product-tag";

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
                    <span className="min-w-0 truncate font-medium text-primary">
                      <ProductNames names={s.items.map((i) => i.name)} />
                    </span>
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

/** How a subscription is paid: "Charges Visa ···· 4242", or "Invoiced, due in 30 days". */
function methodOf(s: Sub, c: CustomerBilling) {
  if (s.collection === "send_invoice") return `Invoiced, due in ${s.daysUntilDue ?? 30} days`;
  const m = c.paymentMethods?.find((x) => (s.paymentMethod ? x.id === s.paymentMethod : x.isDefault));
  return m ? `Charges ${m.label}` : "Charges automatically";
}

/** "Next charge", or "First charge" at the end of a trial, or "Next invoice" for one that's invoiced. */
const nextLabel = (s: Sub) => (s.collection === "send_invoice" ? "Next invoice" : s.status === "trialing" ? "First charge" : "Next charge");
/** The next charge's amount, or what's left to work out when part of it is usage based. */
const nextAmount = (s: Sub) => (!s.next ? "" : s.next.amount == null ? "Usage based" : `${money(s.next.amount, s.currency)}${s.next.partial ? " + usage" : ""}`);

/** One subscription as a card: what it is, what it bills, when it started and ends, when it bills next, and what an admin can do with it. */
function SubscriptionCard({ s, c, owner, isAdmin, onEdit, onCancel, onKeep, busy }: { s: Sub; c: CustomerBilling; /** Whose it is, when several customers are shown. */ owner?: ReactNode; isAdmin: boolean; onEdit: () => void; onCancel: () => void; onKeep: () => void; busy: boolean }) {
  const ends = cancelsAt(s);
  const ended = isEnded(s);
  const url = c.dashboardUrl.replace(/customers\/[^/]+$/, `subscriptions/${s.id}`);
  const method = methodOf(s, c);
  return (
    <li className={clsx("flex flex-col gap-2 rounded-xl border p-3.5 text-[13px]", ended ? "border-line bg-sunken/60" : ends ? "border-warning-border" : "border-line")}>
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className={clsx("min-w-0 font-semibold break-words", ended ? "text-secondary" : "text-primary")}>
            <ProductNames names={s.items.map((i) => (i.quantity > 1 ? `${i.name} × ${i.quantity}` : i.name))} />
          </span>
          <SubBadge s={s} />
          {owner ? <span className="w-full min-w-0">{owner}</span> : null}
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

      {s.next ? (
        <div className="flex items-center gap-2 rounded-lg bg-sunken px-2.5 py-2 text-[12px] tabular-nums">
          <CalendarDaysIcon className="size-3.5 shrink-0 text-faint" aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            <span className="text-muted">{nextLabel(s)} </span>
            <span className="font-medium text-primary">{day(s.next.at)}</span>
          </span>
          <span className="shrink-0 font-semibold text-primary">{nextAmount(s)}</span>
        </div>
      ) : null}
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
  kind: "invoice" | "payment" | "scheduled";
  /** Which of the invoices and payments views it shows in. A scheduled charge makes an invoice, and a payment when it's charged automatically. */
  shows: HistoryView[];
  created: number;
  title: string;
  detail: ReactNode;
  status: { label: string; tone: Tone } | null;
  /** Null for a scheduled charge that's all usage based. */
  amount: number | null;
  owed: number | null;
  currency: string;
  links: { label: string; href: string }[];
  /** The Stripe customer it belongs to. */
  owner: CustomerBilling;
};

type HistoryView = "all" | "invoice" | "payment";
const historyViews: { value: HistoryView; label: string }[] = [
  { value: "all", label: "All" },
  { value: "invoice", label: "Invoices" },
  { value: "payment", label: "Payments" },
];
const kindLabel: Record<HistoryRow["kind"], string> = { invoice: "Invoice", payment: "Payment", scheduled: "Scheduled" };

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

/** What an invoice was for: its products ("Pro, Extra seats × 3"), else its memo. */
const invoiceFor = (i: CustomerBilling["invoices"][number]) => (i.items.length ? `${i.items.join(", ")}${i.moreItems ? " and more" : ""}` : i.memo);

/** Invoices and payments in one list, newest first. */
function historyOf(c: CustomerBilling): HistoryRow[] {
  const byId = new Map(c.invoices.map((i) => [i.id, i]));
  const invoices = c.invoices.map(
    (i): HistoryRow => ({
      id: i.id,
      kind: "invoice",
      shows: ["all", "invoice"],
      created: i.created,
      title: invoiceFor(i) ?? i.number ?? "Invoice",
      // The invoice number stays, under what it was for.
      detail: [invoiceFor(i) ? i.number : null, i.discount ? `${money(i.discount, i.currency)} off` : null, i.status === "open" && i.dueDate ? `due ${day(i.dueDate)}` : null].filter(Boolean).join(" · "),
      status: invoiceStatus(i),
      amount: i.total,
      owed: i.remaining || null,
      currency: i.currency,
      links: [i.url ? { label: "View", href: i.url } : null, i.pdf ? { label: "PDF", href: i.pdf } : null].filter((l): l is { label: string; href: string } => !!l),
      owner: c,
    }),
  );
  const payments = c.charges.map((x): HistoryRow => {
    const paid = x.invoice ? byId.get(x.invoice) : undefined;
    // A payment for an invoice says what the invoice was for, with the card under it.
    const forWhat = paid ? invoiceFor(paid) : null;
    return {
      id: x.id,
      kind: "payment",
      shows: ["all", "payment"],
      created: x.created,
      title: forWhat ?? x.method ?? "Payment",
      detail:
        x.status === "failed" && x.failure ? (
          <span className="text-error">{x.failure}</span>
        ) : paid ? (
          [paid.number, forWhat ? x.method : null].filter(Boolean).join(" · ")
        ) : (
          (x.description ?? "")
        ),
      status: paymentStatus(x),
      amount: x.amount,
      owed: null,
      currency: x.currency,
      links: x.receipt ? [{ label: "Receipt", href: x.receipt }] : [],
      owner: c,
    };
  });
  return [...invoices, ...payments];
}

/**
 * The next charge of each subscription still billing, for the top of the
 * history. Worked out from the subscription, so they're estimates: nothing
 * is scheduled in Stripe until the invoice is made.
 */
function scheduledOf(c: CustomerBilling): HistoryRow[] {
  const credit = Math.max(0, -c.customer.balance);
  return c.subscriptions
    .filter((s) => s.next)
    .map((s): HistoryRow => {
      const next = s.next!;
      return {
        id: `next:${s.id}`,
        kind: "scheduled",
        shows: s.collection === "send_invoice" ? ["all", "invoice"] : ["all", "invoice", "payment"],
        created: next.at,
        title: subName(s, true),
        detail: [`${nextLabel(s)} · ${methodOf(s, c)}`, next.partial ? "plus usage" : null, credit ? `${money(credit, c.customer.currency ?? s.currency)} credit applies first` : null].filter(Boolean).join(" · "),
        status: { label: "Scheduled", tone: "info" },
        amount: next.amount,
        owed: null,
        currency: s.currency,
        links: [],
        owner: c,
      };
    });
}

const customerKey = (c: CustomerBilling) => `${c.account}:${c.customer.id}`;
/** What a customer is called where several are shown together: the billing email, which is how they were matched. */
const customerEmail = (c: CustomerBilling) => c.customer.email ?? c.customer.name ?? c.customer.id;

/** The Stripe customer something belongs to, on subscriptions, cards and rows when the client has several. */
function OwnerTag({ c, several }: { c: CustomerBilling; several: boolean }) {
  return (
    <span className="block truncate text-[11.5px] text-muted" title={customerEmail(c)}>
      {customerEmail(c)}
      {several ? <span className="text-faint"> · {c.accountLabel}</span> : null}
    </span>
  );
}

/** One Stripe customer: who they are, how they were matched, and opening or removing them. */
function CustomerRow({ clientId, c, several, canEdit, onRemoved }: { clientId: string; c: CustomerBilling; several: boolean; canEdit: boolean; onRemoved: () => void }) {
  const [pending, start] = useTransition();
  const label = c.customer.name ?? c.customer.email ?? c.customer.id;
  const remove = () =>
    start(async () => {
      if (!confirm(`Take ${label} off this client? Their billing stops showing here until someone links them again.`)) return;
      const r = await removeStripeCustomer(clientId, c.account, c.customer.id);
      if (!r.ok) return void toast.error(r.error);
      toast.success("Customer taken off this client");
      onRemoved();
    });
  return (
    <li className="flex items-start gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-semibold text-primary">{label}</p>
        <p className="text-[12.5px] break-words text-muted">{[c.customer.email && c.customer.email !== label ? c.customer.email : null, several ? c.accountLabel : null, `Customer since ${day(c.customer.created)}`].filter(Boolean).join(" · ")}</p>
        <p className="text-[12px] text-faint">{c.byHand ? "Linked by hand" : c.matchedEmail ? `Matched on ${c.matchedEmail}` : ""}</p>
        {c.customer.delinquent ? <p className="mt-1 text-[12.5px] text-error">Stripe marks this customer as delinquent: a recent payment failed.</p> : null}
      </div>
      <span className="flex shrink-0 items-center gap-1">
        <a href={c.dashboardUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12.5px] font-medium text-secondary hover:bg-sunken hover:text-primary">
          Open in Stripe
          <ArrowTopRightOnSquareIcon className="size-3.5" />
        </a>
        {canEdit ? (
          <Menu>
            <MenuTrigger asChild>
              <button type="button" className="rounded p-1 text-faint hover:text-primary" aria-label={`More for ${label}`} disabled={pending}>
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
    </li>
  );
}

/**
 * Everything Stripe has on this client, every matched customer merged: who
 * they are, every subscription, saved cards and payment methods, and the
 * billing history. With several customers, each item says whose it is and a
 * switch at the top narrows it all to one.
 */
function BillingDetails({ clientId, customers, several, canEdit, isAdmin, onClose }: { clientId: string; customers: CustomerBilling[]; several: boolean; canEdit: boolean; isAdmin: boolean; onClose: () => void }) {
  const [filter, setFilter] = useState("all");
  const [allHistory, setAllHistory] = useState(false);
  const [view, setView] = useState<HistoryView>("all");
  const [editing, setEditing] = useState<{ s: Sub; c: CustomerBilling } | null>(null);
  const [canceling, setCanceling] = useState<{ s: Sub; c: CustomerBilling } | null>(null);
  const [creating, setCreating] = useState(false);
  const [keeping, setKeeping] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const many = customers.length > 1;
  // A customer taken off the client falls back to all of them.
  const one = customers.find((c) => customerKey(c) === filter) ?? null;
  const shown = one ? [one] : customers;
  // Whose each thing is, only while more than one customer is in view.
  const tagged = many && !one;

  const history = shown.flatMap(historyOf).sort((a, b) => b.created - a.created);
  const scheduled = shown
    .flatMap(scheduledOf)
    .filter((r) => r.shows.includes(view))
    .sort((a, b) => a.created - b.created);
  const past = history.filter((r) => r.shows.includes(view));
  const rows = [...scheduled, ...(allHistory ? past : past.slice(0, 15))];
  // Each customer's default card or bank account comes first.
  const methods = shown.flatMap((c) => [...(c.paymentMethods ?? [])].sort((a, b) => Number(b.isDefault) - Number(a.isDefault)).map((m) => ({ m, c })));
  const unreadable = shown.filter((c) => c.paymentMethods === null).length;
  const currency = shown.map((c) => c.customer.currency ?? c.invoices[0]?.currency).find(Boolean) ?? null;
  const invoices = shown.flatMap((c) => c.invoices);
  const open = invoices.filter((i) => i.status === "open");
  const overdue = overdueOf(invoices);
  const balance = shown.reduce((t, c) => t + c.customer.balance, 0);
  const subs = shown.flatMap((c) => c.subscriptions.map((s) => ({ s, c })));
  const ordered = [...subs.filter(({ s }) => !isEnded(s)), ...subs.filter(({ s }) => isEnded(s))];
  const truncated = shown.some((c) => c.invoices.length >= 60 || c.charges.length >= 25);

  const pick = (key: string) => {
    setFilter(key);
    setAllHistory(false);
  };
  const keep = (s: Sub, c: CustomerBilling) =>
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
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-4">
          {many ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-medium text-muted">Stripe customer</span>
              <div className="max-w-full overflow-x-auto scroll-thin">
                <Segmented value={one ? filter : "all"} onChange={pick} options={[{ value: "all", label: `All ${customers.length}` }, ...customers.map((c) => ({ value: customerKey(c), label: customerEmail(c) }))]} />
              </div>
            </div>
          ) : null}
          <ul className="divide-y divide-line rounded-xl border border-line">
            {shown.map((c) => (
              <CustomerRow key={customerKey(c)} clientId={clientId} c={c} several={several} canEdit={canEdit} onRemoved={() => (customers.length === 1 ? onClose() : pick("all"))} />
            ))}
          </ul>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border border-line px-4 py-3 sm:grid-cols-5">
            <Stat label="Collected LTM" value={money(shown.reduce((t, c) => t + c.collectedYear, 0), currency)} />
            <Stat label="Last 30 days" value={money(shown.reduce((t, c) => t + c.collectedMonth, 0), currency)} />
            <Stat label={balance < 0 ? "Credit" : "Balance"} value={money(Math.abs(balance), currency)} />
            <Stat label="Open invoices" value={money(sum(open), currency)} note={open.length ? `${open.length} unpaid` : undefined} tone={sum(open) ? "warning" : undefined} />
            <Stat label="Overdue invoices" value={money(sum(overdue), currency)} note={overdue.length ? `${overdue.length} past due` : undefined} tone={sum(overdue) ? "error" : undefined} />
          </dl>
        </header>

        <Block
          title="Subscriptions"
          count={subs.length}
          action={
            isAdmin ? (
              <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
                <PlusIcon />
                New subscription
              </Button>
            ) : null
          }
        >
          {ordered.length ? (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {ordered.map(({ s, c }) => (
                <SubscriptionCard
                  key={`${c.account}:${s.id}`}
                  s={s}
                  c={c}
                  owner={tagged ? <OwnerTag c={c} several={several} /> : null}
                  isAdmin={isAdmin}
                  busy={pending && keeping === s.id}
                  onEdit={() => setEditing({ s, c })}
                  onCancel={() => setCanceling({ s, c })}
                  onKeep={() => keep(s, c)}
                />
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">No subscriptions. They may be billed with one-off invoices.</p>
          )}
        </Block>

        <Block title="Saved cards and payment methods" count={methods.length}>
          {unreadable === shown.length ? (
            <p className="text-[13px] text-muted">This Stripe key can&apos;t read payment methods. Give it read access to Payment Methods to see saved cards here.</p>
          ) : methods.length ? (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
              {methods.map(({ m, c }) => (
                <PaymentCard key={`${c.account}:${m.id}`} m={m} owner={tagged ? `${customerEmail(c)}${several ? ` · ${c.accountLabel}` : ""}` : null} />
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">Nothing saved.</p>
          )}
          {unreadable && unreadable < shown.length ? <p className="mt-2 text-[12px] text-muted">The Stripe key for {unreadable === 1 ? "one customer" : `${unreadable} customers`} can&apos;t read payment methods, so their saved cards aren&apos;t shown.</p> : null}
        </Block>

        <Block title="Invoices and payments" count={history.length} action={history.length || scheduled.length ? <Segmented value={view} onChange={setView} options={historyViews} /> : null}>
          {rows.length ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[13px]">
                  <thead className="text-[11.5px] text-muted">
                    <tr>
                      <th className="py-1 pr-3 font-medium">Date</th>
                      <th className="py-1 pr-3 font-medium">Type</th>
                      <th className="py-1 pr-3 font-medium">Details</th>
                      {tagged ? <th className="py-1 pr-3 font-medium">Customer</th> : null}
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
                      <tr key={`${r.owner.account}:${r.id}`} className={r.kind === "scheduled" ? "bg-info-surface/50" : undefined}>
                        <td className="py-1.5 pr-3 align-top whitespace-nowrap text-muted tabular-nums">{day(r.created)}</td>
                        <td className="py-1.5 pr-3 align-top whitespace-nowrap">
                          <span className="inline-flex items-center gap-1 text-[12px] font-medium text-secondary">
                            {r.kind === "invoice" ? <DocumentTextIcon className="size-3.5 text-faint" aria-hidden /> : r.kind === "payment" ? <BanknotesIcon className="size-3.5 text-faint" aria-hidden /> : <CalendarDaysIcon className="size-3.5 text-info" aria-hidden />}
                            {kindLabel[r.kind]}
                          </span>
                        </td>
                        <td className="max-w-64 min-w-44 py-1.5 pr-3 align-top">
                          <span className="line-clamp-2 break-words text-secondary" title={r.title}>
                            {r.title}
                          </span>
                          {r.detail ? <span className="block truncate text-[12px] text-muted">{r.detail}</span> : null}
                        </td>
                        {tagged ? (
                          <td className="max-w-40 py-1.5 pr-3 align-top">
                            <OwnerTag c={r.owner} several={several} />
                          </td>
                        ) : null}
                        <td className="py-1.5 pr-3 align-top">{r.status ? <StatusBadge tone={r.status.tone}>{r.status.label}</StatusBadge> : null}</td>
                        <td className="py-1.5 pr-3 text-right align-top text-primary tabular-nums">{r.amount == null ? <span className="text-muted">Usage based</span> : money(r.amount, r.currency)}</td>
                        <td className="py-1.5 pr-3 text-right align-top tabular-nums">{r.owed ? money(r.owed, r.currency) : <span className="text-faint">—</span>}</td>
                        <td className="py-1.5 text-right align-top whitespace-nowrap">
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
              {scheduled.length ? <p className="mt-1.5 text-[12px] text-muted">Scheduled charges are worked out from each subscription&apos;s period, price and discount. Tax and usage aren&apos;t included until Stripe makes the invoice.</p> : null}
              {past.length > rows.length - scheduled.length ? (
                <Button size="sm" variant="ghost" className="mt-1 -ml-2 text-muted" onClick={() => setAllHistory(true)}>
                  Show all {past.length}
                </Button>
              ) : null}
              {truncated ? <p className="mt-1 text-[12px] text-muted">The latest 60 invoices and 25 payments{many ? " of each customer" : ""}. Open the customer in Stripe for older ones.</p> : null}
            </>
          ) : (
            <p className="text-[13px] text-muted">{history.length ? `No ${view === "invoice" ? "invoices" : "payments"} yet. Switch to All to see everything.` : "No invoices or payments yet."}</p>
          )}
        </Block>
      </div>

      {editing ? <EditSubscriptionDialog clientId={clientId} customer={editing.c} s={editing.s} onClose={() => setEditing(null)} /> : null}
      {canceling ? <CancelSubscriptionDialog clientId={clientId} customer={canceling.c} s={canceling.s} onClose={() => setCanceling(null)} /> : null}
      {creating ? <NewSubscriptionDialog clientId={clientId} customers={customers} initial={one ? customers.indexOf(one) : 0} onClose={() => setCreating(false)} /> : null}
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
