"use client";

import clsx from "clsx";
import { useState, useTransition } from "react";
import { ArrowUturnLeftIcon, TrophyIcon } from "@heroicons/react/20/solid";
import { moveDeal, setDealStatus } from "@/actions/records";
import { useApp } from "@/components/app-context";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { Tooltip } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { lostReasons, type DealStatus } from "@/lib/constants";
import { daysSince, formatDay } from "@/lib/format";

/**
 * The pipeline as a row of steps. Click any stage to move the deal there;
 * the header shows how long the deal has sat in the current one.
 */
export function StageBar({ dealId, stageId, status, stageChangedAt }: { dealId: string; stageId: string; status: DealStatus; stageChangedAt: Date }) {
  const { stage } = useApp();
  const current = stage(stageId);
  const [pending, start] = useTransition();
  const [optimistic, setOptimistic] = useState<string | null>(null);
  if (!current) return null;
  const stages = current.pipeline.stages;
  const activeIndex = stages.findIndex((s) => s.id === (optimistic ?? stageId));
  const days = daysSince(stageChangedAt);
  const rotting = status === "open" && current.rottingDays !== null && days >= current.rottingDays;
  return (
    <div className="px-4 pb-4 lg:px-6">
      <div className="mb-1.5 flex items-center justify-between gap-3 text-[12px] text-muted">
        <span>{current.pipeline.name} pipeline</span>
        {status === "open" ? (
          <span className={clsx(rotting && "font-medium text-warning")}>
            In {current.name} for {days === 0 ? "less than a day" : `${days} day${days === 1 ? "" : "s"}`}
            {rotting ? " · needs attention" : ""}
          </span>
        ) : null}
      </div>
      <ol className="flex gap-0.5" aria-label="Stages">
        {stages.map((s, i) => {
          const reached = i <= activeIndex;
          const isCurrent = i === activeIndex;
          return (
            <li key={s.id} className="min-w-0 flex-1">
              <Tooltip content={`${s.name} · ${s.probability}% likely to win`}>
                <button
                  type="button"
                  disabled={pending || status !== "open" || isCurrent}
                  onClick={() =>
                    start(async () => {
                      setOptimistic(s.id);
                      const r = await moveDeal(dealId, s.id);
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
                    status === "won"
                      ? "bg-success-surface text-success"
                      : status === "lost"
                        ? "bg-sunken text-faint"
                        : reached
                          ? "bg-accent text-accent-foreground"
                          : "bg-sunken text-muted hover:bg-line hover:text-primary",
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

/** Won / Lost buttons for an open deal; the outcome and Reopen for a closed one. */
export function DealOutcome({ dealId, status, lostReason, closedAt }: { dealId: string; status: DealStatus; lostReason: string | null; closedAt: Date | null }) {
  const { workspace } = useApp();
  const [pending, start] = useTransition();
  const [losing, setLosing] = useState(false);
  const [reason, setReason] = useState("");

  const set = (input: Parameters<typeof setDealStatus>[1], message: string) =>
    start(async () => {
      const r = await setDealStatus(dealId, input);
      if (!r.ok) return void toast.error(r.error);
      toast.success(message, input.status !== "open" ? { label: "Undo", onClick: () => setDealStatus(dealId, { status: "open" }) } : undefined);
      setLosing(false);
    });

  if (status !== "open")
    return (
      <div className="flex items-center gap-2">
        <StatusBadge tone={status === "won" ? "success" : "error"} icon={status === "won" ? <TrophyIcon /> : undefined}>
          {status === "won" ? "Won" : "Lost"}
          {closedAt ? ` · ${formatDay(closedAt, workspace.timezone)}` : ""}
        </StatusBadge>
        {lostReason ? <span className="max-w-48 truncate text-[12.5px] text-muted">“{lostReason}”</span> : null}
        <Button size="sm" variant="outline" loading={pending} onClick={() => set({ status: "open" }, "Deal reopened")}>
          <ArrowUturnLeftIcon />
          Reopen
        </Button>
      </div>
    );

  return (
    <>
      <Button variant="outline" className="border-success-border text-success hover:bg-success-surface" loading={pending} onClick={() => set({ status: "won" }, "Deal won")}>
        <TrophyIcon />
        Won
      </Button>
      <Button variant="outline" className="border-error-border text-error hover:bg-error-surface" onClick={() => setLosing(true)}>
        Lost
      </Button>
      {losing ? (
        <Dialog
          open
          onOpenChange={(o) => !o && setLosing(false)}
          title="Mark as lost"
          description="The reason helps the team see what isn't working."
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setLosing(false)}>
                Cancel
              </Button>
              <Button variant="destructive" loading={pending} onClick={() => set({ status: "lost", reason }, "Deal marked lost")}>
                Mark as lost
              </Button>
            </>
          }
        >
          <div className="flex flex-wrap gap-1.5">
            {lostReasons.map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={reason === r}
                onClick={() => setReason(r)}
                className={clsx("h-7 rounded-full border px-2.5 text-[12.5px] font-medium", reason === r ? "border-accent bg-accent text-accent-foreground" : "border-line text-secondary hover:border-line-strong")}
              >
                {r}
              </button>
            ))}
          </div>
          <Field label="Reason" optional className="mt-4">
            {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Or write your own" />}
          </Field>
        </Dialog>
      ) : null}
    </>
  );
}
