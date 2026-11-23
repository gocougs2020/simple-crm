"use client";

import clsx from "clsx";
import { Fragment } from "react";
import { InformationCircleIcon } from "@heroicons/react/16/solid";
import { useApp } from "@/components/app-context";
import { Tag } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/menu";

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
