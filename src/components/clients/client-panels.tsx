"use client";

import clsx from "clsx";
import { useState, useTransition } from "react";
import { ArrowDownRightIcon, ArrowUpRightIcon, EllipsisHorizontalIcon, LinkIcon, PlusIcon, TrashIcon } from "@heroicons/react/20/solid";
import { addClientService, deleteClientMetric, findStripeCustomers, linkStripeCustomer, logClientMetric, removeClientService, updateClientService } from "@/actions/clients";
import { useApp } from "@/components/app-context";
import { SideCard } from "@/components/records/inline-field";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Tooltip } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import type { schema } from "@/db";
import { billingIntervalLabels, billingIntervals, monthlyFactor, type BillingInterval, type ClientCategory } from "@/lib/constants";
import type { ClientServiceRow } from "@/lib/crm/records";
import { dayFromToday, formatAgo, formatDateOnly, parseMoney } from "@/lib/format";

const isActive = (s: { endedOn: string | null }, today: string) => !s.endedOn || s.endedOn > today;

// ─── Services ────────────────────────────────────────────────────────────

/**
 * What the client pays for: the services from Settings → Services they use
 * now, and the ones they had. Monthly revenue is the sum of the open ones.
 */
export function ServicesCard({ clientId, category, rows }: { clientId: string; category: ClientCategory; rows: ClientServiceRow[] }) {
  const { catalog, money, workspace } = useApp();
  const today = dayFromToday(workspace.timezone);
  const active = rows.filter((r) => isActive(r, today));
  const ended = rows.filter((r) => !isActive(r, today));
  const mrr = active.reduce((s, r) => s + r.price * monthlyFactor[r.interval], 0);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ClientServiceRow | null>(null);
  const available = catalog.filter((s) => !s.archivedAt);
  return (
    <SideCard
      title={
        <>
          {category === "past" ? "Subscription they had" : "Services"} {mrr ? <span className="font-medium text-muted tabular-nums">· {money(Math.round(mrr))}/mo</span> : null}
        </>
      }
      action={
        available.length ? (
          <Button size="sm" variant="ghost" className="-mr-2" onClick={() => setAdding(true)}>
            <PlusIcon />
            Service
          </Button>
        ) : undefined
      }
    >
      {!catalog.length ? (
        <p className="py-1 text-[12.5px] text-muted">Add what you sell in Settings → Services, then pick what this client uses.</p>
      ) : !rows.length ? (
        <p className="py-1 text-[12.5px] text-muted">{category === "past" ? "No services recorded. Add what they had, for win-back campaigns." : "No services yet. Add what they pay for."}</p>
      ) : (
        <ul className="-mx-2">
          {[...active, ...ended].map((r) => (
            <ServiceRow key={r.id} row={r} active={isActive(r, today)} onEdit={() => setEditing(r)} />
          ))}
        </ul>
      )}
      {adding ? <ServiceDialog clientId={clientId} category={category} onClose={() => setAdding(false)} /> : null}
      {editing ? <ServiceDialog clientId={clientId} category={category} row={editing} onClose={() => setEditing(null)} /> : null}
    </SideCard>
  );
}

