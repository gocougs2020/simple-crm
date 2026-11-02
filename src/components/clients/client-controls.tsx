"use client";

import clsx from "clsx";
import { useMemo, useState, useTransition } from "react";
import { ArrowUturnLeftIcon, ArrowRightStartOnRectangleIcon, CheckBadgeIcon, ChevronDownIcon } from "@heroicons/react/20/solid";
import { changeClientCategory, moveClient } from "@/actions/clients";
import { useApp } from "@/components/app-context";
import { StatusBadge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Select } from "@/components/ui/field";
import { Menu, MenuContent, MenuItem, MenuTrigger, Tooltip } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { churnReasons, clientCategoryLabels, clientHealthLabels, type ClientCategory, type ClientHealth } from "@/lib/constants";
import { dayFromToday, daysSince, formatDateOnly } from "@/lib/format";

const categoryTone: Record<ClientCategory, Tone> = { prospective: "info", current: "success", past: "neutral" };
const healthTone: Record<ClientHealth, Tone> = { good: "success", watch: "warning", at_risk: "error" };

export function CategoryBadge({ category }: { category: ClientCategory }) {
  return <StatusBadge tone={categoryTone[category]}>{clientCategoryLabels[category].one}</StatusBadge>;
}

export function HealthBadge({ health }: { health: ClientHealth | null }) {
  if (!health) return null;
  return <StatusBadge tone={healthTone[health]}>{clientHealthLabels[health]}</StatusBadge>;
}

/**
 * The client's pipeline as a row of steps. Click any stage to move there; the
 * header shows how long they've sat in the current one.
 */
