"use client";

import clsx from "clsx";
import { CheckCircleIcon } from "@heroicons/react/24/outline";
import { useApp } from "@/components/app-context";
import { activityIcons } from "@/components/activity/composer";
import { ActivityItem, PlannedItem } from "@/components/activity/timeline";
import { PageHeader } from "@/components/shell/app-shell";
import { FilterTabs, Toolbar } from "@/components/table/toolbar";
import { useListParams } from "@/components/table/use-params";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/field";
import type { ActivityRow } from "@/lib/crm/activities";
import { activityLabels, activityTypes, type ActivityType } from "@/lib/constants";
import { dayKey, dayFromToday } from "@/lib/format";

const anywhere = { type: "person" as const, id: "" };

/**
 * Everything planned, grouped the way people think about it (overdue, today,
 * tomorrow, this week, later), or everything done. Filter by teammate and type.
 */
export function ActivitiesView({ rows, status }: { rows: ActivityRow[]; status: "todo" | "done" }) {
  const { team, viewer, workspace } = useApp();
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
      <PageHeader title="Activities" />
      <Toolbar>
        <FilterTabs
          param="status"
          fallback="todo"
          options={[
            { value: "todo", label: "To do" },
            { value: "done", label: "Done" },
          ]}
        />
        <Select value={get("who") ?? "me"} onChange={(e) => set({ who: e.target.value === "me" ? null : e.target.value })} aria-label="Assigned to" className="w-44 [&_select]:h-8 [&_select]:text-[13px]">
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
        <div className="flex flex-wrap gap-1" role="group" aria-label="Types">
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
                  "flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12.5px] font-medium transition-colors",
                  on ? "border-accent bg-accent-soft text-primary" : "border-line text-muted hover:border-line-strong hover:text-secondary",
                )}
              >
                <Icon className="size-3.5" aria-hidden />
                {activityLabels[t]}
              </button>
            );
          })}
        </div>
      </Toolbar>
      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 pb-10 lg:px-6">
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
                {g.label ? (
                  <h2 className={clsx("mb-2 text-[13px] font-semibold", g.tone)}>
                    {g.label} <span className="font-medium text-muted tabular-nums">{g.rows.length}</span>
                  </h2>
                ) : null}
                {status === "todo" ? (
                  <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
                    {g.rows.map((row) => (
                      <PlannedItem key={row.activity.id} row={row} context={anywhere} />
                    ))}
                  </ul>
                ) : (
                  <ol className="relative flex flex-col gap-2 before:absolute before:top-2 before:bottom-2 before:left-[15px] before:w-px before:bg-line">
                    {g.rows.map((row) => (
                      <ActivityItem key={row.activity.id} row={row} context={anywhere} />
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
