"use client";

import { ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import { useApp } from "@/components/app-context";
import { activityIcons } from "@/components/activity/composer";
import { Avatar } from "@/components/ui/avatar";
import { StatusBadge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/menu";
import type { ActivityType } from "@/lib/constants";
import { dueTone, formatAgo, formatDay, formatFull, formatTime } from "@/lib/format";

export type NextActivity = { id: string; type: string; subject: string | null; dueAt: string | null; dueHasTime: boolean } | null;

/** The next planned step, as a due badge. Open deals with nothing planned get a warning instead. */
export function NextActivityCell({ next, warnIfNone }: { next: NextActivity; warnIfNone?: boolean }) {
  const { workspace } = useApp();
  if (!next?.dueAt)
    return warnIfNone ? (
      <span className="inline-flex items-center gap-1 text-[12.5px] text-warning">
        <ExclamationTriangleIcon className="size-3.5" aria-hidden />
        Nothing planned
      </span>
    ) : (
      <span className="text-faint">—</span>
    );
  const tz = workspace.timezone;
  const Icon = activityIcons[next.type as ActivityType];
  const tone = dueTone(next.dueAt, tz);
  return (
    <Tooltip content={`${next.subject ?? next.type} · ${formatFull(next.dueAt, tz)}`}>
      <span className="inline-flex max-w-full items-center gap-1.5">
        <StatusBadge tone={tone} icon={Icon ? <Icon /> : undefined}>
          {formatDay(next.dueAt, tz)}
          {next.dueHasTime ? ` ${formatTime(next.dueAt, tz)}` : ""}
        </StatusBadge>
        <span className="truncate text-[12.5px] text-muted">{next.subject}</span>
      </span>
    </Tooltip>
  );
}

export function OwnerCell({ id }: { id: string | null }) {
  const { member } = useApp();
  const m = member(id);
  if (!m) return <span className="text-faint">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <Avatar name={m.name} size="xs" />
      <span className="truncate text-[13px] text-secondary">{m.name}</span>
    </span>
  );
}

export function AgoCell({ at }: { at: Date | string | null }) {
  const { workspace } = useApp();
  if (!at) return <span className="text-faint">—</span>;
  return (
    <time className="text-[12.5px] whitespace-nowrap text-muted" title={formatFull(at, workspace.timezone)} suppressHydrationWarning>
      {formatAgo(at, workspace.timezone)}
    </time>
  );
}