function ServiceRow({ row, active, onEdit }: { row: ClientServiceRow; active: boolean; onEdit: () => void }) {
  const { money, workspace } = useApp();
  const tz = workspace.timezone;
  const [pending, start] = useTransition();
  const per = billingIntervalLabels[row.interval].per;
  const span = [row.startedOn ? formatDateOnly(row.startedOn, tz) : null, row.endedOn ? formatDateOnly(row.endedOn, tz) : active ? "now" : null].filter(Boolean).join(" – ");
  return (
    <li className={clsx("group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-sunken", !active && "opacity-70")}>
      <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left">
        <span className="block truncate text-[13px] font-medium text-primary">{row.name}</span>
        <span className="block truncate text-[11.5px] text-muted">
          {active ? "" : "Ended · "}
          {span}
          {row.note ? ` · ${row.note}` : ""}
        </span>
      </button>
      <span className="pt-0.5 text-[12.5px] text-secondary tabular-nums">
        {money(row.price)}
        {per}
      </span>
      <Menu>
        <MenuTrigger asChild>
          <button type="button" className="rounded p-0.5 text-faint opacity-60 group-hover:opacity-100 hover:text-primary" aria-label={`More for ${row.name}`} disabled={pending}>
            <EllipsisHorizontalIcon className="size-4" />
          </button>
        </MenuTrigger>
        <MenuContent className="w-44">
          <MenuItem onSelect={onEdit}>Edit</MenuItem>
          {active ? (
            <MenuItem
              onSelect={() =>
                start(async () => {
                  const r = await updateClientService(row.id, { endedOn: dayFromToday(workspace.timezone) });
                  if (!r.ok) toast.error(r.error);
                  else toast.success(`${row.name} ended today`);
                })
              }
            >
              End today
            </MenuItem>
          ) : (
            <MenuItem onSelect={() => start(async () => void (await updateClientService(row.id, { endedOn: null })))}>Restart</MenuItem>
          )}
          <MenuSeparator />
          <MenuItem
            destructive
            icon={<TrashIcon />}
            onSelect={() =>
              start(async () => {
                if (!confirm(`Remove ${row.name} from this client? To keep it in their history, end it instead.`)) return;
                const r = await removeClientService(row.id);
                if (!r.ok) toast.error(r.error);
              })
            }
          >
            Remove
          </MenuItem>
        </MenuContent>
      </Menu>
    </li>
  );
}

