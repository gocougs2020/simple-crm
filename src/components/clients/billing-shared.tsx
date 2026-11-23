import { StatusBadge, type Tone } from "@/components/ui/badge";
import { formatMoney } from "@/lib/format";
import { per } from "@/lib/stripe/changes";
import { liveStatuses } from "@/lib/stripe/rules";
import type { CustomerBilling, SubStatus } from "@/lib/stripe/types";

/** Shared by the billing card, its detail view and the dialogs that change subscriptions. */

export type Sub = CustomerBilling["subscriptions"][number];

export const day = (unix: number) => new Date(unix * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
/** "Dec 3", with the year when it isn't this one. */
export const shortDay = (unix: number) => {
  const d = new Date(unix * 1000);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getUTCFullYear() === new Date().getUTCFullYear() ? {} : { year: "numeric" }), timeZone: "UTC" });
};
export const money = (cents: number, currency: string | null) => formatMoney(cents, (currency ?? "usd").toUpperCase());

const subTone: Record<SubStatus, Tone> = { active: "success", trialing: "info", past_due: "error", unpaid: "error", incomplete: "warning", incomplete_expired: "neutral", canceled: "neutral", paused: "warning" };
const subLabel: Record<SubStatus, string> = { active: "Active", trialing: "Trial", past_due: "Past due", unpaid: "Unpaid", incomplete: "Incomplete", incomplete_expired: "Expired", canceled: "Canceled", paused: "Paused" };

export const isLive = (s: { status: string }) => (liveStatuses as readonly string[]).includes(s.status);
export const isEnded = (s: Sub) => s.status === "canceled" || s.status === "incomplete_expired";
/** When a subscription that's still running is set to end, in unix seconds; null when it renews. */
export const cancelsAt = (s: Sub) => (isEnded(s) ? null : (s.cancelAt ?? (s.cancelAtPeriodEnd ? s.periodEnd : null)));

export const subName = (s: Sub, quantities = false) => s.items.map((i) => (quantities && i.quantity > 1 ? `${i.name} × ${i.quantity}` : i.name)).join(", ") || "Subscription";

/** "every month", "every 3 months". */
export const everyWord = (interval: string | null, count = 1) => (interval ? `every ${count > 1 ? `${count} ${interval}s` : interval}` : "");

/** What each line bills per period: "$500/month + $50/month". */
export const priceOf = (s: Sub) =>
  s.items
    .map((i) => (i.amount != null ? `${money(i.amount * i.quantity, i.currency)}${per(i.interval, i.intervalCount)}` : null))
    .filter(Boolean)
    .join(" + ");
/** What a subscription is billed after its discounts, when it has any: "$1,215/mo after discounts". */
export const netOf = (s: Sub) => (s.discount ? `${money(s.monthly - s.discount, s.currency)}/mo after discounts` : null);
export const whenOf = (s: Sub) => {
  const ends = cancelsAt(s);
  return s.endedAt ? `ended ${day(s.endedAt)}` : ends ? `ends ${day(ends)}` : s.periodEnd ? `renews ${day(s.periodEnd)}` : "";
};

/** A running subscription that's set to cancel says when, so nobody mistakes it for one that renews. */
export function SubBadge({ s }: { s: Sub }) {
  const ends = cancelsAt(s);
  if (ends && isLive(s)) return <StatusBadge tone="warning">Cancels {shortDay(ends)}</StatusBadge>;
  return <StatusBadge tone={subTone[s.status]}>{subLabel[s.status]}</StatusBadge>;
}
