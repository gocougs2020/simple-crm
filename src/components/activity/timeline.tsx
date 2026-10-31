"use client";

import clsx from "clsx";
import Link from "next/link";
import { useState, useTransition } from "react";
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  ArrowsRightLeftIcon,
  CheckIcon,
  EllipsisHorizontalIcon,
  PaperClipIcon,
  PencilSquareIcon,
  SparklesIcon,
  TrashIcon,
  TrophyIcon,
  XCircleIcon,
} from "@heroicons/react/20/solid";
import { MapPinIcon } from "@heroicons/react/24/outline";
import { deleteActivity, setCompleted, setPinned, updateActivity } from "@/actions/activities";
import { useApp } from "@/components/app-context";
import { OwnerSelect } from "@/components/records/owner-select";
import { Avatar } from "@/components/ui/avatar";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input } from "@/components/ui/field";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Tooltip } from "@/components/ui/menu";
import { RichText } from "@/components/ui/rich-text";
import { toast } from "@/components/ui/toast";
import type { ActivityRow, TimelineItem } from "@/lib/crm/activities";
import type { EntityType } from "@/lib/constants";
import { activityLabels, interactionTypes, type ActivityType } from "@/lib/constants";
import { dayKey, dueTone, formatBytes, formatDateTime, formatDay, formatFull, formatTime, timeKey, zonedTime } from "@/lib/format";
import { activityIcons } from "./composer";
import { askNextStep } from "./next-step-dialog";
import { ScheduleNext } from "./schedule-next";

type Filter = "all" | "interactions" | ActivityType | "changes" | "files";

const filters: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "interactions", label: "Interactions" },
  { value: "note", label: "Notes" },
  { value: "call", label: "Calls" },
  { value: "email", label: "Emails" },
  { value: "text", label: "Texts" },
  { value: "meeting", label: "Meetings" },
  { value: "task", label: "Tasks" },
  { value: "changes", label: "Changes" },
  { value: "files", label: "Files" },
];

function matches(item: TimelineItem, f: Filter) {
  if (f === "all") return true;
  if (f === "changes") return item.kind === "event";
  if (f === "files") return item.kind === "file";
  if (item.kind !== "activity") return false;
  if (f === "interactions") return interactionTypes.includes(item.row.activity.type);
  return item.row.activity.type === f;
}

/**
 * A record's story. "Planned" (open tasks and scheduled calls and meetings,
 * soonest first) sits above the history, so the next step is always the first
 * thing you see. `context` is the record being viewed, so linked names to it
 * aren't repeated on every entry.
 */
export function Timeline({
  planned,
  pinned,
  past,
  context,
  emptyHint,
}: {
  planned: ActivityRow[];
  pinned: TimelineItem[];
  past: TimelineItem[];
  context: { type: EntityType; id: string };
  emptyHint: string;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const shown = past.filter((i) => matches(i, filter));
  const counts = Object.fromEntries(filters.map((f) => [f.value, [...pinned, ...past].filter((i) => matches(i, f.value)).length]));

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="planned-heading">
        <h2 id="planned-heading" className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-primary">
          Planned
          <span className="font-medium text-muted tabular-nums">{planned.length}</span>
        </h2>
        {planned.length ? (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {planned.map((row) => (
              <PlannedItem key={row.activity.id} row={row} context={context} />
            ))}
          </ul>
        ) : context.type === "deal" ? (
          <ScheduleNext dealId={context.id} />
        ) : (
          <p className="rounded-xl border border-dashed border-line px-4 py-3 text-[13px] text-muted">Nothing planned. Add a task or schedule a call above.</p>
        )}
      </section>

      {pinned.length ? (
        <section aria-label="Pinned">
          <h2 className="mb-2 text-[13px] font-semibold text-primary">Pinned</h2>
          <ol className="flex flex-col gap-2">
            {pinned.map((i) => (i.kind === "activity" ? <ActivityItem key={i.row.activity.id} row={i.row} context={context} /> : null))}
          </ol>
        </section>
      ) : null}

      <section aria-labelledby="history-heading">
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 id="history-heading" className="text-[13px] font-semibold text-primary">
            History
          </h2>
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Filter history">
            {filters
              .filter((f) => f.value === "all" || counts[f.value] > 0)
              .map((f) => (
                <button
                  key={f.value}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.value}
                  onClick={() => setFilter(f.value)}
                  className={clsx(
                    "h-6 rounded-full px-2.5 text-[12px] font-medium transition-colors",
                    filter === f.value ? "bg-accent text-accent-foreground" : "bg-sunken text-secondary hover:text-primary",
                  )}
                >
                  {f.label}
                  {f.value !== "all" ? <span className="ml-1 opacity-60 tabular-nums">{counts[f.value]}</span> : null}
                </button>
              ))}
          </div>
        </div>
        {shown.length ? (
          <ol className="relative flex flex-col gap-2 before:absolute before:top-2 before:bottom-2 before:left-[15px] before:w-px before:bg-line">
            {shown.map((i) =>
              i.kind === "activity" ? (
                <ActivityItem key={i.row.activity.id} row={i.row} context={context} />
              ) : i.kind === "event" ? (
                <EventItem key={i.event.id} event={i.event} />
              ) : (
                <FileItem key={i.file.id} file={i.file} />
              ),
            )}
          </ol>
        ) : (
          <EmptyState variant="subtle" title={filter === "all" ? "No history yet" : `No ${filters.find((f) => f.value === filter)?.label.toLowerCase()} yet`} description={filter === "all" ? emptyHint : undefined} />
        )}
      </section>
    </div>
  );
}

