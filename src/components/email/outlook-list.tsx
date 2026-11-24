"use client";

import clsx from "clsx";
import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { ArrowPathIcon, ChevronLeftIcon, LockClosedIcon, MagnifyingGlassIcon, NoSymbolIcon, PaperAirplaneIcon, TrashIcon, UserGroupIcon } from "@heroicons/react/20/solid";
import { EnvelopeIcon, InboxArrowDownIcon, InboxIcon } from "@heroicons/react/24/outline";
import { blockMailSender, deletePrivateEmail, setSyncedEmailVisibility, syncMyMailbox } from "@/actions/accounts";
import { deleteActivity } from "@/actions/activities";
import { useApp } from "@/components/app-context";
import { PageHeader } from "@/components/shell/app-shell";
import { Avatar } from "@/components/ui/avatar";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/components/ui/toast";
import { formatAgo, formatDateTime } from "@/lib/format";
import { EmailTabs } from "./email-tabs";

export type OutlookRow = {
  id: string;
  /** Its entry on the record; null while it's private. */
  activityId: string | null;
  /** `public`: on the record for the team. `private`: only this teammate sees it. */
  visibility: "public" | "private";
  reason: string | null;
  direction: "inbound" | "outbound";
  from: string | null;
  to: string[];
  /** The CRM person's name for the sender (mail in) or first recipient (mail out), when that address is theirs. */
  name: string | null;
  sentAt: string;
  subject: string | null;
  snippet: string;
  /** The whole email as text, for the reading pane. */
  body: string;
  /** What deleting it can put on the block list (received mail only): the sender, and their domain when it isn't a public or our own one. */
  block: { address: string; domain: string | null } | null;
  /** The sender is on the block list already (blocked after this one synced). */
  blocked: boolean;
  record: { href: string; label: string } | null;
  person: { href: string; label: string } | null;
};

type Folder = "all" | "inbound" | "outbound" | "public" | "private";

const folders: { value: Folder; label: string; icon: typeof InboxIcon }[] = [
  { value: "all", label: "All mail", icon: InboxIcon },
  { value: "inbound", label: "Received", icon: InboxArrowDownIcon },
  { value: "outbound", label: "Sent", icon: PaperAirplaneIcon },
];
const shows: { value: Folder; label: string; icon: typeof InboxIcon }[] = [
  { value: "public", label: "Shared with team", icon: UserGroupIcon },
  { value: "private", label: "Private to you", icon: LockClosedIcon },
];

const inFolder = (r: OutlookRow, f: Folder) => (f === "all" ? true : f === "inbound" || f === "outbound" ? r.direction === f : r.visibility === f);

/** Who the email is with, the way a mail client lists it: the sender for mail in, the first recipient for mail out. */
function correspondent(r: OutlookRow) {
  if (r.direction === "inbound") return { name: r.name ?? r.from ?? "Unknown sender", address: r.from };
  const first = r.to[0] ?? null;
  return { name: r.name ?? first ?? "Unknown recipient", address: first };
}

/**
 * Email → My Outlook: the mail the sync stored from the viewer's own mailbox,
 * laid out like a mail client (folders, the list, the open email). Each email
 * is either on its record for the team or private to them; they can switch it
 * either way, or delete it and block its sender. Their whole inbox stays in Outlook.
 */
