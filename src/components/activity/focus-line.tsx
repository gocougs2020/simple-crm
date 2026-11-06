"use client";

import clsx from "clsx";
import { useState } from "react";
import { ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import { useApp } from "@/components/app-context";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ActivityRow } from "@/lib/crm/activities";
import { activityLabels, type ClientCategory, type EntityType } from "@/lib/constants";
import { dueTone, formatAgo, formatDay, formatTime } from "@/lib/format";
import { activityIcons } from "./composer";
import { ScheduleNext } from "./schedule-next";

const QUIET_DAYS = 30;

/**
 * One line at the top of a record that says where to focus: the next planned
 * step (or that there isn't one) and when anyone last talked to them. For
 * prospects and current clients a missing next step offers to schedule one in
 * place, and a current client nobody has talked to in a month is flagged.
 */
export function FocusLine({ planned, lastContactAt, context }: { planned: ActivityRow[]; lastContactAt: string | null; context: { type: EntityType; id: string; category?: ClientCategory } }) {
  const { workspace, member, viewer } = useApp();
  const tz = workspace.timezone;
  const [scheduling, setScheduling] = useState(false);
  const [now] = useState(() => Date.now());
  const next = planned[0]?.activity;
  const activeClient = context.type === "client" && context.category !== "past";
  const missing = !next && activeClient;
  const quiet = context.type === "client" && context.category === "current" && (!lastContactAt || now - new Date(lastContactAt).getTime() > QUIET_DAYS * 86_400_000);
  const assignee = next ? member(next.assigneeId) : undefined;
  const Icon = next ? activityIcons[next.type] : null;

  return (
    <section aria-label="Where to focus" className={clsx("rounded-xl border px-3.5 py-2.5", missing || quiet ? "border-warning-border bg-warning-surface/50" : "border-line bg-surface")}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px]">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          {next && Icon ? (
            <>
              <span className="text-muted">Next</span>
              <Icon className="size-4 shrink-0 text-muted" aria-label={activityLabels[next.type]} />
              <span className="min-w-0 truncate font-medium text-primary">{next.subject || activityLabels[next.type]}</span>
              <StatusBadge tone={dueTone(next.dueAt!, tz)}>
                <span suppressHydrationWarning>
                  {dueTone(next.dueAt!, tz) === "error" ? "Overdue · " : ""}
                  {formatDay(next.dueAt!, tz)}
                  {next.dueHasTime ? ` ${formatTime(next.dueAt!, tz)}` : ""}
                </span>
              </StatusBadge>
              {assignee ? <span className="text-muted">{assignee.id === viewer.id ? "You" : assignee.name}</span> : null}
              {planned.length > 1 ? <span className="text-faint">+{planned.length - 1} more planned</span> : null}
            </>
          ) : missing ? (
            <>
              <span className="flex items-center gap-1.5 font-medium text-warning">
                <ExclamationTriangleIcon className="size-4" aria-hidden />
                No next step planned
              </span>
              {!scheduling ? (
                <Button size="sm" variant="outline" className="h-7" onClick={() => setScheduling(true)}>
                  Schedule one
                </Button>
              ) : null}
            </>
          ) : (
            <span className="text-muted">Nothing planned</span>
          )}
        </div>
        <span className={clsx("shrink-0", quiet ? "font-medium text-warning" : "text-muted")} suppressHydrationWarning>
          {lastContactAt ? `Last contact ${formatAgo(lastContactAt, tz)}` : "No contact logged yet"}
          {quiet ? ". Time for a check-in." : ""}
        </span>
      </div>
      {missing && scheduling ? (
        <div className="mt-2.5 border-t border-warning-border pt-2.5">
          <ScheduleNext clientId={context.id} compact onDone={() => setScheduling(false)} />
        </div>
      ) : null}
    </section>
  );
}
