"use client";

import clsx from "clsx";
import { Fragment } from "react";
import { InformationCircleIcon } from "@heroicons/react/16/solid";
import { useApp } from "@/components/app-context";
import { Tag } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/menu";
import { productFamiliesOf, type ProductFamily } from "@/lib/product-rules";

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
const familyTones: Record<ProductFamily, string> = {
  TalentScout: "bg-product-talentscout-surface text-product-talentscout border-product-talentscout-border",
  CoRecruit: "bg-product-corecruit-surface text-product-corecruit border-product-corecruit-border",
  ThirdPool: "bg-product-thirdpool-surface text-product-thirdpool border-product-thirdpool-border",
  HiringCenter: "bg-product-hiringcenter-surface text-product-hiringcenter border-product-hiringcenter-border",
  VRA: "bg-product-vra-surface text-product-vra border-product-vra-border",
};

/** The product lines a client's Stripe products belong to, as badges in each line's color, in a row that wraps. Nothing when none match. */
export function ProductFamilyBadges({ products, className }: { products: readonly string[]; className?: string }) {
  const families = productFamiliesOf(products);
  if (!families.length) return null;
  return (
    <span className={clsx("flex flex-wrap gap-1", className)}>
      {families.map((f) => (
        <span key={f} className={clsx("inline-flex h-5 shrink-0 items-center rounded-md border px-1.5 text-[11.5px] leading-none font-semibold whitespace-nowrap", familyTones[f])}>
          {f}
        </span>
      ))}
    </span>
  );
}