export function OutlookList({
  account,
  rows,
  stats,
  category,
}: {
  account: { email: string; syncMail: boolean; needsReconnect: boolean; lastSyncAt: string | null; blocked: number } | null;
  rows: OutlookRow[];
  stats: { imported: number; private: number; withheld: number; unscreened: number } | null;
  category: string | null;
}) {
  const { workspace } = useApp();
  const [folder, setFolder] = useState<Folder>("all");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<OutlookRow | null>(null);
  const [syncing, startSync] = useTransition();
  const tz = workspace.timezone;

  const term = q.trim().toLowerCase();
  const shown = useMemo(
    () => rows.filter((r) => inFolder(r, folder) && (!term || [r.subject, r.snippet, r.from, ...r.to, r.person?.label, r.record?.label].some((v) => v?.toLowerCase().includes(term)))),
    [rows, folder, term],
  );
  // A row deleted or moved out of the folder closes; nothing else opens on its own.
  const open = shown.find((r) => r.id === openId) ?? null;
  const counts = useMemo(() => Object.fromEntries([...folders, ...shows].map((f) => [f.value, rows.filter((r) => inFolder(r, f.value)).length])) as Record<Folder, number>, [rows]);

  const syncButton =
    account?.syncMail && !account.needsReconnect ? (
      <Button
        variant="outline"
        loading={syncing}
        onClick={() =>
          startSync(async () => {
            const r = await syncMyMailbox();
            if (!r.ok) return void toast.error(r.error);
            toast.success(syncSummary(r.data));
          })
        }
      >
        {!syncing ? <ArrowPathIcon /> : null}
        Sync now
      </Button>
    ) : null;

  if (!account)
    return (
      <>
        <PageHeader title="Email" />
        <EmailTabs />
        <div className="p-4 lg:p-6">
          <EmptyState
            icon={EnvelopeIcon}
            title="Your Outlook isn't connected"
            description="Connect your Microsoft account to copy mail with contacts onto their records."
            action={
              <Button variant="primary" asChild>
                <Link href="/settings/accounts">Open Email and calendar settings</Link>
              </Button>
            }
          />
        </div>
      </>
    );

  const status = account.needsReconnect
    ? "Microsoft stopped letting the CRM in. Reconnect in Settings."
    : !account.syncMail
      ? "Mail sync is off, so nothing new is copied."
      : account.lastSyncAt
        ? `Last synced ${formatAgo(account.lastSyncAt, tz)}.`
        : "Not synced yet.";

  const item = (active: boolean) =>
    clsx("flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium", active ? "bg-accent-soft text-primary" : "text-secondary hover:bg-sunken hover:text-primary");

  return (
    <div className="flex h-app flex-col">
      <PageHeader title="Email">{syncButton}</PageHeader>
      <EmailTabs />
      <p className={clsx("border-b border-line px-4 py-2 text-[12.5px] tabular-nums lg:px-6", account.needsReconnect ? "bg-warning-surface text-warning" : "text-muted")}>
        <span className="font-medium text-secondary">{account.email}</span> · Only you see this list. {status}
        {stats ? ` Last 30 days: ${stats.imported} shared, ${stats.private} private, ${stats.withheld} not stored.` : ""}
        {category && stats?.withheld ? ` Emails that weren't stored have the “${category}” category in Outlook.` : ""}
      </p>

      <div className="grid min-h-0 flex-1 md:grid-cols-[190px_minmax(0,1fr)] lg:grid-cols-[200px_360px_minmax(0,1fr)]">
        <nav aria-label="Folders" className={clsx("min-h-0 flex-col gap-4 overflow-y-auto border-line p-2 scroll-thin md:flex md:border-r", open ? "hidden" : "flex border-b md:border-b-0")}>
          <div>
            <p className="px-2.5 pb-1 text-table-header">Mailbox</p>
            {folders.map((f) => (
              <button key={f.value} type="button" aria-pressed={folder === f.value} className={item(folder === f.value)} onClick={() => setFolder(f.value)}>
                <f.icon className="size-4 text-faint" aria-hidden />
                <span className="flex-1">{f.label}</span>
                <span className="text-[11.5px] text-faint tabular-nums">{counts[f.value]}</span>
              </button>
            ))}
          </div>
          <div>
            <p className="px-2.5 pb-1 text-table-header">Show</p>
            {shows.map((f) => (
              <button key={f.value} type="button" aria-pressed={folder === f.value} className={item(folder === f.value)} onClick={() => setFolder(folder === f.value ? "all" : f.value)}>
                <f.icon className="size-4 text-faint" aria-hidden />
                <span className="flex-1">{f.label}</span>
                <span className="text-[11.5px] text-faint tabular-nums">{counts[f.value]}</span>
              </button>
            ))}
          </div>
          <div>
            <p className="px-2.5 pb-1 text-table-header">Sync</p>
            <Link href="/email/blocked" className={item(false)}>
              <NoSymbolIcon className="size-4 text-faint" aria-hidden />
              <span className="flex-1">Block list</span>
              <span className="text-[11.5px] text-faint tabular-nums">{account.blocked}</span>
            </Link>
            <Link href="/settings/accounts" className={item(false)}>
              <span className="size-4" aria-hidden />
              <span className="flex-1">Settings</span>
            </Link>
          </div>
        </nav>

        <div className={clsx("min-h-0 flex-col overflow-hidden", open ? "hidden lg:flex" : "flex")}>
          <div className="border-b border-line p-2">
            <label className="relative block">
              <span className="sr-only">Search mail</span>
              <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint" aria-hidden />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search mail"
                className="h-8 w-full rounded-md border border-line bg-surface pr-2.5 pl-8 text-[13px] text-primary placeholder:text-faint hover:border-line-strong focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none"
              />
            </label>
          </div>
          <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto scroll-thin">
            {shown.map((r) => {
              const who = correspondent(r);
              const active = open?.id === r.id;
              return (
                <li key={r.id}>
                  <button type="button" onClick={() => setOpenId(r.id)} aria-current={active ? "true" : undefined} className={clsx("flex w-full gap-2.5 px-3 py-2.5 text-left", active ? "bg-accent-soft" : "hover:bg-sunken/60")}>
                    <Avatar name={who.name} size="md" className="mt-0.5" />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-primary">
                          {r.direction === "outbound" ? <span className="font-normal text-muted">To </span> : null}
                          {who.name}
                        </span>
                        <time className="shrink-0 text-[11.5px] text-faint tabular-nums" dateTime={r.sentAt} suppressHydrationWarning>
                          {formatAgo(r.sentAt, tz)}
                        </time>
                      </span>
                      {who.address && who.address !== who.name ? <span className="truncate text-[12px] text-muted">{who.address}</span> : null}
                      <span className="flex items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-secondary">{r.subject || "No subject"}</span>
                        <VisibilityBadge row={r} />
                      </span>
                      {r.snippet ? <span className="line-clamp-2 text-[12.5px] text-muted">{r.snippet}</span> : null}
                    </span>
                  </button>
                </li>
              );
            })}
            {!shown.length ? (
              <li>
                <EmptyState
                  variant="minimal"
                  icon={EnvelopeIcon}
                  title={term ? "Nothing matches" : rows.length ? "Nothing here" : "Nothing synced yet"}
                  description={term ? "Try a name, address or word from the subject." : rows.length ? "Pick another folder to see the rest." : "Mail with people in the CRM shows here once the sync has stored it: shared on their records, or private to you."}
                />
              </li>
            ) : null}
            {rows.length >= 100 && shown.length ? <li className="px-3 py-2.5 text-center text-fine">Showing the newest 100. Older mail is on each record&apos;s timeline.</li> : null}
          </ul>
        </div>

        <div
          className={clsx(
            "min-h-0 min-w-0 overflow-y-auto border-line scroll-thin lg:border-l",
            // Open, it sits beside the folders on a tablet and beside the list on a wide screen.
            !open && "hidden lg:block",
          )}
        >
          {open ? (
            <ReadingPane key={open.id} row={open} onBack={() => setOpenId(null)} onDelete={() => setRemoving(open)} />
          ) : (
            <EmptyState variant="minimal" icon={EnvelopeIcon} title="Pick an email" description="Share it with the team, keep it private to you, or delete it. It stays in your Outlook either way." className="h-full" />
          )}
        </div>
      </div>

      {removing ? (
        <DeleteDialog
          row={removing}
          onClose={(deleted) => {
            if (deleted && openId === removing.id) setOpenId(null);
            setRemoving(null);
          }}
        />
      ) : null}
    </div>
  );
}

