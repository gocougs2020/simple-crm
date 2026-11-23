"use client";

import { useState, useTransition } from "react";
import { ArrowDownRightIcon, ArrowUpRightIcon, PlusIcon, TrashIcon } from "@heroicons/react/20/solid";
import { deleteClientMetric, logClientMetric } from "@/actions/clients";
import { useApp } from "@/components/app-context";
import { SideCard } from "@/components/records/inline-field";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { Tooltip } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import type { schema } from "@/db";
import { dayFromToday, formatDateOnly } from "@/lib/format";

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
  // Nothing logged yet: an offer to start, not a whole empty card.
  if (!series.length && !readOnly)
    return (
      <>
        <Button size="sm" variant="ghost" className="self-start text-muted" onClick={() => setLogging(null)}>
          <PlusIcon />
          Track a number, like leads or sales
        </Button>
        {logging !== false ? <LogMetric clientId={clientId} label={logging} labels={[]} onClose={() => setLogging(false)} /> : null}
      </>
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

// ─── Stripe ──────────────────────────────────────────────────────────────
