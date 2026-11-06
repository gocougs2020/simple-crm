import type { ReactNode } from "react";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/20/solid";
import { StatusBadge, type Tone } from "@/components/ui/badge";
import { formatMoney } from "@/lib/format";
import { billingFor, stripeConfigured, stripeDashboardUrl, StripeError, type StripeInvoice, type StripeSubscription } from "@/lib/stripe";
import { StripeLinker } from "./client-panels";

const day = (unix: number) => new Date(unix * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const money = (cents: number, currency: string) => formatMoney(cents, currency.toUpperCase());

const subTone: Record<StripeSubscription["status"], Tone> = { active: "success", trialing: "info", past_due: "error", unpaid: "error", incomplete: "warning", incomplete_expired: "neutral", canceled: "neutral", paused: "warning" };
const subLabel: Record<StripeSubscription["status"], string> = { active: "Active", trialing: "Trial", past_due: "Past due", unpaid: "Unpaid", incomplete: "Incomplete", incomplete_expired: "Expired", canceled: "Canceled", paused: "Paused" };
const invoiceTone: Record<NonNullable<StripeInvoice["status"]>, Tone> = { paid: "success", open: "warning", uncollectible: "error", void: "neutral", draft: "neutral" };

/** The billing part of the services card: a divider, a small heading, and the Stripe link control. */
function Section({ action, children }: { action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-3 border-t border-line pt-3">
      <header className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-[11.5px] font-semibold tracking-wide text-muted uppercase">Billing</h3>
        {action}
      </header>
      {children}
    </section>
  );
}

/**
 * Stripe billing for a current or past client: balance, subscriptions,
 * invoices and payments, fetched live from Stripe on every view. Renders in
 * its own Suspense boundary so a slow Stripe never holds up the page.
 */
export async function BillingCard({ clientId, customerId, suggest }: { clientId: string; customerId: string | null; suggest: string | null }) {
  if (!stripeConfigured())
    return (
      <Section>
        <p className="py-1 text-[12.5px] text-muted">Connect Stripe to see subscriptions, invoices and payments here. Add a restricted STRIPE_SECRET_KEY (read access is enough) to the environment.</p>
      </Section>
    );
  if (!customerId)
    return (
      <Section action={<StripeLinker clientId={clientId} suggest={suggest} linked={null} />}>
        <p className="py-1 text-[12.5px] text-muted">Link this client&apos;s Stripe customer to see their subscriptions, invoices and payments.</p>
      </Section>
    );

  let billing: Awaited<ReturnType<typeof billingFor>>;
  try {
    billing = await billingFor(customerId);
  } catch (err) {
    return (
      <Section action={<StripeLinker clientId={clientId} suggest={suggest} linked={customerId} />}>
        <p className="py-1 text-[12.5px] text-error">{err instanceof StripeError ? err.message : "Stripe didn't answer."} Reload to try again.</p>
      </Section>
    );
  }
  const { customer, subscriptions, invoices, charges } = billing;
  const currency = customer.currency ?? subscriptions[0]?.currency ?? invoices[0]?.currency ?? "usd";
  const owed = invoices.filter((i) => i.status === "open").reduce((s, i) => s + i.amount_remaining, 0);
  const live = subscriptions.filter((s) => !["canceled", "incomplete_expired"].includes(s.status));
  const ended = subscriptions.filter((s) => ["canceled", "incomplete_expired"].includes(s.status));

  return (
    <Section action={<StripeLinker clientId={clientId} suggest={suggest} linked={customerId} />}>
      <div className="flex flex-col gap-3">
        <dl className="grid grid-cols-2 gap-2">
          <div>
            <dt className="text-[11.5px] text-muted">Open invoices</dt>
            <dd className={owed ? "text-[14px] font-semibold text-warning tabular-nums" : "text-[14px] font-semibold text-primary tabular-nums"}>{money(owed, currency)}</dd>
          </div>
          <div>
            <dt className="text-[11.5px] text-muted">{customer.balance < 0 ? "Credit" : "Balance"}</dt>
            <dd className="text-[14px] font-semibold text-primary tabular-nums">{money(Math.abs(customer.balance), currency)}</dd>
          </div>
        </dl>
        {customer.delinquent ? <p className="text-[12px] text-error">Stripe marks this customer as delinquent: a recent payment failed.</p> : null}

        <section>
          <h4 className="mb-1 text-[11.5px] font-medium text-muted">Subscriptions</h4>
          {[...live, ...ended].length ? (
            <ul className="flex flex-col gap-1.5">
              {[...live, ...ended].slice(0, 5).map((s) => (
                <li key={s.id} className="text-[12.5px]">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium text-primary">{s.items.map((i) => i.name).join(", ")}</span>
                    <StatusBadge tone={subTone[s.status]}>{s.cancel_at_period_end && s.status === "active" ? "Canceling" : subLabel[s.status]}</StatusBadge>
                  </div>
                  <p className="text-[11.5px] text-muted tabular-nums">
                    {s.items
                      .map((i) => (i.price.unit_amount != null ? `${money(i.price.unit_amount * (i.quantity ?? 1), i.price.currency)}${i.price.recurring ? `/${i.price.recurring.interval_count > 1 ? `${i.price.recurring.interval_count} ` : ""}${i.price.recurring.interval}` : ""}` : null))
                      .filter(Boolean)
                      .join(" + ")}
                    {s.ended_at ? ` · ended ${day(s.ended_at)}` : s.cancel_at ? ` · ends ${day(s.cancel_at)}` : s.periodEnd ? ` · renews ${day(s.periodEnd)}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] text-muted">No subscriptions.</p>
          )}
        </section>

        <section>
          <h4 className="mb-1 text-[11.5px] font-medium text-muted">Invoices</h4>
          {invoices.length ? (
            <ul className="-mx-2">
              {invoices.slice(0, 6).map((i) => (
                <li key={i.id}>
                  <a href={i.hosted_invoice_url ?? stripeDashboardUrl(customer.id)} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-md px-2 py-1 text-[12.5px] hover:bg-sunken">
                    <span className="w-24 shrink-0 text-muted tabular-nums">{day(i.created)}</span>
                    <span className="min-w-0 flex-1 truncate text-secondary">{i.number ?? "Invoice"}</span>
                    {i.status ? <StatusBadge tone={invoiceTone[i.status]}>{i.overdue ? "Overdue" : i.status[0].toUpperCase() + i.status.slice(1)}</StatusBadge> : null}
                    <span className="w-20 shrink-0 text-right text-primary tabular-nums">{money(i.total, i.currency)}</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] text-muted">No invoices yet.</p>
          )}
        </section>

        <section>
          <h4 className="mb-1 text-[11.5px] font-medium text-muted">Payments</h4>
          {charges.length ? (
            <ul className="-mx-2">
              {charges.slice(0, 5).map((c) => (
                <li key={c.id} className="flex items-center gap-2 px-2 py-1 text-[12.5px]">
                  <span className="w-24 shrink-0 text-muted tabular-nums">{day(c.created)}</span>
                  <span className="min-w-0 flex-1 truncate text-secondary">
                    {c.payment_method_details?.card ? `${c.payment_method_details.card.brand} ···· ${c.payment_method_details.card.last4}` : (c.payment_method_details?.type ?? "Payment")}
                  </span>
                  {c.status === "failed" ? <StatusBadge tone="error">Failed</StatusBadge> : c.refunded ? <StatusBadge tone="neutral">Refunded</StatusBadge> : c.status === "pending" ? <StatusBadge tone="warning">Pending</StatusBadge> : null}
                  <span className="w-20 shrink-0 text-right text-primary tabular-nums">{money(c.amount, c.currency)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] text-muted">No payments yet.</p>
          )}
        </section>

        <a href={stripeDashboardUrl(customer.id)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 self-start text-[12.5px] font-medium text-secondary hover:text-primary">
          Open in Stripe
          <ArrowTopRightOnSquareIcon className="size-3.5" />
        </a>
      </div>
    </Section>
  );
}