function VisibilityBadge({ row }: { row: OutlookRow }) {
  return row.visibility === "private" ? <StatusBadge icon={<LockClosedIcon className="size-3" aria-hidden />}>Private</StatusBadge> : <StatusBadge tone="success">Shared</StatusBadge>;
}

/** The open email: its header, who it's with, where it's filed, the text, and what can be done with it. */
function ReadingPane({ row: r, onBack, onDelete }: { row: OutlookRow; onBack: () => void; onDelete: () => void }) {
  const { workspace, canEdit } = useApp();
  const [pending, start] = useTransition();
  const who = correspondent(r);
  const toggle = () =>
    start(async () => {
      const to = r.visibility === "private" ? "public" : "private";
      const res = await setSyncedEmailVisibility({ id: r.id, visibility: to });
      if (!res.ok) return void toast.error(res.error);
      toast.success(to === "public" ? "Shared with the team" : "Only you see this email now");
    });

  return (
    <article className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 border-b border-line bg-surface px-4 py-3 lg:px-6">
        <div className="flex flex-wrap items-start gap-2">
          <button type="button" onClick={onBack} className="-ml-1 rounded-md p-1 text-muted hover:bg-sunken hover:text-primary lg:hidden" aria-label="Back to the list">
            <ChevronLeftIcon className="size-5" />
          </button>
          {/* Wide enough to read; on a phone the actions drop below it. */}
          <div className="min-w-0 flex-1 basis-56">
            <h2 className="text-[16px] font-semibold break-words text-primary">{r.subject || "No subject"}</h2>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted">
              <VisibilityBadge row={r} />
              {r.record ? (
                <span>
                  On{" "}
                  <Link href={r.record.href} className="font-medium text-accent hover:underline">
                    {r.record.label}
                  </Link>
                  {r.visibility === "private" ? ", only for you" : ", for the team"}
                </span>
              ) : null}
            </p>
          </div>
          {canEdit ? (
            <div className="flex shrink-0 flex-wrap gap-1 max-sm:w-full max-sm:pl-8">
              <Button size="sm" variant="outline" disabled={pending} loading={pending} onClick={toggle}>
                {r.visibility === "private" ? <UserGroupIcon /> : <LockClosedIcon />}
                {r.visibility === "private" ? "Share with team" : "Make private"}
              </Button>
              <Button size="sm" variant="outline" onClick={onDelete} disabled={pending}>
                <TrashIcon />
                Delete
              </Button>
            </div>
          ) : null}
        </div>
      </header>

      <div className="flex flex-col gap-4 px-4 py-4 lg:px-6">
        <div className="flex gap-3">
          <Avatar name={r.direction === "inbound" ? who.name : "You"} size="lg" />
          <dl className="grid min-w-0 flex-1 grid-cols-[2.75rem_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[13px]">
            <dt className="text-muted">From</dt>
            <dd className="min-w-0 break-words text-primary">
              {r.direction === "inbound" ? (
                r.name ? (
                  <>
                    <span className="font-medium">{r.name} </span>
                    <span className="text-muted">&lt;{r.from}&gt;</span>
                  </>
                ) : (
                  <span className="font-medium">{r.from ?? "Unknown sender"}</span>
                )
              ) : (
                <span className="font-medium">You{r.from ? <span className="font-normal text-muted"> &lt;{r.from}&gt;</span> : null}</span>
              )}
            </dd>
            <dt className="text-muted">To</dt>
            <dd className="min-w-0 break-words text-secondary">{r.to.length ? r.to.join(", ") : "—"}</dd>
            <dt className="text-muted">Date</dt>
            <dd className="text-secondary tabular-nums">
              <time dateTime={r.sentAt} suppressHydrationWarning>
                {formatDateTime(r.sentAt, workspace.timezone)}
              </time>
            </dd>
          </dl>
        </div>
        {r.reason ? <p className="rounded-lg bg-sunken px-3 py-2 text-[12.5px] text-secondary">Kept private: {r.reason}</p> : null}
        {r.blocked ? (
          <p className="flex items-center gap-1.5 rounded-lg bg-sunken px-3 py-2 text-[12.5px] text-secondary">
            <NoSymbolIcon className="size-3.5 shrink-0 text-faint" aria-hidden />
            {r.from} is on your block list, so nothing more from them syncs.
          </p>
        ) : null}
        {r.body ? <div className="text-[13.5px] leading-relaxed break-words whitespace-pre-wrap text-primary">{r.body}</div> : <p className="text-[13px] text-muted">No text in this email.</p>}
      </div>
    </article>
  );
}