function Who({ id }: { id: string | null }) {
  const { member, viewer } = useApp();
  const m = member(id);
  return <span className="font-medium text-primary">{m ? (m.id === viewer.id ? "You" : m.name) : "Someone"}</span>;
}

/** Links to the other records an activity belongs to (on an organization page: which deal, which person). */
function LinkedTo({ row, context }: { row: ActivityRow; context: { type: EntityType; id: string } }) {
  const a = row.activity;
  const parts: { href: string; label: string }[] = [];
  if (a.dealId && row.dealTitle && !(context.type === "deal" && context.id === a.dealId)) parts.push({ href: `/deals/${a.dealId}`, label: row.dealTitle });
  if (a.personId && row.personName && !(context.type === "person" && context.id === a.personId)) parts.push({ href: `/people/${a.personId}`, label: row.personName });
  if (a.organizationId && row.organizationName && context.type === "deal" && !a.personId) parts.push({ href: `/organizations/${a.organizationId}`, label: row.organizationName });
  if (!parts.length) return null;
  return (
    <span className="flex min-w-0 items-center gap-1 text-muted">
      <MapPinIcon className="size-3 shrink-0" aria-hidden />
      {parts.map((p, i) => (
        <span key={p.href} className="truncate">
          {i > 0 ? " · " : ""}
          <Link href={p.href} className="hover:text-primary hover:underline">
            {p.label}
          </Link>
        </span>
      ))}
    </span>
  );
}

export function PlannedItem({ row, context }: { row: ActivityRow; context: { type: EntityType; id: string } }) {
  const { workspace, member } = useApp();
  const a = row.activity;
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const Icon = activityIcons[a.type];
  const tz = workspace.timezone;
  const assignee = member(a.assigneeId);
  const tone = dueTone(a.dueAt!, tz);

  const complete = () =>
    start(async () => {
      const r = await setCompleted(a.id, true);
      if (!r.ok) return void toast.error(r.error);
      toast.success(`${activityLabels[a.type]} done`, { label: "Undo", onClick: () => setCompleted(a.id, false) });
      if (r.data.dealWithoutNext) askNextStep({ dealId: r.data.dealWithoutNext, title: row.dealTitle ?? "This deal" });
    });

  return (
    <li className="group flex items-start gap-3 px-3.5 py-2.5">
      <button
        type="button"
        onClick={complete}
        disabled={pending}
        className="mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-line-strong text-transparent transition-colors hover:border-success hover:bg-success-surface hover:text-success disabled:opacity-50"
        aria-label={`Mark “${a.subject ?? activityLabels[a.type]}” done`}
      >
        <CheckIcon className="size-3" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Icon className="size-4 text-muted" aria-label={activityLabels[a.type]} />
          <span className="text-[14px] font-medium text-primary">{a.subject || activityLabels[a.type]}</span>
          <Tooltip content={formatFull(a.dueAt!, tz)}>
            <span>
              <StatusBadge tone={tone}>
                {tone === "error" ? "Overdue · " : ""}
                {formatDay(a.dueAt!, tz)}
                {a.dueHasTime ? ` ${formatTime(a.dueAt!, tz)}` : ""}
              </StatusBadge>
            </span>
          </Tooltip>
        </div>
        {a.body ? <div className="prose-crm mt-1 line-clamp-3 text-[13px]" dangerouslySetInnerHTML={{ __html: a.body }} /> : null}
        <div className="mt-1 flex min-w-0 items-center gap-2 text-[12px]">
          {assignee ? (
            <span className="flex items-center gap-1.5 text-muted">
              <Avatar name={assignee.name} size="xs" />
              {assignee.name}
            </span>
          ) : null}
          <LinkedTo row={row} context={context} />
        </div>
      </div>
      <ItemMenu row={row} onEdit={() => setEditing(true)} />
      {editing ? <EditActivity row={row} onClose={() => setEditing(false)} /> : null}
    </li>
  );
}

