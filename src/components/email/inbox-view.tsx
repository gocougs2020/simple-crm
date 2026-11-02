"use client";

import clsx from "clsx";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  ArchiveBoxIcon,
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  ChevronLeftIcon,
  EllipsisHorizontalIcon,
  EnvelopeIcon as EnvelopeSolid,
  ExclamationTriangleIcon,
  InboxIcon,
  PaperClipIcon,
  PencilSquareIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import { EnvelopeIcon, InboxStackIcon } from "@heroicons/react/24/outline";
import { composeEmail, linkThread, markThreadRead, moveThread, replyToThread, syncNow } from "@/actions/inbox";
import { useApp } from "@/components/app-context";
import { RecordPicker } from "@/components/records/record-picker";
import { PageHeader } from "@/components/shell/app-shell";
import { SearchBox } from "@/components/table/toolbar";
import { useListParams } from "@/components/table/use-params";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/field";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Tooltip } from "@/components/ui/menu";
import { RichText, type RichTextHandle } from "@/components/ui/rich-text";
import { toast } from "@/components/ui/toast";
import { formatAgo, formatDateTime, formatFull } from "@/lib/format";
import { EmailTabs } from "./email-tabs";

export type InboxSummary = { id: string; address: string; name: string | null; unread: number };

export type InboxThreadRow = {
  id: string;
  subject: string | null;
  snippet: string | null;
  participants: string[];
  read: boolean;
  messageCount: number;
  lastMessageAt: string | null;
  inboxAddress: string;
  lastFrom: string | null;
  personId: string | null;
  personName: string | null;
  clientId: string | null;
  clientName: string | null;
};

export type OpenThread = {
  id: string;
  subject: string | null;
  folder: "inbox" | "archive" | "spam" | "sent" | "trash";
  read: boolean;
  inboxAddress: string;
  person: { id: string; label: string } | null;
  client: { id: string; label: string } | null;
  messages: {
    id: string;
    direction: "inbound" | "outbound";
    from: string;
    to: string[];
    cc: string[];
    subject: string | null;
    html: string | null;
    sentAt: string;
    attachments: { id: string; filename: string | null; size: number | null }[];
    userId: string | null;
  }[];
};

type Filters = { folder: string; inbox?: string; q?: string; unlinked?: boolean };

const folderList = [
  { value: "inbox", label: "Inbox", icon: InboxIcon },
  { value: "sent", label: "Sent", icon: EnvelopeSolid },
  { value: "archive", label: "Archive", icon: ArchiveBoxIcon },
  { value: "spam", label: "Spam", icon: ExclamationTriangleIcon },
  { value: "trash", label: "Trash", icon: TrashIcon },
] as const;

/** "Sam Lee <sam@acme.com>" → "Sam Lee"; a bare address stays as is. */
function nameOf(raw: string) {
  const name = /^\s*"?([^"<]+?)"?\s*</.exec(raw)?.[1]?.trim();
  return name || (/<([^>]+)>/.exec(raw)?.[1] ?? raw).trim();
}

const splitAddresses = (s: string) =>
  s
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * The shared inbox: every conversation in the workspace's Resend inboxes,
 * each linked to the person and client it's about. Filters live in the URL.
 */