type DeleteChoice = "delete" | "address" | "domain";

/** Deleting an email, and maybe blocking whoever sent it, so nothing more from them is synced (promotions, newsletters). */
function DeleteDialog({ row, onClose }: { row: OutlookRow; onClose: (deleted: boolean) => void }) {
  const [choice, setChoice] = useState<DeleteChoice>("delete");
  const [pending, start] = useTransition();
  const block = row.blocked ? null : row.block;
  const options: { value: DeleteChoice; title: string; detail: string }[] = block
    ? [
        { value: "delete", title: "Just delete this email", detail: "Later emails from this sender still sync." },
        { value: "address", title: `Delete and block ${block.address}`, detail: "Nothing more from this address is synced." },
        ...(block.domain ? [{ value: "domain" as const, title: `Delete and block everyone at ${block.domain}`, detail: "For promotions and newsletters sent from many addresses." }] : []),
      ]
    : [];

  const confirm = () =>
    start(async () => {
      const r = row.activityId ? await deleteActivity(row.activityId) : await deletePrivateEmail(row.id);
      if (!r.ok) return void toast.error(r.error);
      const entry = choice === "address" ? block?.address : choice === "domain" ? block?.domain : null;
      if (entry) {
        const b = await blockMailSender({ entry });
        onClose(true);
        if (!b.ok) return void toast.error(`Email deleted, but ${entry} wasn't blocked: ${b.error}`);
        return void toast.success(`Email deleted. Mail with ${b.data.entry} won't sync anymore.`);
      }
      onClose(true);
      toast.success("Email deleted");
    });

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose(false)}
      title="Delete this email from the CRM?"
      description={row.subject || "No subject"}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onClose(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={confirm}>
            {choice === "delete" ? "Delete" : "Delete and block"}
          </Button>
        </>
      }
    >
      <p className="text-[13.5px] text-secondary">{row.visibility === "public" ? "It comes off every timeline for everyone and is never synced again." : "It's removed from the CRM and never synced again."} It stays in your Outlook.</p>
      {options.length ? (
        <fieldset className="mt-4 flex flex-col gap-2">
          <legend className="mb-2 text-[12px] font-medium tracking-wide text-muted uppercase">Block the sender?</legend>
          {options.map((o) => {
            const on = choice === o.value;
            return (
              <label key={o.value} className={clsx("flex cursor-pointer gap-3 rounded-lg border p-3 text-[13px]", on ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong")}>
                <input type="radio" name="delete-choice" className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]" checked={on} onChange={() => setChoice(o.value)} />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium break-words text-primary">{o.title}</span>
                  <span className="block text-[12px] text-muted">{o.detail}</span>
                </span>
              </label>
            );
          })}
          <p className="text-fine">
            Manage blocked senders in{" "}
            <Link href="/email/blocked" className="font-medium text-accent hover:underline">
              Email → Block list
            </Link>
            .
          </p>
        </fieldset>
      ) : null}
    </Dialog>
  );
}

/** What a sync did, in a sentence for the toast. */
export function syncSummary(r: { imported: number; private: number; withheld: number }) {
  if (!r.imported && !r.private && !r.withheld) return "Up to date";
  return `Synced: ${r.imported} shared, ${r.private} private, ${r.withheld} not stored`;
}
