"use client";

import clsx from "clsx";
import Link from "next/link";
import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  ArrowsRightLeftIcon,
  ArrowDownTrayIcon,
  ArrowUpTrayIcon,
  ArrowUturnLeftIcon,
  BriefcaseIcon,
  ChevronRightIcon,
  CheckIcon,
  CreditCardIcon,
  EnvelopeOpenIcon,
  EllipsisHorizontalIcon,
  LinkIcon,
  LockClosedIcon,
  PaperClipIcon,
  PencilSquareIcon,
  SparklesIcon,
  TrashIcon,
  TrophyIcon,
  XCircleIcon,
} from "@heroicons/react/20/solid";

/** The record being viewed. For clients, the category decides whether a missing next step is worth flagging. */
type Context = { type: EntityType; id: string; category?: ClientCategory };
import { MapPinIcon, UserPlusIcon } from "@heroicons/react/24/outline";
import { deleteActivity, deleteReply, loadActivityBody, replyToNote, setCompleted, setPinned, updateActivity } from "@/actions/activities";
import { deletePrivateEmail, setSyncedEmailVisibility } from "@/actions/accounts";
import { deleteFile } from "@/actions/files";
import { useApp } from "@/components/app-context";
import { AGENT_ASSIGNEE, OwnerSelect } from "@/components/records/owner-select";
import { Avatar } from "@/components/ui/avatar";
import { StatusBadge } from "@/components/ui/badge";
import { Button, Spinner } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input } from "@/components/ui/field";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Tooltip } from "@/components/ui/menu";
import { useUploader } from "@/components/files/files-panel";
import type { FileLinks } from "@/components/files/upload";
import { preloadRichText, RichText } from "@/components/ui/rich-text";
import { toast } from "@/components/ui/toast";
import type { ActivityRow, NoteReply, RecordFile, TimelineItem } from "@/lib/crm/activities";
import { useTimelinePages } from "./use-timeline-pages";
import { appConfig } from "@/app.config";
import { deliveryLabels, deliveryTone } from "@/lib/email/delivery-status";
import { activityLabels, agentRunStatusLabels, billingIntervalLabels, clientCategoryLabels, clientHealthLabels, interactionTypes, type ActivityType, type BillingInterval, type ClientCategory, type ClientHealth, type EntityType } from "@/lib/constants";
import { billingStatusLabels, type BillingStatus } from "@/lib/stripe/rules";
import { dayKey, dueTone, formatBytes, formatDateTime, formatDay, formatFull, formatTime, senderName, timeKey, zonedTime } from "@/lib/format";
import { formatPhone } from "@/lib/phone/numbers";
import { formatCallDuration, textStatusLabels } from "@/lib/phone/rules";
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
  if (item.kind === "privateMail") return f !== "tasks";
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
  hasMore,
  counts,
  context,
  emptyHint,
  fileLinks,
  files,
}: {
  planned: ActivityRow[];
  pinned: TimelineItem[];
  /** The first page of the past; the rest loads as it's scrolled (useTimelinePages). */
  past: TimelineItem[];
  hasMore: boolean;
  /** How many conversations and tasks the whole past holds, for the filters. */
  counts: Record<Exclude<Filter, "all">, number>;
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
  const pages = useTimelinePages({ entity: context.type, id: context.id, first: past, hasMore, filter });
  const shown = groupRoutine(pages.items.filter((i) => matches(i, filter)));
  // Older entries load as the end of the list comes near.
  const sentinel = useRef<HTMLDivElement>(null);
  const loadMore = pages.loadMore;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !pages.hasMore) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadMore(), { rootMargin: "800px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [pages.hasMore, loadMore]);
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const { uploads, run } = useUploader(fileLinks);
  // Viewers can't add files.
  const canAttach = useApp().canEdit;

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
          if (!canAttach || !e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(false)}
        onDrop={(e) => {
          if (!canAttach || !e.dataTransfer.files.length) return;
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
          {canAttach ? (
            <Button size="sm" variant="ghost" className="ml-auto h-7" onClick={() => input.current?.click()}>
              <ArrowUpTrayIcon />
              Attach file
            </Button>
          ) : null}
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
          // Entries out of view skip layout and paint until they're scrolled near.
          <ol className="relative flex flex-col gap-2 before:absolute before:top-2 before:bottom-2 before:left-[15px] before:w-px before:bg-line [&>li]:[contain-intrinsic-size:auto_96px] [&>li]:[content-visibility:auto]">
            {shown.map((i) =>
              i.kind === "activity" ? (
                <ActivityItem key={i.row.activity.id} row={i.row} context={context} attachments={byActivity.get(i.row.activity.id)} />
              ) : i.kind === "event" ? (
                <EventItem key={i.event.id} event={i.event} />
              ) : i.kind === "group" ? (
                <ChangeGroup key={i.events[0].event.id} events={i.events} />
              ) : i.kind === "privateMail" ? (
                <PrivateMailItem key={i.mail.id} mail={i.mail} at={i.at} />
              ) : (
                <FileItem key={i.file.id} file={i.file} />
              ),
            )}
          </ol>
        ) : pages.loading ? null : (
          <EmptyState variant="subtle" title={filter === "all" ? "No history yet" : `No ${filters.find((f) => f.value === filter)?.label.toLowerCase()} yet`} description={filter === "all" ? `${emptyHint} Drop a file here to attach it.` : undefined} />
        )}
        <div ref={sentinel} aria-hidden />
        {pages.loading ? (
          <p className="mt-3 flex items-center gap-2 pl-[9px] text-[12.5px] text-muted" role="status">
            <Spinner className="size-3.5" />
            Loading earlier history…
          </p>
        ) : pages.error ? (
          <p className="mt-3 pl-[9px] text-[12.5px] text-error" role="alert">
            {pages.error}{" "}
            <button type="button" onClick={loadMore} className="font-medium underline underline-offset-2">
              Try again
            </button>
          </p>
        ) : null}
      </section>
    </div>
  );
}

