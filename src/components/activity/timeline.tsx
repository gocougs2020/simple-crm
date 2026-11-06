"use client";

import clsx from "clsx";
import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  ArrowsRightLeftIcon,
  ArrowDownTrayIcon,
  ArrowUpTrayIcon,
  BriefcaseIcon,
  ChevronRightIcon,
  CheckIcon,
  CreditCardIcon,
  EnvelopeOpenIcon,
  EllipsisHorizontalIcon,
  PaperClipIcon,
  PencilSquareIcon,
  SparklesIcon,
  TrashIcon,
  TrophyIcon,
  XCircleIcon,
} from "@heroicons/react/20/solid";

/** The record being viewed. For clients, the category decides whether a missing next step is worth flagging. */
type Context = { type: EntityType; id: string; category?: ClientCategory };
import { MapPinIcon } from "@heroicons/react/24/outline";
import { deleteActivity, setCompleted, setPinned, updateActivity } from "@/actions/activities";
import { deleteFile } from "@/actions/files";
import { useApp } from "@/components/app-context";
import { OwnerSelect } from "@/components/records/owner-select";
import { Avatar } from "@/components/ui/avatar";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input } from "@/components/ui/field";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Tooltip } from "@/components/ui/menu";
import { useUploader } from "@/components/files/files-panel";
import type { FileLinks } from "@/components/files/upload";
import { RichText } from "@/components/ui/rich-text";
import { toast } from "@/components/ui/toast";
import type { ActivityRow, RecordFile, TimelineItem } from "@/lib/crm/activities";
import { activityLabels, clientCategoryLabels, clientHealthLabels, interactionTypes, type ActivityType, type ClientCategory, type ClientHealth, type EntityType } from "@/lib/constants";
import { dayKey, dueTone, formatBytes, formatDateTime, formatDay, formatFull, formatTime, senderName, timeKey, zonedTime } from "@/lib/format";
import { activityIcons } from "./composer";
import { askNextStep } from "./next-step-dialog";

type Filter = "all" | "conversations" | "tasks";

const filters: { value: Filter; label: string }[] = [
  { value: "all", label: "Everything" },
  { value: "conversations", label: "Conversations" },
  { value: "tasks", label: "Tasks" },
];

/** Calls, emails, texts, meetings and notes: what was said, as opposed to what changed. */
const conversationTypes: ActivityType[] = [...interactionTypes, "note"];

function matches(item: TimelineItem, f: Filter) {
  if (f === "all") return true;
  if (item.kind !== "activity") return false;
  if (f === "tasks") return item.row.activity.type === "task";
  return conversationTypes.includes(item.row.activity.type);
}

/** Changes that tell the record's story (signed, left, moved stage) stay on their own line; the rest fold together. */
const milestones = new Set(["created", "category_changed", "stage_changed", "won", "lost", "reopened"]);
type EventEntry = Extract<TimelineItem, { kind: "event" }>;
const isRoutine = (i: EventEntry) => !milestones.has(i.event.action);

