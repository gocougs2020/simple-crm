"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import clsx from "clsx";
import { billingPrices, cancelStripeSubscription, createStripeSubscription, updateStripeSubscription } from "@/actions/billing";
import { Button, Spinner } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { per, prorationLabels, toCents, type Collection, type Proration } from "@/lib/stripe/changes";
import type { CustomerBilling, StripePriceOption } from "@/lib/stripe/types";
import { cancelsAt, day, everyWord, money, priceOf, subName, type Sub } from "./billing-shared";

/**
 * The dialogs that change a client's billing in Stripe: start a subscription,
 * change one, cancel one. Only admins see them, and the server checks again
 * (src/actions/billing.ts). Each says in plain words what will happen before
 * anything is sent.
 */

const newKey = () => crypto.randomUUID();
const dollars = (cents: number | null | undefined) => (cents == null ? "" : (cents / 100).toFixed(cents % 100 ? 2 : 0));
const customerLabel = (c: CustomerBilling) => c.customer.name ?? c.customer.email ?? c.customer.id;
const priceLabel = (p: StripePriceOption) => `${p.nickname ? `${p.nickname} · ` : ""}${money(p.unitAmount, p.currency)}${per(p.interval, p.intervalCount)}`;

/** The recurring prices of one Stripe account, read when a dialog opens. */
function usePrices(account: string) {
  const [state, setState] = useState<{ account: string; prices: StripePriceOption[] | null; error: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    billingPrices(account).then((r) => {
      if (live) setState({ account, prices: r.ok ? r.data : null, error: r.ok ? null : r.error });
    });
    return () => {
      live = false;
    };
  }, [account]);
  const loading = !state || state.account !== account;
  return { loading, prices: loading ? null : state.prices, error: loading ? null : state.error };
}