export function StageBar({ clientId, stageId, category, stageChangedAt }: { clientId: string; stageId: string; category: ClientCategory; stageChangedAt: Date }) {
  const { stage } = useApp();
  const current = stage(stageId);
  const [pending, start] = useTransition();
  const [optimistic, setOptimistic] = useState<string | null>(null);
  if (!current) return null;
  const stages = current.pipeline.stages;
  const activeIndex = stages.findIndex((s) => s.id === (optimistic ?? stageId));
  const days = daysSince(stageChangedAt);
  const rotting = current.rottingDays !== null && days >= current.rottingDays;
  return (
    <div className="px-4 pb-4 lg:px-6">
      <div className="mb-1.5 flex items-center justify-between gap-3 text-[12px] text-muted">
        <span>
          {current.pipeline.name} · {clientCategoryLabels[category].one.toLowerCase()} clients
        </span>
        <span className={clsx(rotting && "font-medium text-warning")}>
          In {current.name} for {days === 0 ? "less than a day" : `${days} day${days === 1 ? "" : "s"}`}
          {rotting ? " · needs attention" : ""}
        </span>
      </div>
      <ol className="flex gap-0.5" aria-label="Stages">
        {stages.map((s, i) => {
          const reached = i <= activeIndex;
          const isCurrent = i === activeIndex;
          return (
            <li key={s.id} className="min-w-0 flex-1">
              <Tooltip content={category === "prospective" ? `${s.name} · ${s.probability}% likely to sign` : s.name}>
                <button
                  type="button"
                  disabled={pending || isCurrent}
                  onClick={() =>
                    start(async () => {
                      setOptimistic(s.id);
                      const r = await moveClient(clientId, s.id);
                      setOptimistic(null);
                      if (!r.ok) toast.error(r.error);
                      else toast.success(`Moved to ${s.name}`);
                    })
                  }
                  aria-current={isCurrent ? "step" : undefined}
                  className={clsx(
                    "flex h-8 w-full items-center justify-center px-3 text-[12px] font-medium transition-colors disabled:cursor-default",
                    i === 0 ? "rounded-l-md [clip-path:polygon(0_0,calc(100%-8px)_0,100%_50%,calc(100%-8px)_100%,0_100%)]" : "[clip-path:polygon(0_0,calc(100%-8px)_0,100%_50%,calc(100%-8px)_100%,0_100%,8px_50%)]",
                    i === stages.length - 1 && "rounded-r-md [clip-path:polygon(0_0,100%_0,100%_100%,0_100%,8px_50%)]",
                    reached ? "bg-accent text-accent-foreground" : "bg-sunken text-muted hover:bg-line hover:text-primary",
                  )}
                >
                  <span className="truncate">{s.name}</span>
                </button>
              </Tooltip>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Where a client can go from each category, with the words for the button. */
export const moves: Record<ClientCategory, { to: ClientCategory; label: string; primary?: boolean }[]> = {
  prospective: [{ to: "current", label: "Signed", primary: true }],
  current: [
    { to: "past", label: "Left", primary: true },
    { to: "prospective", label: "Move back to prospects" },
  ],
  past: [
    { to: "current", label: "Won back", primary: true },
    { to: "prospective", label: "Move to prospects" },
  ],
};

const moveIcons: Record<ClientCategory, typeof CheckBadgeIcon> = { current: CheckBadgeIcon, past: ArrowRightStartOnRectangleIcon, prospective: ArrowUturnLeftIcon };

/** The record header's category buttons: sign a prospect, mark a client as left, win one back. */
export function CategoryActions({ clientId, name, category, previousServiceIds }: { clientId: string; name: string; category: ClientCategory; previousServiceIds?: string[] }) {
  const [to, setTo] = useState<ClientCategory | null>(null);
  const [primary, ...rest] = moves[category];
  const Icon = moveIcons[primary.to];
  return (
    <>
      <div className="flex">
        <Button variant="outline" className={clsx(rest.length && "rounded-r-none")} onClick={() => setTo(primary.to)}>
          <Icon />
          {primary.label}
        </Button>
        {rest.length ? (
          <Menu>
            <MenuTrigger asChild>
              <Button variant="outline" size="icon" className="-ml-px rounded-l-none" aria-label="Other category moves">
                <ChevronDownIcon />
              </Button>
            </MenuTrigger>
            <MenuContent className="w-56">
              {rest.map((m) => (
                <MenuItem key={m.to} onSelect={() => setTo(m.to)}>
                  {m.label}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        ) : null}
      </div>
      {to ? <ChangeCategoryDialog clientId={clientId} name={name} from={category} to={to} previousServiceIds={previousServiceIds} onClose={() => setTo(null)} /> : null}
    </>
  );
}

/**
 * Asks what moving a client needs: the date, the stage they land in, and for
 * leaving, why and whether they'd come back; for signing, which services start.
 */
export function ChangeCategoryDialog({
  clientId,
  name,
  from,
  to,
  previousServiceIds,
  onClose,
  onDone,
}: {
  clientId: string;
  name: string;
  from: ClientCategory;
  to: ClientCategory;
  /** Winning a past client back: what they had before, offered again. */
  previousServiceIds?: string[];
  onClose: () => void;
  onDone?: () => void;
}) {
  const { pipelines, catalog, workspace } = useApp();
  const options = useMemo(() => pipelines.filter((p) => p.category === to).flatMap((p) => p.stages.map((s) => ({ id: s.id, label: pipelines.filter((x) => x.category === to).length > 1 ? `${p.name}: ${s.name}` : s.name }))), [pipelines, to]);
  const [stageId, setStageId] = useState(options[0]?.id ?? "");
  const [on, setOn] = useState(dayFromToday(workspace.timezone));
  const [reason, setReason] = useState("");
  const [openToReturn, setOpenToReturn] = useState(true);
  const [endServices, setEndServices] = useState(true);
  const [serviceIds, setServiceIds] = useState<string[]>(() => (from === "past" ? (previousServiceIds ?? []).filter((id) => catalog.some((s) => s.id === id && !s.archivedAt)) : []));
  const [pending, start] = useTransition();
  const title = to === "current" ? (from === "past" ? `Win back ${name}` : `${name} signed`) : to === "past" ? `${name} left` : `Move ${name} to prospects`;

  const submit = () =>
    start(async () => {
      const r = await changeClientCategory(clientId, {
        category: to,
        stageId: stageId || null,
        on: to === "prospective" ? null : on,
        churnReason: to === "past" ? reason || null : null,
        openToReturn,
        endServices,
        serviceIds: to === "current" ? serviceIds : undefined,
      });
      if (!r.ok) return void toast.error(r.error);
      toast.success(to === "current" ? `${name} is now a current client` : to === "past" ? `${name} moved to past clients` : `${name} moved to prospects`);
      onDone?.();
      onClose();
    });

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={clientCategoryLabels[to].hint}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={submit} disabled={!options.length}>
            {to === "current" ? "Make current client" : to === "past" ? "Move to past clients" : "Move to prospects"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!options.length ? (
          <p className="text-[13px] text-error">There&apos;s no pipeline for {clientCategoryLabels[to].one.toLowerCase()} clients yet. Add one in Settings → Pipelines.</p>
        ) : (
          <Field label="Stage">
            {(p) => (
              <Select id={p.id} value={stageId} onChange={(e) => setStageId(e.target.value)}>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {to !== "prospective" ? <Field label={to === "current" ? "Client since" : "Left on"}>{(p) => <Input {...p} type="date" value={on} onChange={(e) => setOn(e.target.value)} className="w-44" />}</Field> : null}
        {to === "past" ? (
          <>
            <div>
              <p className="mb-1.5 text-[13px] font-medium text-primary">Why they left</p>
              <div className="flex flex-wrap gap-1.5">
                {churnReasons.map((r) => (
                  <Chip key={r} on={reason === r} onClick={() => setReason(reason === r ? "" : r)}>
                    {r}
                  </Chip>
                ))}
              </div>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Or write your own" className="mt-2" aria-label="Reason" />
            </div>
            <Checkbox checked={openToReturn} onChange={(e) => setOpenToReturn(e.target.checked)} label="Open to coming back (include in win-back campaigns)" />
            {from === "current" ? <Checkbox checked={endServices} onChange={(e) => setEndServices(e.target.checked)} label="End their services on the same day" /> : null}
          </>
        ) : null}
        {to === "current" && catalog.some((s) => !s.archivedAt) ? (
          <div>
            <p className="mb-1.5 text-[13px] font-medium text-primary">
              Start services <span className="font-normal text-muted">(optional)</span>
            </p>
            <div className="flex flex-wrap gap-1.5">
              {catalog
                .filter((s) => !s.archivedAt)
                .map((s) => (
                  <Chip key={s.id} on={serviceIds.includes(s.id)} onClick={() => setServiceIds(serviceIds.includes(s.id) ? serviceIds.filter((x) => x !== s.id) : [...serviceIds, s.id])}>
                    {s.name}
                  </Chip>
                ))}
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

export function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={clsx("h-7 rounded-full border px-2.5 text-[12.5px] font-medium", on ? "border-accent bg-accent text-accent-foreground" : "border-line text-secondary hover:border-line-strong")}
    >
      {children}
    </button>
  );
}

/** "Client since March 4, 2026", "Left on …", "Expected to sign …": the date that matters for the category. */
export function CategoryDate({ category, startedOn, endedOn, expectedCloseDate }: { category: ClientCategory; startedOn: string | null; endedOn: string | null; expectedCloseDate: string | null }) {
  const tz = useApp().workspace.timezone;
  if (category === "current" && startedOn) return <span>Client since {formatDateOnly(startedOn, tz)}</span>;
  if (category === "past" && endedOn) return <span>Left {formatDateOnly(endedOn, tz)}</span>;
  if (category === "prospective" && expectedCloseDate) return <span>Expected to sign {formatDateOnly(expectedCloseDate, tz)}</span>;
  return null;
}
