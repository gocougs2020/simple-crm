"use client";

import clsx from "clsx";
import { useState, useTransition } from "react";
import { PlusIcon } from "@heroicons/react/20/solid";
import { saveProductDescription } from "@/actions/settings";
import { Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { Section } from "./nav";

export type ProductRow = { name: string; description: string | null; clients: number; inStripe: boolean };

const onIt = (n: number) => (n ? `${n.toLocaleString()} ${n === 1 ? "client" : "clients"} on it now` : "No clients on it now");

/**
 * What the workspace sells is what Stripe bills for: each product in the
 * connected accounts' subscriptions, by name. Here the team says what each
 * one delivers ("ThirdPool Advanced": the benchmarks we commit to). The
 * description shows wherever the product does, behind an info icon, and the
 * agent reads it.
 */
export function ServiceSettings({ products, stripe }: { products: ProductRow[]; stripe: boolean }) {
  const [editing, setEditing] = useState<ProductRow | "new" | null>(null);
  return (
    <>
      <Section
        title="Services"
        description="What clients have comes from their Stripe subscriptions. Say what each product delivers: the description shows when someone hovers the info icon next to it, and the agent reads it."
        action={
          <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
            <PlusIcon />
            Describe a product
          </Button>
        }
      >
        {products.length ? (
          <ul className="divide-y divide-line">
            {products.map((p) => (
              <li key={p.name}>
                <button type="button" className="w-full px-4 py-2.5 text-left hover:bg-sunken/60" onClick={() => setEditing(p)} aria-label={`Describe ${p.name}`}>
                  <span className="flex flex-wrap items-center gap-2">
                    <Tag>{p.name}</Tag>
                    <span className="text-[12px] text-muted tabular-nums">{p.inStripe ? onIt(p.clients) : "Not in Stripe yet"}</span>
                  </span>
                  <span className={clsx("mt-1 block text-[12.5px] whitespace-pre-line", p.description ? "text-secondary" : "text-faint")}>{p.description ?? "No description yet. Add what this product delivers."}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-6 text-center text-[13px] text-muted">
            {stripe ? "No products in Stripe yet. Once clients subscribe, each product shows here to describe." : "Stripe isn't connected, so there are no products to list. You can still describe a product by its Stripe name."}
          </p>
        )}
      </Section>
      {editing ? <ProductDialog product={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

function ProductDialog({ product, onClose }: { product: ProductRow | null; onClose: () => void }) {
  // A product Stripe has keeps Stripe's name; one described ahead of time can be renamed to match.
  const fixedName = !!product?.inStripe;
  const [name, setName] = useState(product?.name ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [pending, start] = useTransition();
  const save = (text: string) =>
    start(async () => {
      const r = await saveProductDescription(product?.description ? product.name : null, { name, description: text });
      if (!r.ok) return void toast.error(r.error);
      toast.success(text.trim() ? `${r.data.name} described` : `${r.data.name}'s description removed`);
      onClose();
    });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={product ? product.name : "Describe a product"}
      description={product ? (product.inStripe ? onIt(product.clients) : "Not in any Stripe subscription yet.") : "Use the product's name exactly as it is in Stripe. Capital letters don't matter."}
      size="md"
      footer={
        <>
          {product?.description ? (
            <Button variant="ghost" className="mr-auto text-error" disabled={pending} onClick={() => save("")}>
              Remove description
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={() => save(description)} disabled={!name.trim() || !description.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {fixedName ? null : (
          <Field label="Stripe product name">
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={200} placeholder="ThirdPool Advanced" autoComplete="off" />}
          </Field>
        )}
        <Field label="What it delivers" hint="The benchmarks, scope and commitments that come with it. Shown behind the info icon next to the product, and read by the agent.">
          {(p) => <Textarea {...p} value={description} onChange={(e) => setDescription(e.target.value)} rows={6} maxLength={2000} autoFocus={fixedName} placeholder="Weekly shortlist of five vetted candidates. First interviews within 14 days, a hire within 45." />}
        </Field>
      </div>
    </Dialog>
  );
}