/** A note or task the agent was handed: how its background work is going. */
function AssistantStatus({ status }: { status: ActivityRow["assistantStatus"] }) {
  if (!status) return null;
  const tone = status === "done" ? "success" : status === "failed" ? "error" : status === "cancelled" ? "neutral" : "info";
  return (
    <StatusBadge tone={tone} icon={<SparklesIcon aria-hidden />}>
      {appConfig.agent.name}: {agentRunStatusLabels[status].toLowerCase()}
    </StatusBadge>
  );
}

/** Who did something: a teammate, a teammate through one of their API or MCP keys, or a workspace key. */
function Who({ id, apiKeyId }: { id: string | null; apiKeyId?: string | null }) {
  const { member, viewer, apiKey } = useApp();
  const m = member(id);
  const key = apiKey(apiKeyId);
  if (!m && key) return <span className="font-medium text-primary">{key.name}</span>;
  return (
    <>
      <span className="font-medium text-primary">{m ? (m.id === viewer.id ? "You" : m.name) : "Someone"}</span>
      {m && key ? <span className="text-muted"> via {key.name}</span> : null}
    </>
  );
}

/** Links to the other records an activity belongs to (on an organization page: which client, which person). */
function LinkedTo({ row, context }: { row: ActivityRow; context: Context }) {
  const a = row.activity;
  const parts: { href: string; label: string }[] = [];
  if (a.clientId && row.clientName && !(context.type === "client" && context.id === a.clientId)) parts.push({ href: `/clients/${a.clientId}`, label: row.clientName });
  if (a.personId && row.personName && !(context.type === "person" && context.id === a.personId)) parts.push({ href: `/people/${a.personId}`, label: row.personName });
  // Everyone else on it: a meeting's other attendees, an email's other recipients.
  for (const p of row.alsoPeople ?? []) if (!(context.type === "person" && context.id === p.id)) parts.push({ href: `/people/${p.id}`, label: p.name });
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

  // Checked off the moment it's clicked; it goes back if the server says no.
  const [done, showDone] = useOptimistic(false);
  const complete = () =>
    start(async () => {
      showDone(true);
      const r = await setCompleted(a.id, true);
      if (!r.ok) return void toast.error(r.error);
      // The "what's next" question depends on the server's answer, so it waits for it.
      toast.success(`${activityLabels[a.type]} done`, { label: "Undo", onClick: () => setCompleted(a.id, false) });
      if (r.data.clientWithoutNext) askNextStep({ clientId: r.data.clientWithoutNext, title: row.clientName ?? "This client" });
    });

  return (
    <li className={clsx("group flex items-start gap-3 px-3.5 py-2.5 transition-opacity", done && "opacity-60")}>
      <button
        type="button"
        onClick={complete}
        disabled={pending}
        className={clsx(
          "mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors",
          done ? "border-success bg-success-surface text-success" : "border-line-strong text-transparent hover:border-success hover:bg-success-surface hover:text-success disabled:opacity-50",
        )}
        aria-label={done ? `“${a.subject ?? activityLabels[a.type]}” done` : `Mark “${a.subject ?? activityLabels[a.type]}” done`}
      >
        <CheckIcon className="size-3" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Icon className="size-4 text-muted" aria-label={activityLabels[a.type]} />
          <span className={clsx("text-[14px] font-medium text-primary", done && "line-through")}>{a.subject || activityLabels[a.type]}</span>
          <Tooltip content={formatFull(a.dueAt!, tz)}>
            <span>
              <StatusBadge tone={tone}>
                {tone === "error" ? "Overdue · " : ""}
                {formatDay(a.dueAt!, tz)}
                {a.dueHasTime ? ` ${formatTime(a.dueAt!, tz)}` : ""}
              </StatusBadge>
            </span>
          </Tooltip>
          <AssistantStatus status={row.assistantStatus} />
        </div>
        {a.body ? <div className="prose-crm mt-1 line-clamp-3 text-[13px]" dangerouslySetInnerHTML={{ __html: a.body }} /> : row.preview ? <p className="mt-1 line-clamp-3 text-[13px] text-secondary">{row.preview.text}</p> : null}
        <Attachments files={attachments} />
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
          {assignee ? (
            <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-muted">
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
  // Pinned or unpinned the moment it's chosen; it goes back if the server says no. Moving to the top waits for the server.
  const [pinned, showPinned] = useOptimistic(a.pinned);
  const [, startPin] = useTransition();
  const togglePin = () =>
    startPin(async () => {
      showPinned(!pinned);
      const r = await setPinned(a.id, !pinned);
      if (!r.ok) toast.error(r.error);
    });
  const tz = workspace.timezone;
  const [editing, setEditing] = useState(false);
  const Icon = activityIcons[a.type];
  const at = a.occurredAt ?? a.completedAt ?? a.createdAt;
  // Calls, texts and mail that arrived by themselves: the other side is who did it.
  const arrived = !a.userId && (a.callId || a.textMessageId || a.syncedEmailId || a.inboxThreadId);
  const otherSide = a.type === "email" ? (row.inboxFrom ? senderName(row.inboxFrom) : row.synced?.from ?? null) : (row.personName ?? row.organizationName ?? formatPhone(row.call?.from ?? row.text?.from ?? ""));
  const verb =
    a.type === "note"
      ? "added a note"
      : a.type === "task"
        ? "completed a task"
        : a.callId
          ? "called"
          : a.textMessageId
            ? a.direction === "inbound"
              ? "texted"
              : row.campaignId
                ? "sent the text campaign"
                : "texted"
            : a.syncedEmailId
              ? a.direction === "inbound"
                ? "emailed"
                : "sent an email from Outlook"
        : a.type === "email"
          ? a.inboxThreadId && !a.userId
            ? a.direction === "inbound"
              ? "emailed"
              : `sent from ${row.inboxAddress ?? "an inbox"}`
            : row.campaignId
              ? "sent the campaign"
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
      <article className={clsx("group min-w-0 flex-1 rounded-xl border bg-surface px-3.5 py-3", pinned ? "border-line-strong shadow-sm" : "border-line")}>
        <header className="flex items-start gap-2">
          <div className="min-w-0 flex-1 text-[13px] text-muted">
            {arrived && a.direction === "inbound" && otherSide ? (
              <span className="font-medium text-primary">{otherSide}</span>
            ) : arrived ? (
              <span className="font-medium text-primary">{activityLabels[a.type]}</span>
            ) : (
              <Who id={a.userId} apiKeyId={a.apiKeyId} />
            )}{" "}
            {verb}
            {row.campaignId ? (
              <>
                {" "}
                <Link href={`/email/campaigns/${row.campaignId}`} className="font-medium text-secondary hover:text-primary">
                  {row.campaignName ?? "Campaign"}
                </Link>
              </>
            ) : null}
            {a.direction && a.type !== "note" ? (
              a.direction === "inbound" ? (
                <ArrowDownLeftIcon className="ml-1 inline size-3.5 align-[-2px]" aria-label="Inbound" />
              ) : (
                <ArrowUpRightIcon className="ml-1 inline size-3.5 align-[-2px]" aria-label="Outbound" />
              )
            ) : null}
            {a.outcome ? <span className="ml-1.5 rounded-sm bg-sunken px-1.5 py-0.5 text-[11.5px] font-medium text-secondary">{a.outcome}</span> : a.callId && row.call?.status && !["completed", "busy", "no-answer", "failed", "canceled"].includes(row.call.status) ? <span className="ml-1.5 rounded-sm bg-sunken px-1.5 py-0.5 text-[11.5px] font-medium text-secondary">In progress</span> : null}
            {a.callId ? (row.call?.seconds ? <span className="ml-1.5 text-[12px] tabular-nums">{formatCallDuration(row.call.seconds)}</span> : null) : a.durationMinutes ? <span className="ml-1.5 text-[12px] tabular-nums">{a.durationMinutes} min</span> : null}
            <Tooltip content={formatFull(at, tz)}>
              <time dateTime={new Date(at).toISOString()} className="ml-1.5 text-[12px] whitespace-nowrap text-faint" suppressHydrationWarning>
                · {formatDateTime(at, tz)}
              </time>
            </Tooltip>
            {pinned ? <span className="ml-1.5 text-[11.5px] font-medium text-secondary">· Pinned</span> : null}
            {row.assistantStatus ? (
              <span className="ml-1.5 inline-flex align-middle">
                <AssistantStatus status={row.assistantStatus} />
              </span>
            ) : null}
          </div>
          <ItemMenu row={row} onEdit={() => setEditing(true)} pin={{ pinned, toggle: togglePin }} />
        </header>
        {a.type === "email" && row.emailTo ? (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
            <span>
              To {row.emailTo}
              {row.emailCc ? ` · Cc ${row.emailCc}` : ""}
              {row.emailReplyTo ? ` · Replies to ${row.emailReplyTo}` : ""}
            </span>
            <Delivery delivery={row.delivery} />
          </div>
        ) : a.type === "email" && a.inboxThreadId && row.inboxTo?.length ? (
          <p className="mt-1 truncate text-[12px] text-muted">
            {a.direction === "inbound" && row.inboxFrom ? `From ${row.inboxFrom} · ` : ""}To {row.inboxTo.join(", ")}
          </p>
        ) : a.syncedEmailId && row.synced ? (
          <p className="mt-1 truncate text-[12px] text-muted">
            {a.direction === "inbound" && row.synced.from ? `From ${row.synced.from} · ` : ""}
            {row.synced.to?.length ? `To ${row.synced.to.join(", ")}` : ""}
          </p>
        ) : a.textMessageId && row.text ? (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
            <span className="tabular-nums">
              {a.direction === "inbound" ? `From ${formatPhone(row.text.from)} to ${formatPhone(row.text.to)}` : `To ${formatPhone(row.text.to)} from ${formatPhone(row.text.from)}`}
            </span>
            {a.direction === "outbound" && row.text.status ? (
              <Tooltip content={row.text.error ?? textStatusLabels[row.text.status]}>
                <StatusBadge tone={row.text.status === "delivered" ? "success" : row.text.status === "failed" || row.text.status === "undelivered" ? "error" : "neutral"}>{textStatusLabels[row.text.status]}</StatusBadge>
              </Tooltip>
            ) : null}
            {row.text.media?.length ? <span>{row.text.media.length === 1 ? "1 picture or file (open it in Twilio)" : `${row.text.media.length} pictures or files (open them in Twilio)`}</span> : null}
          </div>
        ) : a.callId && row.call ? (
          <p className="mt-1 truncate text-[12px] text-muted tabular-nums">{a.direction === "inbound" ? `From ${formatPhone(row.call.from)} to ${formatPhone(row.call.to)}` : `To ${formatPhone(row.call.to)} from ${formatPhone(row.call.from)}`}</p>
        ) : null}
        {a.subject ? <h3 className="mt-1 text-[14px] font-medium">{a.subject}</h3> : null}
        {a.body ? <CollapsibleBody html={a.body} /> : row.preview ? <PreviewBody key={`${a.id}:${String(a.updatedAt)}`} id={a.id} preview={row.preview} /> : null}
        <Attachments files={withEmailAttachments(attachments, row)} />
        {a.type === "note" ? <Replies noteId={a.id} replies={row.replies ?? []} /> : null}
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

/**
 * Where a sent email got to. Shows nothing until Resend's first report. Opens
 * and clicks show beside it only when this deployment tracks them
 * (`email` in app.config.ts); opens are a hint, never the status.
 */
function Delivery({ delivery }: { delivery: ActivityRow["delivery"] }) {
  const { workspace } = useApp();
  if (!delivery?.status) return null;
  const tz = workspace.timezone;
  const when = delivery.at ? ` ${formatDateTime(delivery.at, tz)}` : "";
  const { trackOpens, trackClicks } = appConfig.email;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Tooltip content={delivery.detail ?? `${deliveryLabels[delivery.status]}${when}`}>
        <StatusBadge tone={deliveryTone[delivery.status]}>{deliveryLabels[delivery.status]}</StatusBadge>
      </Tooltip>
      {trackClicks && delivery.clickedAt ? (
        <Tooltip content={`First clicked ${formatDateTime(delivery.clickedAt, tz)}`}>
          <span className="text-secondary">Clicked{delivery.clicks > 1 ? ` ${delivery.clicks}×` : ""}</span>
        </Tooltip>
      ) : trackOpens && delivery.openedAt ? (
        <Tooltip content={`First opened ${formatDateTime(delivery.openedAt, tz)}. Some mail apps open emails automatically, so treat this as a hint.`}>
          <span className="text-secondary">Opened{delivery.opens > 1 ? ` ${delivery.opens}×` : ""}</span>
        </Tooltip>
      ) : null}
    </span>
  );
}

/** An email's attachments: the files folded into it, plus any it was sent with from elsewhere (a template's). */
function withEmailAttachments(files: RecordFile[] | undefined, row: ActivityRow): RecordFile[] | undefined {
  const sent = row.emailAttachments ?? [];
  if (!sent.length) return files;
  const have = new Set((files ?? []).map((f) => f.id));
  const extra = sent
    .filter((a) => !have.has(a.fileId))
    .map((a): RecordFile => ({ id: a.fileId, name: a.name, size: a.size, contentType: a.contentType, uploadedBy: "", createdAt: row.activity.createdAt, activityId: row.activity.id, activityType: "email", publicToken: null }));
  return [...(files ?? []), ...extra];
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
/**
 * A body in a list (the Activities page, the home feed), which sends only its
 * start as plain text: "Show more" fetches the whole thing, formatting included.
 * Keyed on the activity's `updatedAt`, so an edit drops the fetched copy.
 */
function PreviewBody({ id, preview }: { id: string; preview: { text: string; more: boolean } }) {
  const [html, setHtml] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (html !== null) return <CollapsibleBody html={html} />;
  return (
    <div className="mt-1">
      <div className="prose-crm line-clamp-6">
        <p>
          {preview.text}
          {preview.more ? "…" : ""}
        </p>
      </div>
      {preview.more ? (
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await loadActivityBody(id);
              if (!r.ok) return void toast.error(r.error);
              setHtml(r.data.body ?? "");
            })
          }
          className="mt-1 text-[12.5px] font-medium text-secondary hover:text-primary disabled:opacity-60"
        >
          {pending ? "Loading…" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

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

/**
 * The replies under a note, oldest first, and the box to add one. A reply
 * stays with the note it answers: teammates answer each other here, and the
 * agent answers here when a note or a reply calls on it.
 */
function Replies({ noteId, replies: saved }: { noteId: string; replies: NoteReply[] }) {
  const { viewer, isAdmin, canEdit, workspace, services } = useApp();
  const tz = workspace.timezone;
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [pending, start] = useTransition();
  // A reply shows under the note the moment it's sent. If the server says no it's taken back and the text returns to the box.
  const [replies, showReply] = useOptimistic(saved, (list, r: NoteReply) => [...list, r]);
  const send = () => {
    if (pending) return;
    const text = body;
    start(async () => {
      showReply({ id: `pending-${Date.now()}`, body: text, userId: viewer.id, apiKeyId: null, createdAt: new Date().toISOString() });
      setBody("");
      setOpen(false);
      const r = await replyToNote(noteId, text);
      if (!r.ok) {
        toast.error(r.error);
        setBody(text);
        setOpen(true);
      }
    });
  };
  if (!replies.length && !canEdit) return null;
  return (
    <div className={clsx("mt-2", replies.length && "border-t border-line pt-2")}>
      {replies.length ? (
        <ul className="flex flex-col gap-2.5">
          {replies.map((r) => (
            <li key={r.id} className="group/reply flex gap-2.5 border-l-2 border-line pl-3">
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] text-muted">
                  <Who id={r.userId} apiKeyId={r.apiKeyId} /> replied
                  <Tooltip content={formatFull(new Date(r.createdAt), tz)}>
                    <time dateTime={r.createdAt} className="ml-1.5 text-[12px] whitespace-nowrap text-faint" suppressHydrationWarning>
                      · {formatDateTime(new Date(r.createdAt), tz)}
                    </time>
                  </Tooltip>
                </p>
                <CollapsibleBody html={r.body} />
              </div>
              {(r.userId === viewer.id || isAdmin) && !r.id.startsWith("pending-") ? (
                <button
                  type="button"
                  className="-mt-0.5 h-fit rounded-md p-1 text-faint opacity-0 transition-opacity group-hover/reply:opacity-100 hover:bg-sunken hover:text-primary focus:opacity-100"
                  aria-label="Delete reply"
                  onClick={async () => {
                    if (!confirm("Delete this reply? It's removed for everyone and can't be undone.")) return;
                    const res = await deleteReply(r.id);
                    if (!res.ok) toast.error(res.error);
                    else toast.success("Reply deleted");
                  }}
                >
                  <TrashIcon className="size-3.5" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {!canEdit ? null : open ? (
        <div className={clsx(replies.length && "mt-2.5")}>
          <RichText
            value={body}
            onChange={setBody}
            onSubmit={send}
            minHeight={56}
            autoFocus
            toolbar={false}
            placeholder={services.ai.background ? `Reply. Type @ and a teammate's name to notify them, or @${appConfig.agent.name} to hand it something.` : "Reply. Type @ and a teammate's name to notify them."}
          />
          <div className="mt-1.5 flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setOpen(false);
                setBody("");
              }}
            >
              Cancel
            </Button>
            <Button size="sm" variant="primary" loading={pending} onClick={send}>
              Reply
            </Button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)} onPointerEnter={() => void preloadRichText().catch(() => {})} onFocus={() => void preloadRichText().catch(() => {})} className={clsx("inline-flex items-center gap-1 text-[12.5px] font-medium text-secondary hover:text-primary", replies.length && "mt-2")}>
          <ArrowUturnLeftIcon className="size-3.5" aria-hidden />
          Reply
        </button>
      )}
    </div>
  );
}

function ItemMenu({ row, onEdit, pin }: { row: ActivityRow; onEdit: () => void; pin?: { pinned: boolean; toggle: () => void } }) {
  const { viewer, isAdmin, canEdit: canWrite } = useApp();
  const a = row.activity;
  const canEdit = a.userId === viewer.id || isAdmin || a.type === "task" || !a.completedAt || (!!a.callId && (a.assigneeId === viewer.id || !a.userId));
  // Admins can delete anything; everyone else what they sent or logged, and mail copied from their own mailbox. The server checks the same.
  const canDelete = a.userId === viewer.id || isAdmin || (!!a.syncedEmailId && row.synced?.mailboxUserId === viewer.id);
  // Mail copied from the viewer's own mailbox can go back to being theirs alone.
  const canMakePrivate = !!a.syncedEmailId && row.synced?.mailboxUserId === viewer.id && canWrite;
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="-mt-0.5 -mr-1 rounded-md p-1 text-faint opacity-60 transition-opacity group-hover:opacity-100 hover:bg-sunken hover:text-primary focus:opacity-100" aria-label="More actions">
          <EllipsisHorizontalIcon className="size-4" />
        </button>
      </MenuTrigger>
      <MenuContent className="w-44">
        {canEdit && !a.emailId && !a.inboxThreadId && !a.textMessageId && !a.syncedEmailId ? (
          <MenuItem icon={<PencilSquareIcon />} onSelect={onEdit}>
            Edit
          </MenuItem>
        ) : null}
        {a.completedAt || !a.dueAt ? (
          <MenuItem
            icon={<SparklesIcon />}
            onSelect={async () => {
              if (pin) return pin.toggle();
              const r = await setPinned(a.id, !a.pinned);
              if (!r.ok) toast.error(r.error);
            }}
          >
            {(pin?.pinned ?? a.pinned) ? "Unpin" : "Pin to top"}
          </MenuItem>
        ) : null}
        {a.completedAt && a.dueAt ? (
          <MenuItem icon={<ArrowsRightLeftIcon />} onSelect={async () => void (await setCompleted(a.id, false))}>
            Mark not done
          </MenuItem>
        ) : null}
        {canMakePrivate ? (
          <MenuItem
            icon={<LockClosedIcon />}
            onSelect={async () => {
              const r = await setSyncedEmailVisibility({ id: a.syncedEmailId!, visibility: "private" });
              if (!r.ok) toast.error(r.error);
              else toast.success("Only you see this email now");
            }}
          >
            Make private
          </MenuItem>
        ) : null}
        {canDelete ? (
          <>
            <MenuSeparator />
            <MenuItem
              destructive
              icon={<TrashIcon />}
              onSelect={async () => {
                const what = activityLabels[a.type].toLowerCase();
                if (!confirm(`Delete this ${what}? It's removed from every record, for everyone, and can't be undone.`)) return;
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

/** Editing from a list that only had the body's preview: the whole body is fetched first, so saving never cuts it short. */
function EditActivity({ row, onClose }: { row: ActivityRow; onClose: () => void }) {
  const needsBody = !row.activity.body && !!row.preview;
  const [full, setFull] = useState<string | null>(needsBody ? null : (row.activity.body ?? ""));
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (!needsBody) return;
    let live = true;
    void loadActivityBody(row.activity.id).then((r) => {
      if (!live) return;
      if (!r.ok) {
        toast.error(r.error);
        close.current();
      } else setFull(r.data.body ?? "");
    });
    return () => {
      live = false;
    };
  }, [needsBody, row.activity.id]);
  if (full === null)
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()} title="Edit" size="md">
        <p className="flex items-center gap-2 text-[13px] text-muted" role="status">
          <Spinner className="size-3.5" />
          Loading…
        </p>
      </Dialog>
    );
  return <EditActivityForm row={{ ...row, activity: { ...row.activity, body: full || null } }} onClose={onClose} />;
}

function EditActivityForm({ row, onClose }: { row: ActivityRow; onClose: () => void }) {
  const { workspace, services, canEdit } = useApp();
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
  // An open task can be handed to the agent: it stays this teammate's, and the agent does the work for them.
  const forAssistant = assigneeId === AGENT_ASSIGNEE;
  const save = () =>
    start(async () => {
      const at = zonedTime(day, time || "00:00", tz).toISOString();
      const r = await updateActivity(a.id, {
        subject: subject || null,
        body,
        ...(open ? { dueAt: at, dueHasTime: !!time, ...(forAssistant ? { agent: true } : { assigneeId }) } : a.type !== "note" ? { occurredAt: at } : {}),
      });
      if (!r.ok) return void toast.error(r.error);
      toast.success(forAssistant ? `${appConfig.agent.name} is on it. The answer lands on the task.` : "Saved");
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
            {open ? <Field label="Assigned to">{(p) => <OwnerSelect id={p.id} value={assigneeId} onChange={setAssigneeId} allowNone={false} agent={a.type === "task" && services.ai.background && canEdit} />}</Field> : null}
          </div>
        ) : null}
        <RichText value={body} onChange={setBody} onSubmit={save} minHeight={120} autoFocus={a.type === "note"} dictation />
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
  if (field === "interval") return billingIntervalLabels[v as BillingInterval]?.label.toLowerCase() ?? String(v);
  if (Array.isArray(v)) return v.join(", ");
  if (field === "organizationId" || field === "personId") return "a deleted record";
  return String(v);
};

/** One line of history: who changed what, from what, to what. */
/** History the CRM writes by itself, which reads as a sentence with no one in front. */
const systemEvents = new Set(["email_bounced", "email_complained", "texts_opted_out", "texts_opted_in", "billing_changed"]);

function EventItem({ event }: { event: { id: string; action: string; data: Record<string, unknown>; userId: string | null; apiKeyId: string | null; createdAt: Date } }) {
  const { workspace, member, money } = useApp();
  const tz = workspace.timezone;
  const d = event.data as {
    account?: string;
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
    email?: string;
    detail?: string | null;
    phone?: string;
    /** Duplicates merged into this record (scripts/dedupe.ts). */
    merged?: { name: string }[];
    deleted?: { name: string }[];
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
    case "person_added":
      text = <>added <strong className="font-medium text-secondary">{d.name ?? "a person"}</strong> to this client&apos;s people</>;
      icon = <UserPlusIcon className="size-3.5" />;
      break;
    case "person_removed":
      text = <>took <strong className="font-medium text-secondary">{d.name ?? "a person"}</strong> off this client&apos;s people</>;
      icon = <TrashIcon className="size-3.5" />;
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
      text = (
        <>
          linked the Stripe customer {d.name ?? ""}
          {d.account ? ` (${d.account})` : ""}
        </>
      );
      icon = <CreditCardIcon className="size-3.5" />;
      break;
    case "stripe_unlinked":
      text = <>took a Stripe customer off this client</>;
      icon = <CreditCardIcon className="size-3.5" />;
      break;
    // Written by the Stripe sync, not by a person.
    case "billing_changed":
      text = (
        <>
          Billing in Stripe went from <strong className="font-medium text-secondary">{billingStatusLabels[d.from as BillingStatus] ?? "not a customer"}</strong> to{" "}
          <strong className="font-medium text-secondary">{billingStatusLabels[d.to as BillingStatus] ?? "not a customer"}</strong>
        </>
      );
      icon = <CreditCardIcon className="size-3.5" />;
      break;
    // Written by Resend's delivery reports, not by a person.
    case "email_bounced":
      text = (
        <>
          Email to {d.email} bounced{d.detail ? <> ({d.detail})</> : null}. Campaigns skip this address until it changes.
        </>
      );
      icon = <XCircleIcon className="size-3.5 text-error" />;
      break;
    case "email_complained":
      text = <>{d.email} marked an email as spam, so they were unsubscribed from campaigns.</>;
      icon = <XCircleIcon className="size-3.5 text-error" />;
      break;
    case "texts_opted_out":
      text = <>{d.phone ? <>{d.phone} replied STOP</> : <>They replied STOP</>}, so texts to them are blocked until they reply START.</>;
      icon = <XCircleIcon className="size-3.5 text-error" />;
      break;
    case "texts_opted_in":
      text = <>{d.phone ? <>{d.phone} replied START</> : <>They replied START</>}, so they can be texted again.</>;
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
    case "merged": {
      const merged = d.merged?.length ?? 0;
      const deleted = d.deleted?.length ?? 0;
      text = (
        <>
          {merged ? <>merged {merged === 1 ? "a duplicate" : `${merged} duplicates`} into this</> : null}
          {merged && deleted ? "; " : null}
          {deleted ? <>removed {deleted === 1 ? "an empty duplicate" : `${deleted} empty duplicates`}</> : null}
        </>
      );
      icon = <ArrowsRightLeftIcon className="size-3.5" />;
      break;
    }
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
    case "file_attached":
      text = <>attached the file {d.name}</>;
      icon = <PaperClipIcon className="size-3.5" />;
      break;
    case "file_detached":
      text = <>took the file {d.name} off this</>;
      icon = <PaperClipIcon className="size-3.5" />;
      break;
    case "file_shared":
      text = <>made the file {d.name} public: anyone with its link can open it</>;
      icon = <LinkIcon className="size-3.5" />;
      break;
    case "file_unshared":
      text = <>made the file {d.name} internal: its public link stopped working</>;
      icon = <LockClosedIcon className="size-3.5" />;
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
        {systemEvents.has(event.action) ? null : (
          <>
            <Who id={event.userId} apiKeyId={event.apiKeyId} />{" "}
          </>
        )}
        {text}
        <time dateTime={new Date(event.createdAt).toISOString()} className="ml-1.5 whitespace-nowrap text-faint" title={formatFull(event.createdAt, tz)} suppressHydrationWarning>
          · {formatDateTime(event.createdAt, tz)}
        </time>
      </p>
    </li>
  );
}

/** Several routine changes in a row, folded into one line that opens to show each. */
function ChangeGroup({ events }: { events: EventEntry[] }) {
  const { workspace, member, viewer, apiKey } = useApp();
  const [open, setOpen] = useState(false);
  // Changes the CRM made by itself (a Stripe sync, a bounce) have no one to name.
  const byPeople = events.filter((e) => !systemEvents.has(e.event.action));
  const people = [...new Set(byPeople.map((e) => e.event.userId ?? e.event.apiKeyId))].map((id) =>
    id === viewer.id ? "You" : (member(id)?.name ?? apiKey(id)?.name ?? "Someone"),
  );
  const newest = events[0].event.createdAt;
  return (
    <>
      <li className="relative flex items-start gap-3 py-0.5 pl-[9px]">
        <span className="relative z-10 mt-0.5 flex size-[14px] items-center justify-center rounded-full bg-background text-faint ring-4 ring-background">
          <PencilSquareIcon className="size-3.5" />
        </span>
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-w-0 flex-1 items-start gap-1 text-left text-[12.5px] leading-5 text-muted hover:text-secondary">
          <span>
            {people.length ? (
              <>
                <span className="font-medium text-primary">{people.length > 2 ? `${people.slice(0, 2).join(", ")} and others` : people.join(" and ")}</span> made {events.length} changes
              </>
            ) : (
              <>{events.length} automatic updates</>
            )}
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

/**
 * An email the sync kept private: it came from the viewer's own mailbox and
 * isn't on the record. The server only ever puts it in their own timeline.
 */
function PrivateMailItem({ mail, at }: { mail: Extract<TimelineItem, { kind: "privateMail" }>["mail"]; at: string }) {
  const { workspace, canEdit } = useApp();
  const tz = workspace.timezone;
  const Icon = activityIcons.email;
  return (
    <li className="relative flex gap-3">
      <span className="relative z-10 mt-2.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed border-line-strong bg-surface">
        <Icon className="size-4 text-secondary" aria-hidden />
      </span>
      <article className="group min-w-0 flex-1 rounded-xl border border-dashed border-line-strong bg-surface px-3.5 py-3">
        <header className="flex items-start gap-2">
          <div className="min-w-0 flex-1 text-[13px] text-muted">
            <span className="font-medium text-primary">{mail.direction === "inbound" ? (mail.from ?? "Email") : "You"}</span> {mail.direction === "inbound" ? "emailed" : "sent an email from Outlook"}
            <Tooltip content={formatFull(at, tz)}>
              <time dateTime={at} className="ml-1.5 text-[12px] whitespace-nowrap text-faint" suppressHydrationWarning>
                · {formatDateTime(at, tz)}
              </time>
            </Tooltip>
            <span className="ml-2 inline-flex items-center gap-1 align-middle text-[11.5px] font-medium text-secondary">
              <LockClosedIcon className="size-3" aria-hidden />
              Private: only you see this
            </span>
          </div>
          {canEdit ? (
            <Menu>
              <MenuTrigger asChild>
                <button type="button" className="-mt-0.5 -mr-1 rounded-md p-1 text-faint opacity-60 transition-opacity group-hover:opacity-100 hover:bg-sunken hover:text-primary focus:opacity-100" aria-label="More actions">
                  <EllipsisHorizontalIcon className="size-4" />
                </button>
              </MenuTrigger>
              <MenuContent className="w-48">
                <MenuItem
                  icon={<UserPlusIcon />}
                  onSelect={async () => {
                    const r = await setSyncedEmailVisibility({ id: mail.id, visibility: "public" });
                    if (!r.ok) toast.error(r.error);
                    else toast.success("Shared with the team");
                  }}
                >
                  Share with the team
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  destructive
                  icon={<TrashIcon />}
                  onSelect={async () => {
                    if (!confirm("Delete this email from the CRM? It stays in your Outlook and isn't synced again.")) return;
                    const r = await deletePrivateEmail(mail.id);
                    if (!r.ok) toast.error(r.error);
                    else toast.success("Email deleted");
                  }}
                >
                  Delete
                </MenuItem>
              </MenuContent>
            </Menu>
          ) : null}
        </header>
        {mail.subject ? <p className="mt-1 text-[14px] font-medium text-primary">{mail.subject}</p> : null}
        {mail.to.length ? (
          <p className="mt-1 truncate text-[12px] text-muted">
            {mail.direction === "inbound" && mail.from ? `From ${mail.from} · ` : ""}To {mail.to.join(", ")}
          </p>
        ) : null}
        {mail.body ? <CollapsibleBody html={mail.body} /> : null}
      </article>
    </li>
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