/** Runs of two or more routine changes in a row become one group, so field edits don't bury the conversation. */
function groupRoutine(items: TimelineItem[]) {
  const out: (TimelineItem | { kind: "group"; events: EventEntry[] })[] = [];
  for (const i of items) {
    const last = out.at(-1);
    if (i.kind === "event" && isRoutine(i) && last?.kind === "group") last.events.push(i);
    else if (i.kind === "event" && isRoutine(i) && last?.kind === "event" && isRoutine(last)) out[out.length - 1] = { kind: "group", events: [last, i] };
    else out.push(i);
  }
  return out;
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
  fileLinks,
  files,
}: {
  planned: ActivityRow[];
  pinned: TimelineItem[];
  past: TimelineItem[];
  context: Context;
  emptyHint: string;
  /** What an uploaded file is attached to. */
  fileLinks: FileLinks;
  /** The record's files; the ones attached to an activity show on it. */
  files: RecordFile[];
}) {
  const byActivity = new Map<string, RecordFile[]>();
  for (const f of files) if (f.activityId) byActivity.set(f.activityId, [...(byActivity.get(f.activityId) ?? []), f]);
  const [filter, setFilter] = useState<Filter>("all");
  const shown = groupRoutine(past.filter((i) => matches(i, filter)));
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const { uploads, run } = useUploader(fileLinks);
  const counts = Object.fromEntries(filters.map((f) => [f.value, [...pinned, ...past].filter((i) => matches(i, f.value)).length]));

  return (
    <div className="flex flex-col gap-6">
      {planned.length ? (
        <section aria-labelledby="planned-heading">
          <h2 id="planned-heading" className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-primary">
            Planned
            <span className="font-medium text-muted tabular-nums">{planned.length}</span>
          </h2>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {planned.map((row) => (
              <PlannedItem key={row.activity.id} row={row} context={context} attachments={byActivity.get(row.activity.id)} />
            ))}
          </ul>
        </section>
      ) : null}

      {pinned.length ? (
        <section aria-label="Pinned">
          <h2 className="mb-2 text-[13px] font-semibold text-primary">Pinned</h2>
          <ol className="flex flex-col gap-2">
            {pinned.map((i) => (i.kind === "activity" ? <ActivityItem key={i.row.activity.id} row={i.row} context={context} attachments={byActivity.get(i.row.activity.id)} /> : null))}
          </ol>
        </section>
      ) : null}

      <section
        aria-labelledby="history-heading"
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(false)}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setOver(false);
          run(e.dataTransfer.files);
        }}
        className={clsx("-m-2 rounded-xl p-2 transition-colors", over && "bg-accent-soft ring-2 ring-accent ring-dashed")}
      >
        <input ref={input} type="file" multiple hidden onChange={(e) => e.target.files && run(e.target.files).then(() => (e.target.value = ""))} />
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
          <Button size="sm" variant="ghost" className="ml-auto h-7" onClick={() => input.current?.click()}>
            <ArrowUpTrayIcon />
            Attach file
          </Button>
        </div>
        {uploads.map((u) => (
          <div key={u.name} className="mb-2 flex items-center gap-2 pl-[9px] text-[12.5px]">
            <PaperClipIcon className="size-3.5 text-faint" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-secondary">{u.name}</span>
            <span className="w-24 overflow-hidden rounded-full bg-sunken">
              <span className="block h-1.5 rounded-full bg-accent transition-[width]" style={{ width: `${Math.max(u.pct, 4)}%` }} />
            </span>
          </div>
        ))}
        {shown.length ? (
          <ol className="relative flex flex-col gap-2 before:absolute before:top-2 before:bottom-2 before:left-[15px] before:w-px before:bg-line">
            {shown.map((i) =>
              i.kind === "activity" ? (
                <ActivityItem key={i.row.activity.id} row={i.row} context={context} attachments={byActivity.get(i.row.activity.id)} />
              ) : i.kind === "event" ? (
                <EventItem key={i.event.id} event={i.event} />
              ) : i.kind === "group" ? (
                <ChangeGroup key={i.events[0].event.id} events={i.events} />
              ) : (
                <FileItem key={i.file.id} file={i.file} />
              ),
            )}
          </ol>
        ) : (
          <EmptyState variant="subtle" title={filter === "all" ? "No history yet" : `No ${filters.find((f) => f.value === filter)?.label.toLowerCase()} yet`} description={filter === "all" ? `${emptyHint} Drop a file here to attach it.` : undefined} />
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

/** Links to the other records an activity belongs to (on an organization page: which client, which person). */
function LinkedTo({ row, context }: { row: ActivityRow; context: Context }) {
  const a = row.activity;
  const parts: { href: string; label: string }[] = [];
  if (a.clientId && row.clientName && !(context.type === "client" && context.id === a.clientId)) parts.push({ href: `/clients/${a.clientId}`, label: row.clientName });
  if (a.personId && row.personName && !(context.type === "person" && context.id === a.personId)) parts.push({ href: `/people/${a.personId}`, label: row.personName });
  if (a.organizationId && row.organizationName && context.type === "client" && !a.personId) parts.push({ href: `/organizations/${a.organizationId}`, label: row.organizationName });
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

export function PlannedItem({ row, context, attachments }: { row: ActivityRow; context: Context; attachments?: RecordFile[] }) {
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
      if (r.data.clientWithoutNext) askNextStep({ clientId: r.data.clientWithoutNext, title: row.clientName ?? "This client" });
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
        <Attachments files={attachments} />
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

export function ActivityItem({ row, context, attachments }: { row: ActivityRow; context: Context; attachments?: RecordFile[] }) {
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
          ? a.inboxThreadId && !a.userId
            ? a.direction === "inbound"
              ? "emailed"
              : `sent from ${row.inboxAddress ?? "an inbox"}`
            : a.emailId || a.inboxThreadId
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
      <span className={clsx("relative z-10 mt-2.5 flex size-8 shrink-0 items-center justify-center rounded-full border", a.type === "note" ? "border-note-border bg-note-surface" : "border-line bg-surface")}>
        <Icon className="size-4 text-secondary" aria-hidden />
      </span>
      <article className={clsx("group min-w-0 flex-1 rounded-xl border bg-surface px-3.5 py-3", a.pinned ? "border-line-strong shadow-sm" : "border-line")}>
        <header className="flex items-start gap-2">
          <div className="min-w-0 flex-1 text-[13px] text-muted">
            {a.inboxThreadId && !a.userId && a.direction === "inbound" && row.inboxFrom ? <span className="font-medium text-primary">{senderName(row.inboxFrom)}</span> : a.inboxThreadId && !a.userId ? <span className="font-medium text-primary">Email</span> : <Who id={a.userId} />}{" "}
            {verb}
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
        ) : a.type === "email" && a.inboxThreadId && row.inboxTo?.length ? (
          <p className="mt-1 truncate text-[12px] text-muted">
            {a.direction === "inbound" && row.inboxFrom ? `From ${row.inboxFrom} · ` : ""}To {row.inboxTo.join(", ")}
          </p>
        ) : null}
        {a.subject ? <h3 className="mt-1 text-[14px] font-medium">{a.subject}</h3> : null}
        {a.body ? <CollapsibleBody html={a.body} /> : null}
        <Attachments files={attachments} />
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] empty:hidden">
          {a.inboxThreadId ? (
            <Link href={`/email?t=${a.inboxThreadId}`} className="inline-flex items-center gap-1 font-medium text-secondary hover:text-primary">
              <EnvelopeOpenIcon className="size-3.5" aria-hidden />
              Open conversation
            </Link>
          ) : null}
          <LinkedTo row={row} context={context} />
        </div>
      </article>
      {editing ? <EditActivity row={row} onClose={() => setEditing(false)} /> : null}
    </li>
  );
}