/** Prices grouped by product, for a <select> with an <optgroup> per product. */
function PlanOptions({ prices, extra }: { prices: StripePriceOption[]; extra?: { value: string; label: string } | null }) {
  const groups = new Map<string, StripePriceOption[]>();
  for (const p of prices) groups.set(p.productName, [...(groups.get(p.productName) ?? []), p]);
  return (
    <>
      {extra ? <option value={extra.value}>{extra.label}</option> : null}
      {[...groups].map(([name, list]) => (
        <optgroup key={name} label={name}>
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {name} — {priceLabel(p)}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

/** How they pay: Stripe charges a saved method by itself, or sends an invoice to pay. */
function PaymentFields({
  methods,
  collection,
  setCollection,
  method,
  setMethod,
  days,
  setDays,
}: {
  methods: CustomerBilling["paymentMethods"];
  collection: Collection;
  setCollection: (c: Collection) => void;
  method: string;
  setMethod: (m: string) => void;
  days: string;
  setDays: (d: string) => void;
}) {
  const fallback = methods?.find((m) => m.isDefault);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="How they pay">
        {(p) => (
          <Select {...p} value={collection} onChange={(e) => setCollection(e.target.value as Collection)}>
            <option value="charge_automatically" disabled={methods?.length === 0}>
              Charge a saved payment method{methods?.length === 0 ? " (none saved)" : ""}
            </option>
            <option value="send_invoice">Send an invoice to pay</option>
          </Select>
        )}
      </Field>
      {collection === "send_invoice" ? (
        <Field label="Days to pay" hint="How long each invoice gives them before it's overdue.">
          {(p) => <Input {...p} type="number" inputMode="numeric" min={0} max={365} value={days} onChange={(e) => setDays(e.target.value)} />}
        </Field>
      ) : methods?.length ? (
        <Field label="Charge">
          {(p) => (
            <Select {...p} value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="">{fallback ? `Their default (${fallback.label})` : "Their default payment method"}</option>
              {methods.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {m.expires ? ` · ${m.expired ? "expired" : "expires"} ${m.expires}` : ""}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}
    </div>
  );
}

/** What the person is about to do, in one sentence, above the button that does it. */
function Summary({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "warning" }) {
  return <p className={clsx("rounded-lg border px-3 py-2 text-[13px]", tone === "warning" ? "border-warning-border bg-warning-surface text-warning" : "border-line bg-sunken text-secondary")}>{children}</p>;
}

function methodWords(methods: CustomerBilling["paymentMethods"], id: string) {
  const m = id ? methods?.find((x) => x.id === id) : methods?.find((x) => x.isDefault);
  return m ? m.label : "their saved payment method";
}

// ─── Start a subscription ────────────────────────────────────────────────

export function NewSubscriptionDialog({ clientId, customers, initial, onClose }: { clientId: string; customers: CustomerBilling[]; initial?: number; onClose: () => void }) {
  const [shown, setShown] = useState(Math.min(initial ?? 0, customers.length - 1));
  const c = customers[shown];
  const { loading, prices: all, error } = usePrices(c.account);
  // A customer already billed in one currency can only be billed in that one.
  const prices = useMemo(() => all?.filter((p) => !c.customer.currency || p.currency === c.customer.currency) ?? null, [all, c.customer.currency]);
  const [priceId, setPriceId] = useState("");
  const [amount, setAmount] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [collection, setCollection] = useState<Collection>(c.paymentMethods?.length === 0 ? "send_invoice" : "charge_automatically");
  const [method, setMethod] = useState("");
  const [days, setDays] = useState("30");
  const [trial, setTrial] = useState("");
  const [key, setKey] = useState(newKey);
  const [pending, start] = useTransition();

  const price = prices?.find((p) => p.id === priceId) ?? null;
  const cents = toCents(amount);
  const qty = Number(quantity) || 0;
  const trialDays = Number(trial) || 0;
  const ready = !!price && cents != null && qty >= 1;
  const total = ready ? money(cents * qty, price.currency) : "";
  const every = price ? everyWord(price.interval, price.intervalCount) : "";

  const pick = (id: string) => {
    setPriceId(id);
    const p = prices?.find((x) => x.id === id);
    if (p) setAmount(dollars(p.unitAmount));
  };
  const switchCustomer = (i: number) => {
    setShown(i);
    setPriceId("");
    setAmount("");
    setMethod("");
    setCollection(customers[i].paymentMethods?.length === 0 ? "send_invoice" : "charge_automatically");
  };

  const submit = () =>
    start(async () => {
      if (!ready) return;
      const r = await createStripeSubscription(clientId, {
        account: c.account,
        customerId: c.customer.id,
        line: { priceId: price.id, amount: cents, quantity: qty },
        collection,
        daysUntilDue: collection === "send_invoice" ? Number(days) || 0 : null,
        paymentMethod: collection === "charge_automatically" ? method || null : null,
        trialDays: trialDays || null,
        requestKey: key,
      });
      if (!r.ok) {
        setKey(newKey());
        return void toast.error(r.error);
      }
      toast.success(trialDays ? `Subscription started. The free trial ends in ${trialDays} days.` : "Subscription started in Stripe");
      onClose();
    });

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Start a subscription"
      description="Starts in Stripe as soon as you confirm."
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Go back
          </Button>
          <Button variant="primary" onClick={submit} loading={pending} disabled={!ready}>
            Start subscription
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {customers.length > 1 ? (
          <Field label="Stripe customer">
            {(p) => (
              <Select {...p} value={String(shown)} onChange={(e) => switchCustomer(Number(e.target.value))}>
                {customers.map((x, i) => (
                  <option key={`${x.account}:${x.customer.id}`} value={i}>
                    {customerLabel(x)}
                    {x.customer.email && x.customer.name ? ` · ${x.customer.email}` : ""} · {x.accountLabel}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}

        {loading ? (
          <p className="flex items-center gap-2 text-[13px] text-muted">
            <Spinner /> Reading plans from Stripe
          </p>
        ) : error ? (
          <p className="text-[13px] text-error">{error}</p>
        ) : !prices?.length ? (
          <p className="text-[13px] text-muted">
            No recurring prices in {c.accountLabel}
            {c.customer.currency ? ` in ${c.customer.currency.toUpperCase()}` : ""}. Add a product with a recurring price in Stripe, then open this again.
          </p>
        ) : (
          <>
            <Field label="Plan">
              {(p) => (
                <Select {...p} value={priceId} onChange={(e) => pick(e.target.value)}>
                  <option value="" disabled>
                    Pick a plan
                  </option>
                  <PlanOptions prices={prices} />
                </Select>
              )}
            </Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Amount" hint={price && cents !== price.unitAmount ? "A different amount than the plan's, for this client only." : "Change it to bill a different amount."} className="sm:col-span-2">
                {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" disabled={!price} aria-invalid={amount && cents == null ? true : undefined} />}
              </Field>
              <Field label="Quantity">{(p) => <Input {...p} type="number" inputMode="numeric" min={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} />}</Field>
            </div>
            <PaymentFields methods={c.paymentMethods} collection={collection} setCollection={setCollection} method={method} setMethod={setMethod} days={days} setDays={setDays} />
            <Field label="Free trial, in days" optional hint="Nothing is billed until it ends.">
              {(p) => <Input {...p} type="number" inputMode="numeric" min={0} max={730} value={trial} onChange={(e) => setTrial(e.target.value)} className="sm:max-w-40" />}
            </Field>
            {ready ? (
              <Summary>
                {trialDays ? `Free for ${trialDays} days, then ` : "Starting today, "}
                {collection === "charge_automatically"
                  ? `Stripe charges ${methodWords(c.paymentMethods, method)} ${total} ${every}.`
                  : `Stripe sends ${customerLabel(c)} an invoice for ${total} ${every}, due ${Number(days) || 0} days after it's sent.`}
              </Summary>
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  );
}

// ─── Change a subscription ───────────────────────────────────────────────

type LineState = { id: string; priceId: string; amount: string; quantity: string };

export function EditSubscriptionDialog({ clientId, customer, s, onClose }: { clientId: string; customer: CustomerBilling; s: Sub; onClose: () => void }) {
  const { loading, prices, error } = usePrices(customer.account);
  const start0 = s.items.map((i): LineState => ({ id: i.id, priceId: i.priceId, amount: dollars(i.amount), quantity: String(i.quantity) }));
  const [lines, setLines] = useState(start0);
  const [collection, setCollection] = useState<Collection>(s.collection);
  const [method, setMethod] = useState(s.paymentMethod ?? "");
  const [days, setDays] = useState(String(s.daysUntilDue ?? 30));
  const [proration, setProration] = useState<Proration>("create_prorations");
  const [key, setKey] = useState(newKey);
  const [pending, start] = useTransition();

  const set = (i: number, patch: Partial<LineState>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const pick = (i: number, id: string) => {
    const p = prices?.find((x) => x.id === id);
    const was = s.items[i];
    set(i, { priceId: id, amount: p ? dollars(p.unitAmount) : id === was.priceId ? dollars(was.amount) : lines[i].amount });
  };
  // A usage-based line has no amount to type; left empty, it keeps the price as is.
  const centsOf = (l: LineState) => (l.amount.trim() === "" ? null : toCents(l.amount));
  const changedLines = lines.filter((l, i) => l.priceId !== start0[i].priceId || centsOf(l) !== centsOf(start0[i]) || Number(l.quantity) !== Number(start0[i].quantity));
  const paymentChanged = collection !== s.collection || (collection === "send_invoice" ? Number(days) !== (s.daysUntilDue ?? 30) : (method || null) !== s.paymentMethod);
  const valid = lines.every((l) => (l.amount.trim() === "" || toCents(l.amount) != null) && Number(l.quantity) >= 1);
  const dirty = changedLines.length > 0 || paymentChanged;

  const after = lines
    .map((l, i) => {
      const p = prices?.find((x) => x.id === l.priceId);
      const item = s.items[i];
      const cents = centsOf(l) ?? p?.unitAmount ?? item.amount;
      if (cents == null) return null;
      return `${money(cents * (Number(l.quantity) || 1), p?.currency ?? item.currency)}${per(p?.interval ?? item.interval, p?.intervalCount ?? item.intervalCount)}`;
    })
    .filter(Boolean)
    .join(" + ");

  const submit = () =>
    start(async () => {
      const r = await updateStripeSubscription(clientId, {
        account: customer.account,
        subscriptionId: s.id,
        lines: lines.map((l) => ({ id: l.id, priceId: l.priceId, amount: centsOf(l), quantity: Number(l.quantity) })),
        proration,
        collection,
        daysUntilDue: collection === "send_invoice" ? Number(days) || 0 : null,
        paymentMethod: collection === "charge_automatically" ? method || null : null,
        requestKey: key,
      });
      if (!r.ok) {
        setKey(newKey());
        return void toast.error(r.error);
      }
      toast.success("Subscription updated in Stripe");
      onClose();
    });

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Change subscription"
      description={`${subName(s)} · ${customerLabel(customer)}. Changes happen in Stripe as soon as you save.`}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Go back
          </Button>
          <Button variant="primary" onClick={submit} loading={pending} disabled={!dirty || !valid || loading}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {loading ? (
          <p className="flex items-center gap-2 text-[13px] text-muted">
            <Spinner /> Reading plans from Stripe
          </p>
        ) : error ? (
          <p className="text-[13px] text-error">{error}</p>
        ) : null}
        {lines.map((l, i) => {
          const item = s.items[i];
          const known = prices?.some((p) => p.id === item.priceId);
          return (
            <div key={l.id} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_6rem]">
              <Field label={s.items.length > 1 ? `Plan ${i + 1}` : "Plan"}>
                {(p) => (
                  <Select {...p} value={l.priceId} onChange={(e) => pick(i, e.target.value)} disabled={loading || !prices}>
                    <PlanOptions
                      prices={(prices ?? []).filter((x) => x.currency === item.currency)}
                      extra={known ? null : { value: item.priceId, label: `${item.name} — current price${item.amount != null ? ` (${money(item.amount, item.currency)}${per(item.interval, item.intervalCount)})` : ""}` }}
                    />
                  </Select>
                )}
              </Field>
              <Field label="Amount">{(p) => <Input {...p} inputMode="decimal" value={l.amount} onChange={(e) => set(i, { amount: e.target.value })} aria-invalid={l.amount.trim() && toCents(l.amount) == null ? true : undefined} />}</Field>
              <Field label="Quantity">{(p) => <Input {...p} type="number" inputMode="numeric" min={1} value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} />}</Field>
            </div>
          );
        })}

        <PaymentFields methods={customer.paymentMethods} collection={collection} setCollection={setCollection} method={method} setMethod={setMethod} days={days} setDays={setDays} />

        {changedLines.length ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-label">For the rest of this billing period</legend>
            {(Object.keys(prorationLabels) as Proration[]).map((k) => (
              <label key={k} className={clsx("flex cursor-pointer gap-3 rounded-lg border p-3 text-[13px]", proration === k ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong")}>
                <input type="radio" name="proration" className="mt-0.5 size-4 accent-[var(--accent)]" checked={proration === k} onChange={() => setProration(k)} />
                <span>
                  <span className="block font-medium text-primary">{prorationLabels[k].label}</span>
                  <span className="block text-muted">{prorationLabels[k].hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}

        {dirty && valid ? (
          <Summary>
            {changedLines.length ? `${subName(s)} goes from ${priceOf(s) || "its current price"} to ${after}. ` : ""}
            {paymentChanged
              ? collection === "charge_automatically"
                ? `Stripe will charge ${methodWords(customer.paymentMethods, method)} each time.`
                : `Stripe will send an invoice each time, due ${Number(days) || 0} days after it's sent.`
              : ""}
          </Summary>
        ) : null}
      </div>
    </Dialog>
  );
}

// ─── Cancel a subscription ───────────────────────────────────────────────

export function CancelSubscriptionDialog({ clientId, customer, s, onClose }: { clientId: string; customer: CustomerBilling; s: Sub; onClose: () => void }) {
  const scheduled = cancelsAt(s);
  // The end of the period they've paid for; a trial ends when the trial does.
  const periodEnd = s.status === "trialing" && s.trialEnd ? s.trialEnd : s.periodEnd;
  const [when, setWhen] = useState<"period_end" | "now">(scheduled || !periodEnd ? "now" : "period_end");
  const [key, setKey] = useState(newKey);
  const [today] = useState(() => Math.floor(Date.now() / 1000));
  const [pending, start] = useTransition();
  const name = subName(s);

  const submit = () =>
    start(async () => {
      const r = await cancelStripeSubscription(clientId, { account: customer.account, subscriptionId: s.id, when, requestKey: key });
      if (!r.ok) {
        setKey(newKey());
        return void toast.error(r.error);
      }
      toast.success(when === "now" ? `${name} is canceled in Stripe` : `${name} cancels on ${r.data.endsAt ? day(r.data.endsAt) : "the last day of this period"}. Until then you can keep it from the billing details.`);
      onClose();
    });

  const options = [
    {
      value: "period_end" as const,
      label: "At the end of the billing period",
      hint: scheduled
        ? `It's already set to cancel on ${day(scheduled)}.`
        : periodEnd
          ? `On ${day(periodEnd)}. They keep what they've paid for until then and aren't billed again.${s.status === "trialing" ? " That's when their trial ends." : ""}`
          : "Stripe doesn't say when this period ends.",
      disabled: !!scheduled || !periodEnd,
    },
    { value: "now" as const, label: "Immediately", hint: "Today. It stops now and nothing more is billed. Stripe doesn't refund the time left; refund it in Stripe if you need to.", disabled: false },
  ];

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Cancel ${name}`}
      description={[customerLabel(customer), priceOf(s)].filter(Boolean).join(" · ")}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Keep subscription
          </Button>
          <Button variant="destructive" onClick={submit} loading={pending}>
            {when === "now" ? "Cancel now" : periodEnd ? `Cancel on ${day(periodEnd)}` : "Cancel subscription"}
          </Button>
        </>
      }
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-label">When should it end?</legend>
        {options.map((o) => (
          <label
            key={o.value}
            className={clsx(
              "flex gap-3 rounded-lg border p-3 text-[13px]",
              o.disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
              when === o.value ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong",
            )}
          >
            <input type="radio" name="when" className="mt-0.5 size-4 accent-[var(--accent)]" checked={when === o.value} disabled={o.disabled} onChange={() => setWhen(o.value)} />
            <span>
              <span className="block font-medium text-primary">{o.label}</span>
              <span className="block text-muted">{o.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="mt-4">
        <Summary tone="warning">
          {when === "now"
            ? `${name} ends today, ${day(today)}, as soon as you confirm.`
            : `${name} keeps running until ${periodEnd ? day(periodEnd) : "the end of this period"}, then ends. Nothing more is billed. You can undo this any time before then.`}
        </Summary>
      </div>
    </Dialog>
  );
}