export function InboxView({
  configured,
  isAdmin,
  inboxes,
  inboxError,
  threads,
  open,
  filters,
}: {
  configured: boolean;
  isAdmin: boolean;
  inboxes: InboxSummary[];
  inboxError: string | null;
  threads: InboxThreadRow[];
  open: OpenThread | null;
  filters: Filters;
}) {
  const [syncing, startSync] = useTransition();
  const [composing, setComposing] = useState(false);
  const sync = () =>
    startSync(async () => {
      const r = await syncNow();
      if (!r.ok) return void toast.error(r.error);
      toast.success(r.data.synced ? `${r.data.synced} conversation${r.data.synced === 1 ? "" : "s"} updated` : "Inbox is up to date");
    });

  const settingsLink = isAdmin ? (
    <Button variant="primary" asChild>
      <Link href="/settings/email">Set up email domains</Link>
    </Button>
  ) : null;

  if (!configured)
    return (
      <>
        <PageHeader title="Email" />
        <EmailTabs />
        <div className="p-4 lg:p-6">
          <EmptyState
            icon={EnvelopeIcon}
            title="Email isn't connected yet"
            description={
              isAdmin
                ? "Add RESEND_API_KEY to the environment, then add your domains and inboxes in Settings → Email domains. Mail to those inboxes shows up here, linked to each person and client."
                : "Ask an admin to connect Resend and set up the team's inboxes. Mail to those inboxes will show up here."
            }
            action={settingsLink}
          />
        </div>
      </>
    );

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col lg:h-dvh">
      <PageHeader title="Email">
        <Button variant="outline" onClick={sync} loading={syncing}>
          {!syncing ? <ArrowPathIcon /> : null}
          Sync now
        </Button>
        {inboxes.length ? (
          <Button variant="primary" onClick={() => setComposing(true)}>
            <PencilSquareIcon />
            New email
          </Button>
        ) : null}
      </PageHeader>
      <EmailTabs />
      {inboxError ? <p className="border-b border-line bg-warning-surface px-4 py-2 text-[13px] text-warning lg:px-6">Couldn&apos;t load inboxes from Resend: {inboxError}</p> : null}
      {!inboxes.length && !inboxError && !threads.length ? (
        <div className="p-4 lg:p-6">
          <EmptyState
            icon={InboxStackIcon}
            title="No inboxes yet"
            description={isAdmin ? "Add a domain with receiving turned on, then create an inbox like hello@yourdomain.com in Settings → Email domains." : "Ask an admin to create an inbox in Settings → Email domains."}
            action={settingsLink}
          />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 md:grid-cols-[190px_minmax(0,1fr)] lg:grid-cols-[200px_340px_minmax(0,1fr)]">
          <Rail inboxes={inboxes} filters={filters} hidden={!!open} />
          <ThreadList threads={threads} filters={filters} openId={open?.id ?? null} hidden={!!open} />
          <div className={clsx("min-h-0 min-w-0 overflow-y-auto border-line scroll-thin lg:border-l", open ? "md:col-span-2 lg:col-span-1" : "hidden lg:block")}>
            {open ? <ThreadPane key={open.id} thread={open} /> : <EmptyState variant="minimal" icon={EnvelopeIcon} title="Pick a conversation" description="Replies send from the inbox it arrived in and land on the linked records' timelines." className="h-full" />}
          </div>
        </div>
      )}
      {composing ? <Compose inboxes={inboxes} defaultInbox={filters.inbox} onClose={() => setComposing(false)} /> : null}
    </div>
  );
}

function Rail({ inboxes, filters, hidden }: { inboxes: InboxSummary[]; filters: Filters; hidden: boolean }) {
  const { set } = useListParams();
  const item = (active: boolean) =>
    clsx("flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium", active ? "bg-accent-soft text-primary" : "text-secondary hover:bg-sunken hover:text-primary");
  return (
    <nav aria-label="Inboxes and folders" className={clsx("min-h-0 flex-col gap-4 overflow-y-auto border-line p-2 scroll-thin md:flex md:border-r", hidden ? "hidden" : "flex border-b md:border-b-0")}>
      <div>
        <p className="px-2.5 pb-1 text-table-header">Inboxes</p>
        <button type="button" className={item(!filters.inbox)} onClick={() => set({ inbox: null, t: null })}>
          <span className="flex-1 truncate">All inboxes</span>
        </button>
        {inboxes.map((i) => (
          <button key={i.id} type="button" className={item(filters.inbox === i.id)} onClick={() => set({ inbox: i.id, t: null })} title={i.address}>
            <span className="min-w-0 flex-1 truncate">{i.name || i.address}</span>
            {i.unread ? <span className="text-[11.5px] font-semibold text-primary tabular-nums">{i.unread}</span> : null}
          </button>
        ))}
      </div>
      <div>
        <p className="px-2.5 pb-1 text-table-header">Folders</p>
        {folderList.map((f) => (
          <button key={f.value} type="button" className={item(filters.folder === f.value && !filters.unlinked)} onClick={() => set({ folder: f.value === "inbox" ? null : f.value, unlinked: null, t: null })}>
            <f.icon className="size-4 text-faint" aria-hidden />
            {f.label}
          </button>
        ))}
        <button type="button" className={item(!!filters.unlinked)} onClick={() => set({ unlinked: filters.unlinked ? null : "1", t: null })}>
          <span className="size-4" aria-hidden />
          Not linked yet
        </button>
      </div>
    </nav>
  );
}