function ServiceDialog({ clientId, category, row, onClose }: { clientId: string; category: ClientCategory; row?: ClientServiceRow; onClose: () => void }) {
  const { catalog, workspace } = useApp();
  const available = catalog.filter((s) => !s.archivedAt);
  const [serviceId, setServiceId] = useState(row?.serviceId ?? available[0]?.id ?? "");
  const service = catalog.find((s) => s.id === serviceId);
  const [price, setPrice] = useState(row ? String(row.price / 100) : service ? String(service.price / 100) : "");
  const [interval, setInterval] = useState<BillingInterval>(row?.interval ?? service?.interval ?? "month");
  const [startedOn, setStartedOn] = useState(row?.startedOn ?? (category === "current" ? dayFromToday(workspace.timezone) : ""));
  const [endedOn, setEndedOn] = useState(row?.endedOn ?? "");
  const [note, setNote] = useState(row?.note ?? "");
  const [pending, start] = useTransition();
  const cents = parseMoney(price || "0");
  const save = () =>
    start(async () => {
      if (cents === null) return void toast.error("Enter the price as a number, like 450 or 1.2k.");
      const input = { price: cents, interval, startedOn: startedOn || null, endedOn: endedOn || null, note: note || null };
      const r = row ? await updateClientService(row.id, input) : await addClientService(clientId, serviceId, input);
      if (!r.ok) return void toast.error(r.error);
      toast.success(row ? "Service updated" : `${service?.name ?? "Service"} added`);
      onClose();
    });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={row ? `Edit ${row.name}` : "Add a service"}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={save}>
            {row ? "Save" : "Add service"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {!row ? (
          <Field label="Service" className="sm:col-span-2">
            {(p) => (
              <Select
                id={p.id}
                value={serviceId}
                onChange={(e) => {
                  setServiceId(e.target.value);
                  const s = catalog.find((x) => x.id === e.target.value);
                  if (s) {
                    setPrice(String(s.price / 100));
                    setInterval(s.interval);
                  }
                }}
              >
                {available.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        <Field label={`Price (${workspace.currency})`} hint="What this client pays, if it differs from the usual price.">
          {(p) => <Input {...p} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />}
        </Field>
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
        <Field label="Started" optional>
          {(p) => <Input {...p} type="date" value={startedOn} onChange={(e) => setStartedOn(e.target.value)} />}
        </Field>
        <Field label="Ended" optional>
          {(p) => <Input {...p} type="date" value={endedOn} onChange={(e) => setEndedOn(e.target.value)} />}
        </Field>
        <Field label="Note" optional className="sm:col-span-2">
          {(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Discount, contract terms, …" />}
        </Field>
      </div>
    </Dialog>
  );
}

// ─── Performance ─────────────────────────────────────────────────────────

type Metric = typeof schema.clientMetrics.$inferSelect;

const fmt = (n: number) => (Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));

/** A small line of a series' values, oldest to newest. Decorative: the numbers sit next to it. */
function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 60},${18 - ((v - min) / span) * 16 - 1}`).join(" ");
  return (
    <svg viewBox="0 0 60 18" className="h-[18px] w-[60px] shrink-0 text-muted" aria-hidden>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The numbers that say how a client is doing ("Leads", "Days to fill"), logged
 * over time. Each shows its latest value, the change from the one before and
 * the trend.
 */
export function PerformanceCard({ clientId, metrics, readOnly }: { clientId: string; metrics: Metric[]; readOnly?: boolean }) {
  const tz = useApp().workspace.timezone;
  const [logging, setLogging] = useState<string | null | false>(false);
  const series = Object.values(
    metrics.reduce<Record<string, Metric[]>>((acc, m) => {
      (acc[m.label] ??= []).push(m);
      return acc;
    }, {}),
  );
  return (
    <SideCard
      title="Performance"
      action={
        !readOnly ? (
          <Button size="sm" variant="ghost" className="-mr-2" onClick={() => setLogging(null)}>
            <PlusIcon />
            Log
          </Button>
        ) : undefined
      }
    >
      {series.length ? (
        <ul className="-mx-2">
          {series.map((list) => {
            const last = list.at(-1)!;
            const prev = list.at(-2);
            const delta = prev ? last.value - prev.value : null;
            return (
              <li key={last.label} className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-sunken">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => !readOnly && setLogging(last.label)} disabled={readOnly}>
                  <span className="block truncate text-[12.5px] text-muted">{last.label}</span>
                  <span className="flex items-baseline gap-1.5">
                    <span className="text-[15px] font-semibold text-primary tabular-nums">{fmt(last.value)}</span>
                    {delta !== null && delta !== 0 ? (
                      <span className="inline-flex items-center text-[11.5px] text-muted tabular-nums">
                        {delta > 0 ? <ArrowUpRightIcon className="size-3" aria-label="Up" /> : <ArrowDownRightIcon className="size-3" aria-label="Down" />}
                        {fmt(Math.abs(delta))}
                      </span>
                    ) : null}
                    <span className="text-[11.5px] text-faint">{formatDateOnly(last.period, tz)}</span>
                  </span>
                </button>
                <Spark values={list.map((m) => m.value)} />
                {!readOnly ? (
                  <Tooltip content="Delete the latest entry">
                    <button
                      type="button"
                      onClick={async () => {
                        if (!confirm(`Delete ${last.label}: ${fmt(last.value)} (${formatDateOnly(last.period, tz)})?`)) return;
                        const r = await deleteClientMetric(last.id);
                        if (!r.ok) toast.error(r.error);
                      }}
                      className="rounded p-1 text-faint opacity-0 group-hover:opacity-100 hover:text-error focus:opacity-100"
                      aria-label={`Delete the latest ${last.label} entry`}
                    >
                      <TrashIcon className="size-3.5" />
                    </button>
                  </Tooltip>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="py-1 text-[12.5px] text-muted">{readOnly ? "No numbers were logged while they were a client." : "Log the numbers that show how this client is doing, like leads, sales or hires. Each one tracks its trend."}</p>
      )}
      {logging !== false ? <LogMetric clientId={clientId} label={logging} labels={series.map((l) => l[0].label)} onClose={() => setLogging(false)} /> : null}
    </SideCard>
  );
}

function LogMetric({ clientId, label: initial, labels, onClose }: { clientId: string; label: string | null; labels: string[]; onClose: () => void }) {
  const { workspace } = useApp();
  const [label, setLabel] = useState(initial ?? "");
  const [value, setValue] = useState("");
  const [period, setPeriod] = useState(dayFromToday(workspace.timezone));
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const save = () =>
    start(async () => {
      const n = Number(value.replace(/[,\s]/g, ""));
      if (!value.trim() || !Number.isFinite(n)) return void toast.error("Enter the number, like 42 or 3.5.");
      const r = await logClientMetric(clientId, { label, value: n, period, note: note || null });
      if (!r.ok) return void toast.error(r.error);
      toast.success(`${label} logged`);
      onClose();
    });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Log a number"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={save}>
            Log it
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="What" className="sm:col-span-2">
          {(p) => (
            <>
              <Input {...p} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Leads, revenue, hires…" list="metric-labels" autoFocus={!initial} />
              <datalist id="metric-labels">
                {labels.map((l) => (
                  <option key={l} value={l} />
                ))}
              </datalist>
            </>
          )}
        </Field>
        <Field label="Value">{(p) => <Input {...p} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} autoFocus={!!initial} />}</Field>
        <Field label="For">{(p) => <Input {...p} type="date" value={period} onChange={(e) => setPeriod(e.target.value)} />}</Field>
        <Field label="Note" optional className="sm:col-span-2">
          {(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

// ─── Account ─────────────────────────────────────────────────────────────

/** How much contact there's been: the account manager's at-a-glance view of whether a client is being looked after. */
export function AccountCard({ summary }: { summary: { last30: number; last90: number; inbound90: number; lastAt: string | null; quiet: boolean } }) {
  const { workspace } = useApp();
  const quiet = summary.quiet;
  return (
    <SideCard title="Account">
      <dl className="grid grid-cols-3 gap-2 py-1">
        <Stat label="Last contact" value={summary.lastAt ? formatAgo(summary.lastAt, workspace.timezone) : "Never"} warn={quiet} />
        <Stat label="Last 30 days" value={String(summary.last30)} />
        <Stat label="Last 90 days" value={String(summary.last90)} detail={summary.last90 ? `${summary.inbound90} from them` : undefined} />
      </dl>
      {quiet ? <p className="mt-1 text-[12px] text-warning">No calls, emails or meetings in over a month. Schedule a check-in.</p> : null}
    </SideCard>
  );
}

function Stat({ label, value, detail, warn }: { label: string; value: string; detail?: string; warn?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[11.5px] text-muted">{label}</dt>
      <dd className={clsx("truncate text-[14px] font-semibold tabular-nums", warn ? "text-warning" : "text-primary")} suppressHydrationWarning>
        {value}
      </dd>
      {detail ? <dd className="truncate text-[11px] text-faint">{detail}</dd> : null}
    </div>
  );
}

// ─── Stripe ──────────────────────────────────────────────────────────────

/** Finds a Stripe customer by email, name or ID and links it, so their billing shows here. */
export function StripeLinker({ clientId, suggest, linked }: { clientId: string; suggest: string | null; linked: string | null }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(suggest ?? "");
  const [results, setResults] = useState<{ id: string; name: string | null; email: string | null }[] | null>(null);
  const [pending, start] = useTransition();
  const search = () =>
    start(async () => {
      const r = await findStripeCustomers(q);
      if (!r.ok) return void toast.error(r.error);
      setResults(r.data);
    });
  const link = (id: string | null) =>
    start(async () => {
      const r = await linkStripeCustomer(clientId, id);
      if (!r.ok) return void toast.error(r.error);
      toast.success(id ? "Stripe customer linked" : "Stripe customer unlinked");
      setOpen(false);
    });
  return (
    <>
      {linked ? (
        <Menu>
          <MenuTrigger asChild>
            <Button size="sm" variant="ghost" className="-mr-2" loading={pending}>
              <LinkIcon />
              Linked
            </Button>
          </MenuTrigger>
          <MenuContent className="w-48">
            <MenuItem onSelect={() => setOpen(true)}>Link another customer</MenuItem>
            <MenuItem destructive onSelect={() => link(null)}>
              Unlink
            </MenuItem>
          </MenuContent>
        </Menu>
      ) : (
        <Button size="sm" variant="ghost" className="-mr-2" onClick={() => setOpen(true)}>
          <LinkIcon />
          Link customer
        </Button>
      )}
      {open ? (
        <Dialog open onOpenChange={(o) => !o && setOpen(false)} title="Link a Stripe customer" description="Search by email, name, or paste a customer ID (cus_…)." size="sm">
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
                  <li key={c.id}>
                    <button type="button" onClick={() => link(c.id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-sunken" disabled={pending}>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-primary">{c.name ?? c.email ?? c.id}</span>
                        <span className="block truncate text-[11.5px] text-muted">{[c.email, c.id].filter(Boolean).join(" · ")}</span>
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
      ) : null}
    </>
  );
}