/** Files attached to an activity, as chips that open them. */
function Attachments({ files }: { files?: RecordFile[] }) {
  if (!files?.length) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Attachments">
      {files.map((f) => (
        <li key={f.id}>
          <a href={`/api/files/${f.id}`} target="_blank" rel="noopener" className="inline-flex h-7 max-w-64 items-center gap-1.5 rounded-full border border-line bg-sunken px-2.5 text-[12px] text-secondary hover:border-line-strong hover:text-primary">
            <PaperClipIcon className="size-3.5 shrink-0 text-faint" aria-hidden />
            <span className="truncate">{f.name}</span>
            <span className="shrink-0 text-faint tabular-nums">{formatBytes(f.size)}</span>
          </a>
        </li>
      ))}
    </ul>
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
  const canDelete = (a.userId === viewer.id || isAdmin) && !a.emailId && !a.inboxThreadId;
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="-mt-0.5 -mr-1 rounded-md p-1 text-faint opacity-60 transition-opacity group-hover:opacity-100 hover:bg-sunken hover:text-primary focus:opacity-100" aria-label="More actions">
          <EllipsisHorizontalIcon className="size-4" />
        </button>
      </MenuTrigger>
      <MenuContent className="w-44">
        {canEdit && !a.emailId && !a.inboxThreadId ? (
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
        {a.type !== "note" ? (
          <div className="flex flex-wrap gap-3">
            <Field label={open ? "Due" : "When"}>{(p) => <Input {...p} type="date" value={day} onChange={(e) => setDay(e.target.value)} className="w-40" />}</Field>
            <Field label="Time" optional={open}>
              {(p) => <Input {...p} type="time" value={time} onChange={(e) => setTime(e.target.value)} className="w-32" step={900} />}
            </Field>
            {open ? <Field label="Assigned to">{(p) => <OwnerSelect id={p.id} value={assigneeId} onChange={setAssigneeId} allowNone={false} />}</Field> : null}
          </div>
        ) : null}
        <RichText value={body} onChange={setBody} onSubmit={save} minHeight={120} autoFocus={a.type === "note"} />
      </div>
    </Dialog>
  );
}

const fieldText = (v: unknown, label: string | null | undefined, member: (id: string) => { name: string } | undefined, field: string, money: (c: number) => string) => {
  if (label) return label;
  if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return "empty";
  if (field === "ownerId") return member(String(v))?.name ?? "a former teammate";
  if (field === "value" || field === "price") return money(Number(v));
  if (field === "marketingOptIn" || field === "openToReturn") return v ? "Yes" : "No";
  if (field === "health") return clientHealthLabels[v as ClientHealth] ?? String(v);
  if (field === "interval") return String(v) === "once" ? "one time" : `${v}ly`;
  if (Array.isArray(v)) return v.join(", ");
  if (field === "organizationId" || field === "personId") return "a deleted record";
  return String(v);
};

/** One line of history: who changed what, from what, to what. */
function EventItem({ event }: { event: { id: string; action: string; data: Record<string, unknown>; userId: string | null; createdAt: Date } }) {
  const { workspace, member, money } = useApp();
  const tz = workspace.timezone;
  const d = event.data as {
    from?: string;
    to?: string;
    on?: string;
    reason?: string;
    stage?: string;
    category?: ClientCategory;
    changes?: { field: string; label: string; from: unknown; to: unknown; fromLabel?: string; toLabel?: string }[];
    subject?: string;
    type?: string;
    name?: string;
    source?: string;
  };
  const cat = (c?: string) => (c && c in clientCategoryLabels ? clientCategoryLabels[c as ClientCategory].one.toLowerCase() : c);
  let text: React.ReactNode;
  let icon = <PencilSquareIcon className="size-3.5" />;
  switch (event.action) {
    case "created":
      text = d.category ? <>added this as a {cat(d.category)} client{d.stage ? <> in {d.stage}</> : null}</> : <>created this</>;
      if (d.source === "pipedrive") text = <>{text} from Pipedrive</>;
      icon = <SparklesIcon className="size-3.5" />;
      break;
    case "category_changed":
      text =
        d.to === "current" ? (
          <>{d.from === "past" ? "won this client back" : "marked this client as signed"}{d.stage ? <> · {d.stage}</> : null}</>
        ) : d.to === "past" ? (
          <>marked this client as left{d.reason ? <>: “{d.reason}”</> : null}</>
        ) : (
          <>moved this from {cat(d.from)} to {cat(d.to)} clients</>
        );
      icon = d.to === "current" ? <TrophyIcon className="size-3.5 text-success" /> : d.to === "past" ? <XCircleIcon className="size-3.5 text-error" /> : <BriefcaseIcon className="size-3.5" />;
      break;
    case "service_added":
      text = <>added the service <strong className="font-medium text-secondary">{d.name}</strong></>;
      icon = <BriefcaseIcon className="size-3.5" />;
      break;
    case "service_ended":
      text = <>ended the service <strong className="font-medium text-secondary">{d.name}</strong></>;
      icon = <BriefcaseIcon className="size-3.5" />;
      break;
    case "service_removed":
      text = <>removed the service <strong className="font-medium text-secondary">{d.name}</strong></>;
      icon = <TrashIcon className="size-3.5" />;
      break;
    case "stripe_linked":
      text = <>linked the Stripe customer {d.name ?? ""}</>;
      icon = <CreditCardIcon className="size-3.5" />;
      break;
    case "stripe_unlinked":
      text = <>unlinked the Stripe customer</>;
      icon = <CreditCardIcon className="size-3.5" />;
      break;
    case "email_linked":
      text = <>linked the conversation{d.subject ? <> “{d.subject}”</> : null}</>;
      icon = <EnvelopeOpenIcon className="size-3.5" />;
      break;
    case "stage_changed":
      text = (
        <>
          moved this from <strong className="font-medium text-secondary">{d.from}</strong> to <strong className="font-medium text-secondary">{d.to}</strong>
        </>
      );
      icon = <ArrowsRightLeftIcon className="size-3.5" />;
      break;
    // From before deals became clients.
    case "won":
      text = <>marked this won</>;
      icon = <TrophyIcon className="size-3.5 text-success" />;
      break;
    case "lost":
      text = <>marked this lost{d.reason ? <>: “{d.reason}”</> : null}</>;
      icon = <XCircleIcon className="size-3.5 text-error" />;
      break;
    case "reopened":
      text = <>reopened this</>;
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

/** Several routine changes in a row, folded into one line that opens to show each. */
function ChangeGroup({ events }: { events: EventEntry[] }) {
  const { workspace, member, viewer } = useApp();
  const [open, setOpen] = useState(false);
  const people = [...new Set(events.map((e) => e.event.userId))].map((id) => (id === viewer.id ? "You" : (member(id)?.name ?? "Someone")));
  const newest = events[0].event.createdAt;
  return (
    <>
      <li className="relative flex items-start gap-3 py-0.5 pl-[9px]">
        <span className="relative z-10 mt-0.5 flex size-[14px] items-center justify-center rounded-full bg-background text-faint ring-4 ring-background">
          <PencilSquareIcon className="size-3.5" />
        </span>
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-w-0 flex-1 items-start gap-1 text-left text-[12.5px] leading-5 text-muted hover:text-secondary">
          <span>
            <span className="font-medium text-primary">{people.length > 2 ? `${people.slice(0, 2).join(", ")} and others` : people.join(" and ")}</span> made {events.length} changes
            <time className="ml-1.5 whitespace-nowrap text-faint" suppressHydrationWarning>
              · {formatDateTime(newest, workspace.timezone)}
            </time>
          </span>
          <ChevronRightIcon className={clsx("mt-0.5 size-4 shrink-0 transition-transform", open && "rotate-90")} aria-hidden />
        </button>
      </li>
      {open ? events.map((e) => <EventItem key={e.event.id} event={e.event} />) : null}
    </>
  );
}

function FileItem({ file }: { file: { id: string; name: string; size: number; uploadedBy: string; createdAt: Date } }) {
  const { workspace, viewer, isAdmin } = useApp();
  return (
    <li className="group relative flex items-start gap-3 py-0.5 pl-[9px]">
      <span className="relative z-10 mt-0.5 flex size-[14px] items-center justify-center rounded-full bg-background text-faint ring-4 ring-background">
        <PaperClipIcon className="size-3.5" />
      </span>
      <p className="min-w-0 flex-1 text-[12.5px] leading-5 text-muted">
        <Who id={file.uploadedBy} /> added{" "}
        <a href={`/api/files/${file.id}`} target="_blank" rel="noopener" className="font-medium text-secondary underline-offset-2 hover:text-primary hover:underline">
          {file.name}
        </a>{" "}
        <span className="tabular-nums">({formatBytes(file.size)})</span>
        <time className="ml-1.5 whitespace-nowrap text-faint" suppressHydrationWarning>
          · {formatDateTime(file.createdAt, workspace.timezone)}
        </time>
      </p>
      <a href={`/api/files/${file.id}?download`} className="rounded p-0.5 text-faint opacity-0 group-hover:opacity-100 hover:text-primary focus:opacity-100" aria-label={`Download ${file.name}`}>
        <ArrowDownTrayIcon className="size-3.5" />
      </a>
      {file.uploadedBy === viewer.id || isAdmin ? (
        <button
          type="button"
          onClick={async () => {
            if (!confirm(`Remove ${file.name}?`)) return;
            const r = await deleteFile(file.id);
            if (!r.ok) toast.error(r.error);
          }}
          className="rounded p-0.5 text-faint opacity-0 group-hover:opacity-100 hover:text-error focus:opacity-100"
          aria-label={`Remove ${file.name}`}
        >
          <TrashIcon className="size-3.5" />
        </button>
      ) : null}
    </li>
  );
}
