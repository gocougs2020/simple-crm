"use client";

import clsx from "clsx";
import { useState, useTransition } from "react";
import { CheckCircleIcon } from "@heroicons/react/24/outline";
import { deleteActivities, setCompletedMany } from "@/actions/activities";
import { useApp } from "@/components/app-context";
import { activityIcons } from "@/components/activity/composer";
import { ActivityItem, PlannedItem } from "@/components/activity/timeline";
import { PageHeader } from "@/components/shell/app-shell";
import { FilterTabs } from "@/components/table/toolbar";
import { useListParams } from "@/components/table/use-params";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { BulkButton } from "@/components/clients/bulk-button";
import type { ActivityRow } from "@/lib/crm/activities";
import { activityLabels, activityTypes, type ActivityType } from "@/lib/constants";
import { dayKey, dayFromToday } from "@/lib/format";
import { AddActivity } from "./add-activity";

const anywhere = { type: "person" as const, id: "" };

/**
 * Everything planned, grouped the way people think about it (overdue, today,
 * tomorrow, this week, later), or everything done. Filter by teammate and type.
 */
export function ActivitiesView({ rows, status }: { rows: ActivityRow[]; status: "todo" | "done" }) {
  const { team, viewer, workspace, canEdit } = useApp();
  // Picked for a bulk action. Only what's still listed counts, so changing a filter drops the rest.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, startBulk] = useTransition();
  const selected = rows.filter((r) => picked.has(r.activity.id)).map((r) => r.activity.id);
  const toggle = (ids: string[], on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const clear = () => setPicked(new Set());
  const selection = (id: string) => (canEdit ? { selected: picked.has(id), onToggle: () => toggle([id], !picked.has(id)) } : undefined);
  const report = (r: Awaited<ReturnType<typeof deleteActivities>>, did: string, undo?: () => void) => {
    if (!r.ok) return void toast.error(r.error);
    const { count, skipped, reason } = r.data;
    if (count) toast.success(`${count} ${count === 1 ? "activity" : "activities"} ${did}`, undo ? { label: "Undo", onClick: undo } : undefined);
    if (skipped) toast.error(`${skipped} ${skipped === 1 ? "wasn't" : "weren't"} changed. ${reason ?? ""}`.trim());
    clear();
  };
  const completeSelected = () =>
    startBulk(async () => {
      const ids = selected;
      report(await setCompletedMany(ids, true), "marked done", () => void setCompletedMany(ids, false));
    });
  const deleteSelected = () => {
    if (!confirm(`Delete ${selected.length} ${selected.length === 1 ? "activity" : "activities"}? This can't be undone.`)) return;
    startBulk(async () => report(await deleteActivities(selected), "deleted"));
  };
  const { get, set } = useListParams();
  const tz = workspace.timezone;
  const types = (get("type")?.split(",").filter(Boolean) ?? []) as ActivityType[];

  const today = dayFromToday(tz);
  const tomorrow = dayFromToday(tz, 1);
  const weekEnd = dayFromToday(tz, 7);
  const groups =
    status === "todo"
      ? [
          { label: "Overdue", tone: "text-error", rows: rows.filter((r) => dayKey(r.activity.dueAt!, tz) < today) },
          { label: "Today", tone: "text-primary", rows: rows.filter((r) => dayKey(r.activity.dueAt!, tz) === today) },
          { label: "Tomorrow", tone: "text-primary", rows: rows.filter((r) => dayKey(r.activity.dueAt!, tz) === tomorrow) },
          { label: "Next 7 days", tone: "text-primary", rows: rows.filter((r) => dayKey(r.activity.dueAt!, tz) > tomorrow && dayKey(r.activity.dueAt!, tz) <= weekEnd) },
          { label: "Later", tone: "text-primary", rows: rows.filter((r) => dayKey(r.activity.dueAt!, tz) > weekEnd) },
        ]
      : [{ label: "", tone: "", rows }];

  return (
    <>
      <PageHeader title="Activities">
        <AddActivity />
      </PageHeader>
      <div className="flex items-center gap-2 px-4 py-3 lg:px-6">
        <FilterTabs
          param="status"
          fallback="todo"
          options={[
            { value: "todo", label: "To do" },
            { value: "done", label: "Done" },
          ]}
        />
        <Select value={get("who") ?? "me"} onChange={(e) => set({ who: e.target.value === "me" ? null : e.target.value })} aria-label="Assigned to" className="w-44 min-w-0 max-sm:flex-1 [&_select]:h-8 pointer-coarse:[&_select]:h-10 [&_select]:text-[13px]">
          <option value="me">Assigned to me</option>
          <option value="all">Everyone</option>
          <optgroup label="Teammates">
            {team
              .filter((m) => m.id !== viewer.id && m.active)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
          </optgroup>
        </Select>
      </div>
      {/* Types get their own row: on a phone all six fit across, icon over label. */}
      <div className="-mt-1 px-4 pb-4 lg:px-6" role="group" aria-label="Types">
        <div className="grid grid-cols-6 gap-1.5 sm:flex sm:flex-wrap sm:gap-1">
          {activityTypes.map((t) => {
            const on = types.includes(t);
            const Icon = activityIcons[t];
            return (
              <button
                key={t}
                type="button"
                aria-pressed={on}
                onClick={() => set({ type: (on ? types.filter((x) => x !== t) : [...types, t]).join(",") || null })}
                className={clsx(
                  "flex min-w-0 items-center justify-center rounded-md border font-medium transition-colors",
                  "h-13 flex-col gap-1 px-1 text-[11.5px] sm:h-8 sm:flex-row sm:gap-1.5 sm:px-2.5 sm:text-[12.5px]",
                  on ? "border-accent bg-accent-soft text-primary" : "border-line bg-surface text-muted hover:border-line-strong hover:text-secondary",
                )}
              >
                <Icon className="size-[18px] shrink-0 sm:size-3.5" aria-hidden />
                <span className="max-w-full truncate">{activityLabels[t]}</span>
              </button>
            );
          })}
        </div>
      </div>
      {/* Lined up on the left with the filters above, not centered. */}
      <div className="flex max-w-4xl flex-col gap-6 px-4 pb-10 lg:px-6">
        {selected.length ? (
          <div className={clsx("sticky top-[calc(var(--shell-top)+0.5rem)] z-20 -mb-3 flex animate-pop-in items-center gap-3 rounded-lg border border-line bg-primary px-3 py-2 text-[13px] text-white shadow-md lg:top-2", busy && "opacity-70")}>
            <span className="font-medium tabular-nums">{selected.length} selected</span>
            <div className="flex flex-1 flex-wrap items-center gap-2">
              {status === "todo" ? <BulkButton onClick={completeSelected}>Mark done</BulkButton> : null}
              <BulkButton onClick={deleteSelected}>Delete</BulkButton>
            </div>
            <button type="button" onClick={clear} className="text-white/70 hover:text-white">
              Clear
            </button>
          </div>
        ) : null}
        {!rows.length ? (
          <EmptyState
            icon={CheckCircleIcon}
            title={status === "todo" ? "Nothing to do" : "Nothing done yet"}
            description={status === "todo" ? "Tasks, calls and meetings you plan from any record show up here." : "Completed tasks and logged activity show up here."}
          />
        ) : (
          groups
            .filter((g) => g.rows.length)
            .map((g) => (
              <section key={g.label || "all"} aria-label={g.label || "Done"}>
                {g.label || canEdit ? (
                  <div className="mb-2 flex items-center gap-2">
                    {canEdit ? (
                      <input
                        type="checkbox"
                        checked={g.rows.every((r) => picked.has(r.activity.id))}
                        onChange={(e) => toggle(g.rows.map((r) => r.activity.id), e.target.checked)}
                        aria-label={`Select all ${g.label ? g.label.toLowerCase() : "done"}`}
                        className={clsx("size-4 cursor-pointer rounded-sm border-line-strong accent-[var(--accent)] pointer-coarse:size-5", status === "todo" ? "ml-3.5" : "ml-2")}
                      />
                    ) : null}
                    <h2 className={clsx("text-[13px] font-semibold", g.label ? g.tone : "text-muted")}>
                      {g.label || "Select all"} <span className="font-medium text-muted tabular-nums">{g.label ? g.rows.length : ""}</span>
                    </h2>
                  </div>
                ) : null}
                {status === "todo" ? (
                  <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
                    {g.rows.map((row) => (
                      <PlannedItem key={row.activity.id} row={row} context={anywhere} selection={selection(row.activity.id)} />
                    ))}
                  </ul>
                ) : (
                  <ol className="relative flex flex-col gap-2 before:absolute before:top-2 before:bottom-2 before:left-[15px] before:w-px before:bg-line">
                    {g.rows.map((row) => (
                      <ActivityItem key={row.activity.id} row={row} context={anywhere} selection={selection(row.activity.id)} />
                    ))}
                  </ol>
                )}
              </section>
            ))
        )}
      </div>
    </>
  );
}