function ThreadList({ threads, filters, openId, hidden }: { threads: InboxThreadRow[]; filters: Filters; openId: string | null; hidden: boolean }) {
  const { workspace } = useApp();
  const { set } = useListParams();
  const folderLabel = folderList.find((f) => f.value === filters.folder)?.label ?? "Inbox";
  return (
    <div className={clsx("min-h-0 flex-col overflow-hidden", hidden ? "hidden lg:flex" : "flex")}>
      <div className="border-b border-line p-2">
        <SearchBox placeholder="Search mail" />
      </div>
      <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto scroll-thin">
        {threads.map((t) => {
          const who = t.lastFrom ? nameOf(t.lastFrom) : t.participants.length ? t.participants.slice(0, 2).join(", ") : t.inboxAddress;
          return (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => set({ t: t.id })}
                aria-current={openId === t.id ? "true" : undefined}
                className={clsx("flex w-full flex-col gap-0.5 px-3 py-2.5 text-left", openId === t.id ? "bg-accent-soft" : "hover:bg-sunken/60")}
              >
                <span className="flex items-center gap-2">
                  {!t.read ? <span className="size-2 shrink-0 rounded-full bg-accent" aria-label="Unread" /> : null}
                  <span className={clsx("min-w-0 flex-1 truncate text-[13.5px]", t.read ? "text-secondary" : "font-semibold text-primary")}>{who}</span>
                  {t.messageCount > 1 ? <span className="text-[11.5px] text-faint tabular-nums">{t.messageCount}</span> : null}
                  {t.lastMessageAt ? (
                    <time className="shrink-0 text-[11.5px] text-faint" dateTime={t.lastMessageAt} suppressHydrationWarning>
                      {formatAgo(t.lastMessageAt, workspace.timezone)}
                    </time>
                  ) : null}
                </span>
                <span className={clsx("truncate text-[13px]", t.read ? "text-secondary" : "font-medium text-primary")}>{t.subject || "(no subject)"}</span>
                {t.snippet ? <span className="line-clamp-1 text-[12.5px] text-muted">{t.snippet}</span> : null}
                {t.clientName || t.personName ? (
                  <span className="mt-0.5 flex min-w-0 gap-1">
                    {t.clientName ? <span className="truncate rounded-sm bg-sunken px-1.5 py-0.5 text-[11px] font-medium text-secondary">{t.clientName}</span> : null}
                    {t.personName ? <span className="truncate rounded-sm bg-sunken px-1.5 py-0.5 text-[11px] font-medium text-secondary">{t.personName}</span> : null}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
        {!threads.length ? (
          <li>
            <EmptyState
              variant="minimal"
              title={filters.q ? "Nothing matches" : `Nothing in ${folderLabel.toLowerCase()}`}
              description={filters.q ? "Try different words, or another folder." : filters.unlinked ? "Every conversation is linked to a person or client." : "New mail shows up here. Use Sync now if you're expecting something."}
            />
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function ThreadPane({ thread }: { thread: OpenThread }) {
  const { workspace, member } = useApp();
  const { set } = useListParams();
  const tz = workspace.timezone;
  const [pending, start] = useTransition();
  const editor = useRef<RichTextHandle>(null);
  const [body, setBody] = useState("");

  // Opening an unread conversation marks it read, here and in Resend.
  useEffect(() => {
    if (!thread.read) void markThreadRead(thread.id, true);
  }, [thread.id, thread.read]);

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, message: string, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) return void toast.error(r.error ?? "Something went wrong.");
      toast.success(message);
      after?.();
    });

  const move = (folder: "inbox" | "archive" | "spam" | "trash", message: string) => act(() => moveThread(thread.id, folder), message, () => set({ t: null }));

  const reply = (replyAll: boolean) =>
    act(
      () => replyToThread(thread.id, { body, replyAll }),
      "Reply sent",
      () => {
        editor.current?.clear();
        setBody("");
      },
    );

  const last = thread.messages.at(-1);

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 border-b border-line bg-surface px-4 py-3 lg:px-6">
        <div className="flex items-start gap-2">
          <button type="button" onClick={() => set({ t: null })} className="-ml-1 rounded-md p-1 text-muted hover:bg-sunken hover:text-primary lg:hidden" aria-label="Back to conversations">
            <ChevronLeftIcon className="size-5" />
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-semibold text-primary">{thread.subject || "(no subject)"}</h2>
            <p className="text-[12.5px] text-muted">
              In {thread.inboxAddress} · {thread.messages.length} message{thread.messages.length === 1 ? "" : "s"}
            </p>
          </div>
          <div className="flex items-center gap-1">
            {thread.folder !== "archive" ? (
              <Tooltip content="Archive">
                <Button variant="ghost" size="icon-sm" onClick={() => move("archive", "Conversation archived")} disabled={pending} aria-label="Archive">
                  <ArchiveBoxIcon />
                </Button>
              </Tooltip>
            ) : null}
            <Menu>
              <MenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="More actions">
                  <EllipsisHorizontalIcon />
                </Button>
              </MenuTrigger>
              <MenuContent className="w-48">
                <MenuItem icon={<EnvelopeSolid />} onSelect={() => act(() => markThreadRead(thread.id, false), "Marked unread", () => set({ t: null }))}>
                  Mark unread
                </MenuItem>
                {thread.folder !== "inbox" ? (
                  <MenuItem icon={<InboxIcon />} onSelect={() => move("inbox", "Moved to the inbox")}>
                    Move to inbox
                  </MenuItem>
                ) : null}
                {thread.folder !== "spam" ? (
                  <MenuItem icon={<ExclamationTriangleIcon />} onSelect={() => move("spam", "Marked as spam")}>
                    Mark as spam
                  </MenuItem>
                ) : null}
                {thread.folder !== "trash" ? (
                  <>
                    <MenuSeparator />
                    <MenuItem destructive icon={<TrashIcon />} onSelect={() => move("trash", "Moved to trash")}>
                      Move to trash
                    </MenuItem>
                  </>
                ) : null}
              </MenuContent>
            </Menu>
          </div>
        </div>
        <LinkBar thread={thread} />
      </header>

      <ol className="flex flex-col gap-3 px-4 py-4 lg:px-6">
        {thread.messages.map((m) => {
          const author = m.direction === "outbound" ? member(m.userId) : undefined;
          return (
            <li key={m.id} className={clsx("rounded-xl border px-4 py-3", m.direction === "outbound" ? "border-line bg-sunken/40" : "border-line bg-surface")}>
              <div className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                <span className="font-medium text-primary">{author ? `${author.name} (${nameOf(m.from)})` : nameOf(m.from)}</span>
                <span className="min-w-0 truncate text-muted">
                  to {m.to.map(nameOf).join(", ")}
                  {m.cc.length ? ` · cc ${m.cc.map(nameOf).join(", ")}` : ""}
                </span>
                <Tooltip content={formatFull(m.sentAt, tz)}>
                  <time className="ml-auto text-[12px] text-faint" dateTime={m.sentAt} suppressHydrationWarning>
                    {formatDateTime(m.sentAt, tz)}
                  </time>
                </Tooltip>
              </div>
              {m.html ? <div className="prose-crm mt-2 text-[13.5px] break-words" dangerouslySetInnerHTML={{ __html: m.html }} /> : <p className="mt-2 text-[13px] text-muted">No text in this email.</p>}
              {m.attachments.length ? (
                <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
                  <PaperClipIcon className="size-3.5" aria-hidden />
                  {m.attachments.map((a) => a.filename ?? "Attachment").join(", ")}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>

      {last ? (
        <div className="mt-auto border-t border-line px-4 py-3 lg:px-6">
          <RichText handle={editor} value={body} onChange={setBody} onSubmit={() => reply(false)} minHeight={96} placeholder={`Reply to ${nameOf([...thread.messages].reverse().find((m) => m.direction === "inbound")?.from ?? last.from)}`} />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <p className="text-fine">Sends from {thread.inboxAddress} and saves to the linked timelines.</p>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="outline" onClick={() => reply(true)} loading={pending}>
                Reply all
              </Button>
              <Button size="sm" variant="primary" onClick={() => reply(false)} loading={pending}>
                <ArrowUturnLeftIcon />
                Reply
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Who this conversation is about. Changing it moves every message to the new records' timelines. */
function LinkBar({ thread }: { thread: OpenThread }) {
  const [, start] = useTransition();
  const save = (patch: { personId?: string | null; clientId?: string | null }, message: string) =>
    start(async () => {
      const r = await linkThread(thread.id, patch);
      if (!r.ok) return void toast.error(r.error);
      toast.success(message);
    });
  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      <div className="min-w-0">
        <p className="mb-1 flex items-center justify-between text-[11.5px] font-medium text-muted">
          Person
          {thread.person ? (
            <Link href={`/people/${thread.person.id}`} className="hover:text-primary hover:underline">
              Open
            </Link>
          ) : null}
        </p>
        <RecordPicker
          kind="person"
          value={thread.person ? { record: thread.person } : null}
          allowCreate={false}
          placeholder="Link a person"
          onChange={(v) => save({ personId: v && "record" in v ? v.record.id : null }, v ? "Linked to the person" : "Person unlinked")}
        />
      </div>
      <div className="min-w-0">
        <p className="mb-1 flex items-center justify-between text-[11.5px] font-medium text-muted">
          Client
          {thread.client ? (
            <Link href={`/clients/${thread.client.id}`} className="hover:text-primary hover:underline">
              Open
            </Link>
          ) : null}
        </p>
        <RecordPicker
          kind="client"
          value={thread.client ? { record: thread.client } : null}
          allowCreate={false}
          placeholder="Link a client"
          onChange={(v) => save({ clientId: v && "record" in v ? v.record.id : null }, v ? "Linked to the client" : "Client unlinked")}
        />
      </div>
    </div>
  );
}

function Compose({ inboxes, defaultInbox, onClose }: { inboxes: InboxSummary[]; defaultInbox?: string; onClose: () => void }) {
  const [inboxId, setInboxId] = useState(defaultInbox && inboxes.some((i) => i.id === defaultInbox) ? defaultInbox : (inboxes[0]?.id ?? ""));
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [pending, start] = useTransition();
  const send = () =>
    start(async () => {
      const r = await composeEmail({ inboxId, to: splitAddresses(to), cc: splitAddresses(cc), subject, body });
      if (!r.ok) return void toast.error(r.error);
      toast.success("Email sent");
      onClose();
    });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New email"
      description="Sends from a team inbox. Replies come back here and to the linked records."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={send}>
            Send email
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="From">
          {(p) => (
            <Select id={p.id} value={inboxId} onChange={(e) => setInboxId(e.target.value)}>
              {inboxes.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name ? `${i.name} <${i.address}>` : i.address}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="To">{(p) => <Input {...p} value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@company.com" />}</Field>
        <Field label="Cc" optional>
          {(p) => <Input {...p} value={cc} onChange={(e) => setCc(e.target.value)} placeholder="name@company.com, …" />}
        </Field>
        <Field label="Subject">{(p) => <Input {...p} value={subject} onChange={(e) => setSubject(e.target.value)} />}</Field>
        <RichText value={body} onChange={setBody} onSubmit={send} minHeight={160} />
      </div>
    </Dialog>
  );
}
