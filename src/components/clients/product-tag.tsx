"use client";

import clsx from "clsx";
import { Fragment, useState, useTransition } from "react";
import { InformationCircleIcon } from "@heroicons/react/16/solid";
import { useApp } from "@/components/app-context";
import { Tag } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/menu";
import { updateClient } from "@/actions/clients";
import { SideCard } from "@/components/records/inline-field";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { productFamilies, productFamiliesOf, type ProductFamily } from "@/lib/product-rules";

/**
 * The info icon beside a Stripe product's name: what the team says it
 * delivers (Settings → Services), on hover or keyboard focus. Nothing when
 * nobody described it.
 */
export function ProductInfo({ name, className }: { name: string; className?: string }) {
  const { productDescription } = useApp();
  const description = productDescription(name);
  if (!description) return null;
  return (
    <Tooltip content={<span className="block whitespace-pre-line">{description}</span>}>
      <button
        type="button"
        // Inside a clickable row: showing the description doesn't open the record.
        onClick={(e) => e.stopPropagation()}
        className={clsx("inline-flex shrink-0 rounded-full p-0.5 align-[-3px] text-faint hover:text-primary focus-visible:text-primary", className)}
        aria-label={`What ${name} delivers: ${description}`}
      >
        <InformationCircleIcon className="size-3.5" aria-hidden />
      </button>
    </Tooltip>
  );
}

/** A Stripe product a client is billed for, as a chip, with its info icon. */
export function ProductTag({ name, className }: { name: string; className?: string }) {
  const { productDescription } = useApp();
  return (
    <Tag className={clsx(productDescription(name) && "pr-1", className)}>
      {name}
      <ProductInfo name={name} className="-my-1" />
    </Tag>
  );
}

/** Products as running text ("ThirdPool Advanced, CoRecruit"), each with its info icon. */
export function ProductNames({ names }: { names: string[] }) {
  return (
    <>
      {names.map((n, i) => (
        <Fragment key={`${n}-${i}`}>
          {i ? ", " : null}
          {n}
          <ProductInfo name={n.replace(/ × \d+$/, "")} className="ml-0.5" />
        </Fragment>
      ))}
    </>
  );
}

// Written out in full so Tailwind finds every class.
const lineTones: Record<ProductFamily, string> = {
  TalentScout: "bg-product-talentscout-surface text-product-talentscout border-product-talentscout-border",
  CoRecruit: "bg-product-corecruit-surface text-product-corecruit border-product-corecruit-border",
  ThirdPool: "bg-product-thirdpool-surface text-product-thirdpool border-product-thirdpool-border",
  HiringCenter: "bg-product-hiringcenter-surface text-product-hiringcenter border-product-hiringcenter-border",
  VRA: "bg-product-vra-surface text-product-vra border-product-vra-border",
};

const badge = "inline-flex h-5 shrink-0 items-center rounded-md border px-1.5 text-[11.5px] leading-none font-semibold whitespace-nowrap";

/** A client's product lines (TalentScout, CoRecruit…) as badges in each line's color, in a row that wraps. Nothing when there are none. */
export function ProductLineBadges({ lines, className }: { lines: readonly ProductFamily[]; className?: string }) {
  if (!lines.length) return null;
  return (
    <span className={clsx("flex flex-wrap gap-1", className)}>
      {lines.map((f) => (
        <span key={f} className={clsx(badge, lineTones[f])}>
          {f}
        </span>
      ))}
    </span>
  );
}

/**
 * The Products card on a client: its product lines, and for editors a way to
 * change them. When what they're subscribed to in Stripe belongs to a line,
 * the daily sync sets them again, and the card says so.
 */
export function ProductLinesCard({ clientId, lines, stripeProducts }: { clientId: string; lines: ProductFamily[]; stripeProducts: string[] }) {
  const { canEdit } = useApp();
  const [editing, setEditing] = useState(false);
  const [shown, setShown] = useState(lines);
  const [pending, start] = useTransition();
  // Fresh server data (after a save, a sync or a teammate's edit) wins.
  const [prev, setPrev] = useState(lines);
  if (prev !== lines) {
    setPrev(lines);
    setShown(lines);
  }
  const fromStripe = productFamiliesOf(stripeProducts).length > 0;

  const toggle = (f: ProductFamily) => {
    const before = shown;
    const next = productFamilies.filter((x) => (x === f ? !before.includes(f) : before.includes(x)));
    setShown(next);
    start(async () => {
      const r = await updateClient(clientId, { productLines: next });
      if (!r.ok) {
        setShown(before);
        toast.error(r.error);
      }
    });
  };

  return (
    <SideCard
      title="Products"
      action={
        canEdit ? (
          <Button size="sm" variant="ghost" className="-mr-2 h-7" onClick={() => setEditing((e) => !e)} aria-expanded={editing}>
            {editing ? "Done" : "Edit"}
          </Button>
        ) : null
      }
    >
      {editing ? (
        <div className="flex flex-wrap gap-1.5 pt-1" role="group" aria-label="Product lines">
          {productFamilies.map((f) => {
            const on = shown.includes(f);
            return (
              <button
                key={f}
                type="button"
                aria-pressed={on}
                disabled={pending}
                onClick={() => toggle(f)}
                className={clsx(badge, "h-7 cursor-pointer px-2.5 text-[12.5px] transition-colors", on ? lineTones[f] : "border-dashed border-line-strong bg-surface text-muted hover:text-secondary")}
              >
                {f}
              </button>
            );
          })}
        </div>
      ) : shown.length ? (
        <ProductLineBadges lines={shown} className="pt-1" />
      ) : (
        <p className="pt-1 text-[13px] text-faint">No products yet</p>
      )}
      {fromStripe ? <p className="mt-2 text-[12px] text-muted">Stripe sets these from their subscriptions each day, replacing changes made here.</p> : null}
    </SideCard>
  );
}