export function ActivityItem({ row, context }: { row: ActivityRow; context: { type: EntityType; id: string } }) {
  const { workspace } = useApp();
  const a = row.activity;
  const tz = workspace.timezone;
  const [editing, setEditing] = useState(false);
  const Icon = activityIcons[a.type];
  const at = a.occurredAt ?? a.completedAt ?? a.createdAt;
  const verb =
    a.type === "note"
      ? "added a note"
      : a.type === "task"
        ? "completed a task"
        : a.type === "email"
          ? a.emailId
            ? "sent an email"
            : a.direction === "inbound"
              ? "logged an email received"
              : "logged an email sent"
          : a.type === "call"
            ? a.direction === "inbound"
              ? "logged an incoming call"
              : "logged a call"
            : a.type === "text"
              ? a.direction === "inbound"
                ? "logged a text received"
                : "logged a text sent"
              : "logged a meeting";

  return (
    <li className="relative flex gap-3">
      <span className={clsx("relative z-10 mt-2.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-line bg-surface", a.type === "note" && "bg-[#fefce8] border-[#fde68a]")}>
        <Icon className="size-4 text-secondary" aria-hidden />
      </span>
      <article className={clsx("group min-w-0 flex-1 rounded-xl border bg-surface px-3.5 py-3", a.pinned ? "border-line-strong shadow-sm" : "border-line")}>
        <header className="flex items-start gap-2">
          <div className="min-w-0 flex-1 text-[13px] text-muted">
            <Who id={a.userId} /> {verb}
            {a.direction && a.type !== "note" ? (
              a.direction === "inbound" ? (
                <ArrowDownLeftIcon className="ml-1 inline size-3.5 align-[-2px]" aria-label="Inbound" />
              ) : (
                <ArrowUpRightIcon className="ml-1 inline size-3.5 align-[-2px]" aria-label="Outbound" />
              )
            ) : null}
            {a.outcome ? <span className="ml-1.5 rounded-sm bg-sunken px-1.5 py-0.5 text-[11.5px] font-medium text-secondary">{a.outcome}</span> : null}
            {a.durationMinutes ? <span className="ml-1.5 text-[12px] tabular-nums">{a.durationMinutes} min</span> : null}
            <Tooltip content={formatFull(at, tz)}>
              <time dateTime={new Date(at).toISOString()} className="ml-1.5 text-[12px] whitespace-nowrap text-faint" suppressHydrationWarning>
                · {formatDateTime(at, tz)}
              </time>
            </Tooltip>
            {a.pinned ? <span className="ml-1.5 text-[11.5px] font-medium text-secondary">· Pinned</span> : null}
          </div>
          <ItemMenu row={row} onEdit={() => setEditing(true)} />
        </header>
        {a.type === "email" && row.emailTo ? (
          <p className="mt-1 text-[12px] text-muted">
            To {row.emailTo}
            {row.emailCc ? ` · Cc ${row.emailCc}` : ""}
          </p>
        ) : null}
        {a.subject ? <h3 className="mt-1 text-[14px] font-medium">{a.subject}</h3> : null}
        {a.body ? <CollapsibleBody html={a.body} /> : null}
        <div className="mt-1.5 text-[12px] empty:hidden">
          <LinkedTo row={row} context={context} />
        </div>
      </article>
      {editing ? <EditActivity row={row} onClose={() => setEditing(false)} /> : null}
    </li>
  );
}

