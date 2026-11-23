import clsx from "clsx";
import { BuildingLibraryIcon } from "@heroicons/react/20/solid";
import { brandName } from "@/lib/stripe/rules";
import type { PaymentMethod } from "@/lib/stripe/types";

const cap = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/**
 * A saved card or bank account drawn like the card itself: brand, masked
 * number, holder and expiry for a card; bank, account type and the last four
 * for a bank account. Colors come from the accent tokens, so it follows the theme.
 */
export function PaymentCard({ m }: { m: PaymentMethod }) {
  const bank = m.kind === "bank";
  const title = m.kind === "card" ? brandName(m.brand ?? "card") : bank ? (m.brand ?? "Bank account") : cap(m.type);
  const kindWord = m.kind === "card" ? (m.detail && m.detail !== "unknown" ? `${cap(m.detail)} card` : "Card") : bank ? (m.detail ? `${cap(m.detail)} account` : "Bank account") : "Payment method";
  return (
    <li
      className={clsx(
        "relative flex aspect-[1.586] w-full max-w-[300px] flex-col justify-between overflow-hidden rounded-xl p-4 text-accent-foreground shadow-sm",
        "bg-gradient-to-br from-accent to-accent-hover",
        m.expired && "opacity-75",
      )}
      aria-label={`${m.label}${m.isDefault ? ", default" : ""}${m.expires ? `, ${m.expired ? "expired" : "expires"} ${m.expires}` : ""}`}
    >
      {/* A soft ring in the corner, the way printed cards have one. */}
      <span aria-hidden className="pointer-events-none absolute -top-16 -right-16 size-44 rounded-full bg-accent-foreground/[0.06]" />
      <span aria-hidden className="pointer-events-none absolute -right-6 -bottom-20 size-40 rounded-full bg-accent-foreground/[0.04]" />

      <div className="relative flex items-start justify-between gap-2">
        <span className="min-w-0 truncate text-[14px] font-semibold tracking-wide">{title}</span>
        <span className="flex shrink-0 gap-1">
          {m.isDefault ? <span className="rounded-md bg-accent-foreground/15 px-1.5 py-0.5 text-[10.5px] font-semibold tracking-wide uppercase">Default</span> : null}
          {m.expired ? <span className="rounded-md bg-error px-1.5 py-0.5 text-[10.5px] font-semibold tracking-wide text-white uppercase">Expired</span> : null}
        </span>
      </div>

      <div className="relative">
        {bank ? (
          <BuildingLibraryIcon aria-hidden className="mb-2 size-6 opacity-80" />
        ) : (
          // The chip.
          <span aria-hidden className="mb-2 block h-6 w-8 rounded-[5px] border border-accent-foreground/25 bg-accent-foreground/20" />
        )}
        <p className="font-mono text-[15px] tracking-[0.18em] tabular-nums" aria-hidden>
          {bank ? "•••• " : "•••• •••• •••• "}
          {m.last4 ?? "····"}
        </p>
      </div>

      <div className="relative flex items-end justify-between gap-3 text-[11px]">
        <span className="min-w-0">
          <span className="block text-[9.5px] tracking-wider uppercase opacity-60">{m.holder ? "Holder" : "Type"}</span>
          <span className="block truncate font-medium tracking-wide uppercase">{m.holder ?? kindWord}</span>
        </span>
        {m.expires || m.holder ? (
          <span className="shrink-0 text-right">
            <span className="block text-[9.5px] tracking-wider uppercase opacity-60">{m.expires ? (m.expired ? "Expired" : "Expires") : "Type"}</span>
            <span className="block font-medium tabular-nums">{m.expires ?? kindWord}</span>
          </span>
        ) : null}
      </div>
    </li>
  );
}
