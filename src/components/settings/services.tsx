"use client";

import clsx from "clsx";
import { useState, useTransition } from "react";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon } from "@heroicons/react/20/solid";
import { archiveService, reorderServices, saveService } from "@/actions/settings";
import { useApp } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { billingIntervalLabels, billingIntervals, type BillingInterval } from "@/lib/constants";
import type { Service } from "@/lib/crm/context";
import { parseMoney } from "@/lib/format";
import { Section } from "./nav";

/**
 * What the workspace sells. Current clients are linked to the services they
 * pay for, which adds up their monthly revenue; past clients keep the ones
 * they had, for win-back campaigns.
 */
export function ServiceSettings({ usage }: { usage: Record<string, { active: number; total: number }> }) {
  const { catalog, money } = useApp();
  const [editing, setEditing] = useState<Service | null | "new">(null);
  const [, start] = useTransition();
  const active = catalog.filter((s) => !s.archivedAt);
  const archived = catalog.filter((s) => s.archivedAt);
  const move = (i: number, by: number) =>
    start(async () => {
      const ids = active.map((s) => s.id);
      [ids[i], ids[i + by]] = [ids[i + by], ids[i]];
      const r = await reorderServices(ids);
      if (!r.ok) toast.error(r.error);
    });
  return (
    <>
      <Section
        title="Services"
        description="What you sell. Pick them on current clients to track what each pays for; prices here are the defaults and can differ per client."
        action={
          <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
            <PlusIcon />
            Add service
          </Button>
        }
      >
        {active.length ? (
          <ul className="divide-y divide-line">
            {active.map((s, i) => (
              <li key={s.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="flex flex-col">
                  <button type="button" className="rounded p-0.5 text-faint hover:text-primary disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${s.name} up`}>
                    <ArrowUpIcon className="size-3.5" />
                  </button>
                  <button type="button" className="rounded p-0.5 text-faint hover:text-primary disabled:opacity-30" disabled={i === active.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${s.name} down`}>
                    <ArrowDownIcon className="size-3.5" />
                  </button>
                </div>
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing(s)}>
                  <span className="block truncate text-[14px] font-medium text-primary">{s.name}</span>
                  {s.description ? <span className="block truncate text-[12.5px] text-muted">{s.description}</span> : null}
                </button>
                <span className="text-[13px] text-secondary tabular-nums">
                  {money(s.price)}
                  {billingIntervalLabels[s.interval].per}
                </span>
                <span className="w-28 text-right text-[12.5px] text-muted tabular-nums">{usage[s.id]?.active ? `${usage[s.id].active} active` : "Not in use"}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-6 text-center text-[13px] text-muted">No services yet. Add what you sell, like a monthly retainer or a one-time setup.</p>
        )}
      </Section>
      {archived.length ? (
        <Section title="Archived" description="Can't be added to clients anymore. Clients who have them keep them.">
          <ul className="divide-y divide-line">
            {archived.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1 truncate text-[14px] text-secondary">{s.name}</span>
                <span className="text-[12.5px] text-muted tabular-nums">{usage[s.id]?.total ? `${usage[s.id].total} clients` : ""}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    const r = await archiveService(s.id, false);
                    if (!r.ok) toast.error(r.error);
                    else toast.success(`${s.name} restored`);
                  }}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {editing ? <ServiceDialog service={editing === "new" ? null : editing} usage={editing === "new" ? undefined : usage[editing.id]} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

function ServiceDialog({ service, usage, onClose }: { service: Service | null; usage?: { active: number; total: number }; onClose: () => void }) {
  const { workspace } = useApp();
  const [name, setName] = useState(service?.name ?? "");
  const [description, setDescription] = useState(service?.description ?? "");
  const [price, setPrice] = useState(service ? String(service.price / 100) : "");
  const [interval, setInterval] = useState<BillingInterval>(service?.interval ?? "month");
  const [pending, start] = useTransition();
  const cents = parseMoney(price || "0");
  const save = () =>
    start(async () => {
      if (cents === null) return void toast.error("Enter the price as a number, like 450 or 1.2k.");
      const r = await saveService(service?.id ?? null, { name, description, price: cents, interval });
      if (!r.ok) return void toast.error(r.error);
      toast.success(service ? "Service saved" : `${name} added`);
      onClose();
    });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={service ? `Edit ${service.name}` : "Add a service"}
      description={service && usage?.active ? `${usage.active} client${usage.active === 1 ? " has" : "s have"} this. Changing the price here doesn't change what they pay.` : undefined}
      size="sm"
      footer={
        <>
          {service ? (
            <Button
              variant="ghost"
              className={clsx("mr-auto text-error")}
              onClick={() =>
                start(async () => {
                  const r = await archiveService(service.id, true);
                  if (!r.ok) return void toast.error(r.error);
                  toast.success(`${service.name} archived`, { label: "Undo", onClick: () => archiveService(service.id, false) });
                  onClose();
                })
              }
            >
              Archive
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={save}>
            {service ? "Save" : "Add service"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" className="sm:col-span-2">
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Monthly retainer" />}
        </Field>
        <Field label="Description" optional className="sm:col-span-2">
          {(p) => <Input {...p} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        <Field label={`Price (${workspace.currency})`}>{(p) => <Input {...p} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0" />}</Field>
        <Field label="Billed">
          {(p) => (
            <Select id={p.id} value={interval} onChange={(e) => setInterval(e.target.value as BillingInterval)}>
              {billingIntervals.map((i) => (
                <option key={i} value={i}>
                  {billingIntervalLabels[i].label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
    </Dialog>
  );
}