/** Long notes and emails start folded so one big email doesn't push everything else off screen. */
function CollapsibleBody({ html }: { html: string }) {
  const long = html.length > 900;
  const [open, setOpen] = useState(!long);
  return (
    <div className="mt-1">
      <div className={clsx("prose-crm", !open && "line-clamp-6")} dangerouslySetInnerHTML={{ __html: html }} />
      {long ? (
        <button type="button" onClick={() => setOpen(!open)} className="mt-1 text-[12.5px] font-medium text-secondary hover:text-primary">
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

function ItemMenu({ row, onEdit }: { row: ActivityRow; onEdit: () => void }) {
  const { viewer, isAdmin } = useApp();
  const a = row.activity;
  const canEdit = a.userId === viewer.id || isAdmin || a.type === "task" || !a.completedAt;
  const canDelete = (a.userId === viewer.id || isAdmin) && !a.emailId;
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="-mt-0.5 -mr-1 rounded-md p-1 text-faint opacity-60 transition-opacity group-hover:opacity-100 hover:bg-sunken hover:text-primary focus:opacity-100" aria-label="More actions">
          <EllipsisHorizontalIcon className="size-4" />
        </button>
      </MenuTrigger>
      <MenuContent className="w-44">
        {canEdit && !a.emailId ? (
          <MenuItem icon={<PencilSquareIcon />} onSelect={onEdit}>
            Edit
          </MenuItem>
        ) : null}
        {a.completedAt || !a.dueAt ? (
          <MenuItem icon={<SparklesIcon />} onSelect={async () => void (await setPinned(a.id, !a.pinned))}>
            {a.pinned ? "Unpin" : "Pin to top"}
          </MenuItem>
        ) : null}
        {a.completedAt && a.dueAt ? (
          <MenuItem icon={<ArrowsRightLeftIcon />} onSelect={async () => void (await setCompleted(a.id, false))}>
            Mark not done
          </MenuItem>
        ) : null}
        {canDelete ? (
          <>
            <MenuSeparator />
            <MenuItem
              destructive
              icon={<TrashIcon />}
              onSelect={async () => {
                if (!confirm(`Delete this ${activityLabels[a.type].toLowerCase()}? This can't be undone.`)) return;
                const r = await deleteActivity(a.id);
                if (!r.ok) toast.error(r.error);
                else toast.success(`${activityLabels[a.type]} deleted`);
              }}
            >
              Delete
            </MenuItem>
          </>
        ) : null}
      </MenuContent>
    </Menu>
  );
}

function EditActivity({ row, onClose }: { row: ActivityRow; onClose: () => void }) {
  const { workspace } = useApp();
  const tz = workspace.timezone;
  const a = row.activity;
  const open = !a.completedAt && !!a.dueAt;
  const when = open ? a.dueAt! : (a.occurredAt ?? a.createdAt);
  const [subject, setSubject] = useState(a.subject ?? "");
  const [body, setBody] = useState(a.body ?? "");
  const [day, setDay] = useState(dayKey(when, tz));
  const [time, setTime] = useState(open && !a.dueHasTime ? "" : timeKey(when, tz));
  const [assigneeId, setAssigneeId] = useState(a.assigneeId);
  const [pending, start] = useTransition();
  const save = () =>
    start(async () => {
      const at = zonedTime(day, time || "00:00", tz).toISOString();
      const r = await updateActivity(a.id, {
        subject: subject || null,
        body,
        ...(open ? { dueAt: at, dueHasTime: !!time, assigneeId } : a.type !== "note" ? { occurredAt: at } : {}),
      });
      if (!r.ok) return void toast.error(r.error);
      toast.success("Saved");
      onClose();
    });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Edit ${activityLabels[a.type].toLowerCase()}`}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {a.type !== "note" ? <Field label={a.type === "task" ? "Task" : "Subject"}>{(p) => <Input {...p} value={subject} onChange={(e) => setSubject(e.target.value)} />}</Field> : null}
        <RichText value={body} onChange={setBody} onSubmit={save} minHeight={120} autoFocus={a.type === "note"} />
        {a.type !== "note" ? (
          <div className="flex flex-wrap gap-3">
            <Field label={open ? "Due" : "When"}>{(p) => <Input {...p} type="date" value={day} onChange={(e) => setDay(e.target.value)} className="w-40" />}</Field>
            <Field label="Time" optional={open}>
              {(p) => <Input {...p} type="time" value={time} onChange={(e) => setTime(e.target.value)} className="w-32" step={900} />}
            </Field>
            {open ? <Field label="Assigned to">{(p) => <OwnerSelect id={p.id} value={assigneeId} onChange={setAssigneeId} allowNone={false} />}</Field> : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

const fieldText = (v: unknown, label: string | null | undefined, member: (id: string) => { name: string } | undefined, field: string, money: (c: number) => string) => {
  if (label) return label;
  if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return "empty";
  if (field === "ownerId") return member(String(v))?.name ?? "a former teammate";
  if (field === "value") return money(Number(v));
  if (field === "marketingOptIn") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.join(", ");
  if (field === "organizationId" || field === "personId") return "a deleted record";
  return String(v);
};

/** One line of history: who changed what, from what, to what. */
function EventItem({ event }: { event: { id: string; action: string; data: Record<string, unknown>; userId: string | null; createdAt: Date } }) {
  const { workspace, member, money } = useApp();
  const tz = workspace.timezone;
  const d = event.data as { from?: string; to?: string; reason?: string; changes?: { field: string; label: string; from: unknown; to: unknown; fromLabel?: string; toLabel?: string }[]; subject?: string; type?: string; name?: string };
  let text: React.ReactNode;
  let icon = <PencilSquareIcon className="size-3.5" />;
  switch (event.action) {
    case "created":
      text = <>created this{d.from ? "" : ""}</>;
      icon = <SparklesIcon className="size-3.5" />;
      break;
    case "stage_changed":
      text = (
        <>
          moved this from <strong className="font-medium text-secondary">{d.from}</strong> to <strong className="font-medium text-secondary">{d.to}</strong>
        </>
      );
      icon = <ArrowsRightLeftIcon className="size-3.5" />;
      break;
    case "won":
      text = <>marked this deal won</>;
      icon = <TrophyIcon className="size-3.5 text-success" />;
      break;
    case "lost":
      text = <>marked this deal lost{d.reason ? <>: “{d.reason}”</> : null}</>;
      icon = <XCircleIcon className="size-3.5 text-error" />;
      break;
    case "reopened":
      text = <>reopened this deal</>;
      break;
    case "archived":
      text = <>archived this</>;
      break;
    case "restored":
      text = <>restored this from the archive</>;
      break;
    case "activity_deleted":
      text = <>deleted a {d.type ?? "activity"}{d.subject ? <> (“{d.subject}”)</> : null}</>;
      icon = <TrashIcon className="size-3.5" />;
      break;
    case "file_deleted":
      text = <>removed the file {d.name}</>;
      icon = <PaperClipIcon className="size-3.5" />;
      break;
    case "updated":
      text = (
        <>
          {(d.changes ?? []).map((c, i) => (
            <span key={i}>
              {i > 0 ? "; " : ""}changed <strong className="font-medium text-secondary">{c.label}</strong> from {fieldText(c.from, c.fromLabel, member, c.field, money)} to{" "}
              <span className="text-secondary">{fieldText(c.to, c.toLabel, member, c.field, money)}</span>
            </span>
          ))}
        </>
      );
      break;
    default:
      text = <>{event.action.replace(/_/g, " ")}</>;
  }
  return (
    <li className="relative flex items-start gap-3 py-0.5 pl-[9px]">
      <span className="relative z-10 mt-0.5 flex size-[14px] items-center justify-center rounded-full bg-background text-faint ring-4 ring-background">{icon}</span>
      <p className="min-w-0 flex-1 text-[12.5px] leading-5 text-muted">
        <Who id={event.userId} /> {text}
        <time dateTime={new Date(event.createdAt).toISOString()} className="ml-1.5 whitespace-nowrap text-faint" title={formatFull(event.createdAt, tz)} suppressHydrationWarning>
          · {formatDateTime(event.createdAt, tz)}
        </time>
      </p>
    </li>
  );
}

function FileItem({ file }: { file: { id: string; name: string; size: number; uploadedBy: string; createdAt: Date } }) {
  const { workspace } = useApp();
  return (
    <li className="relative flex items-start gap-3 py-0.5 pl-[9px]">
      <span className="relative z-10 mt-0.5 flex size-[14px] items-center justify-center rounded-full bg-background text-faint ring-4 ring-background">
        <PaperClipIcon className="size-3.5" />
      </span>
      <p className="min-w-0 flex-1 text-[12.5px] leading-5 text-muted">
        <Who id={file.uploadedBy} /> added{" "}
        <a href={`/api/files/${file.id}`} className="font-medium text-secondary underline-offset-2 hover:text-primary hover:underline">
          {file.name}
        </a>{" "}
        <span className="tabular-nums">({formatBytes(file.size)})</span>
        <time className="ml-1.5 whitespace-nowrap text-faint" suppressHydrationWarning>
          · {formatDateTime(file.createdAt, workspace.timezone)}
        </time>
      </p>
    </li>
  );
}
