"use client";

import clsx from "clsx";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { ArrowUpIcon, ChatBubbleLeftEllipsisIcon, ChevronLeftIcon, EllipsisHorizontalIcon, EnvelopeIcon, EnvelopeOpenIcon, ExclamationCircleIcon, MegaphoneIcon, PaperClipIcon, PencilSquareIcon } from "@heroicons/react/20/solid";
import { ChatBubbleLeftRightIcon } from "@heroicons/react/24/outline";
import { markTextThreadRead, openTextThread, replyToTextThread } from "@/actions/messages";
import { sendTextMessage } from "@/actions/phone";
import { useApp } from "@/components/app-context";
import { ReadNote } from "@/components/conversations/read-note";
import { RecordDetails } from "@/components/conversations/record-details";
import { RecordPicker, type PickerValue } from "@/components/records/record-picker";
import { PageHeader } from "@/components/shell/app-shell";
import { SearchBox } from "@/components/table/toolbar";
import { useListParams } from "@/components/table/use-params";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Select, Textarea } from "@/components/ui/field";
import { Menu, MenuContent, MenuItem, MenuTrigger, Tooltip } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import type { RecordContext } from "@/lib/conversations/record-context";
import { readStateFor, type ReadState } from "@/lib/conversations/read-rules";
import type { OpenTextThread, TextFilter, TextThreadRow } from "@/lib/conversations/texts";
import { dayKey, formatAgo, formatDay, formatFull, formatTime } from "@/lib/format";
import { formatPhone, smsSegments } from "@/lib/phone/numbers";

type Open = OpenTextThread & { readState: ReadState };
type Filters = { filter: TextFilter; q?: string };

const filterList: { value: TextFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
  { value: "mine", label: "My records" },
  { value: "unknown", label: "Not in the CRM" },
];

const nameOf = (t: { personName: string | null; organizationName: string | null; remote: string }) => t.personName ?? t.organizationName ?? formatPhone(t.remote);

/**
 * Text conversations, side by side like a chat app: every conversation on the
 * left (newest first, unread marked), the back and forth in the middle with a
 * composer, and who it's with on the right. Filters live in the URL.
 */
export function MessagesView({
  configured,
  isAdmin,
  threads,
  open,
  context,
  unread,
  filters,
}: {
  configured: boolean;
  isAdmin: boolean;
  threads: TextThreadRow[];
  open: Open | null;
  context: RecordContext | null;
  unread: number;
  filters: Filters;
}) {
  const { comms, canEdit } = useApp();
  const router = useRouter();
  const [composing, setComposing] = useState(false);

  // Nothing in the browser polls (the database sleeps between uses); coming back to the tab fetches what arrived.
  useEffect(() => {
    if (!configured) return;
    const onVisible = () => document.visibilityState === "visible" && router.refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [configured, router]);

  if (!configured)
    return (
      <>
        <PageHeader title="Messages" />
        <div className="p-4 lg:p-6">
          <EmptyState
            icon={ChatBubbleLeftRightIcon}
            title="Texting isn't set up yet"
            description={
              isAdmin
                ? "Connect a Twilio account and get a number in Settings → Phone numbers. Texts to and from it show up here, linked to each person."
                : "Ask an admin to connect Twilio and get the team a number. Texts will show up here."
            }
            action={
              isAdmin ? (
                <Button variant="primary" asChild>
                  <Link href="/settings/phone">Set up phone numbers</Link>
                </Button>
              ) : null
            }
          />
        </div>
      </>
    );

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col lg:h-dvh">
      <PageHeader title="Messages" sub={<p className="text-[12.5px] text-muted">{unread ? `${unread} unread for you` : "Nothing unread for you"}</p>}>
        {comms.texting && canEdit ? (
          <Button variant="primary" onClick={() => setComposing(true)}>
            <PencilSquareIcon />
            New message
          </Button>
        ) : null}
      </PageHeader>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[340px_minmax(0,1fr)] xl:grid-cols-[340px_minmax(0,1fr)_300px]">
        <ThreadList threads={threads} filters={filters} unread={unread} openId={open?.id ?? null} hidden={!!open} />
        <div className={clsx("min-h-0 min-w-0 flex-col border-line lg:flex lg:border-l", open ? "flex" : "hidden xl:col-span-2")}>
          {open ? (
            <Conversation key={open.id} thread={open} />
          ) : (
            <EmptyState variant="minimal" icon={ChatBubbleLeftRightIcon} title="Pick a conversation" description="Replies send from the number they texted and land on the person's timeline." className="h-full" />
          )}
        </div>
        {open ? (
          <aside aria-label="Who it's with" className="hidden min-h-0 overflow-y-auto border-l border-line bg-canvas scroll-thin xl:block">
            <RecordDetails context={context} unknown={{ phone: open.remote }} />
          </aside>
        ) : null}
      </div>
      {composing ? <NewMessage onClose={() => setComposing(false)} /> : null}
    </div>
  );
}

function ThreadList({ threads, filters, unread, openId, hidden }: { threads: TextThreadRow[]; filters: Filters; unread: number; openId: string | null; hidden: boolean }) {
  const { set } = useListParams();
  const showNumber = new Set(threads.map((t) => t.numberLabel)).size > 1;
  return (
    <div className={clsx("min-h-0 flex-col overflow-hidden", hidden ? "hidden lg:flex" : "flex")}>
      <div className="flex flex-col gap-2 border-b border-line p-2">
        <SearchBox placeholder="Search conversations" />
        <div className="flex flex-wrap gap-1" role="group" aria-label="Show">
          {filterList.map((f) => {
            const on = filters.filter === f.value;
            return (
              <button
                key={f.value}
                type="button"
                aria-pressed={on}
                onClick={() => set({ filter: f.value === "all" ? null : f.value, t: null })}
                className={clsx("flex h-7 items-center gap-1 rounded-full border px-2.5 text-[12.5px] font-medium", on ? "border-accent bg-accent text-accent-foreground" : "border-line text-secondary hover:border-line-strong")}
              >
                {f.label}
                {f.value === "unread" && unread ? <span className="tabular-nums">{unread}</span> : null}
              </button>
            );
          })}
        </div>
      </div>
      <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto scroll-thin">
        {threads.map((t) => (
          <ThreadItem key={t.id} thread={t} active={openId === t.id} showNumber={showNumber} />
        ))}
        {!threads.length ? (
          <li>
            <EmptyState
              variant="minimal"
              title={filters.q ? "Nothing matches" : filters.filter === "unread" ? "You're all caught up" : "No conversations yet"}
              description={
                filters.q
                  ? "Try a name, a number or words from a text."
                  : filters.filter === "unread"
                    ? "Nothing is unread for you. Texts with people someone else owns are unread for them."
                    : filters.filter === "mine"
                      ? "Nobody you own has texted, and you haven't texted them from here."
                      : filters.filter === "unknown"
                        ? "Every number that texted is on a person or organization."
                        : "Texts to and from the team's numbers show up here."
              }
            />
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function ThreadItem({ thread: t, active, showNumber }: { thread: TextThreadRow; active: boolean; showNumber: boolean }) {
  const { workspace, viewer, member } = useApp();
  const { set } = useListParams();
  const [, start] = useTransition();
  const name = nameOf(t);
  const state = readStateFor({ read: t.read, ownerId: t.ownerId }, viewer.id);
  const sentBy = t.latest?.direction === "outbound" ? (t.latest.userId === viewer.id ? "You" : (member(t.latest.userId)?.name.split(" ")[0] ?? "Team")) : null;
  const preview = t.latest ? `${sentBy ? `${sentBy}: ` : ""}${t.latest.body || (t.latest.media ? "Sent a picture or file" : "")}` : "Deleted from the record";
  const failed = t.latest?.direction === "outbound" && (t.latest.status === "failed" || t.latest.status === "undelivered");
  const mark = (read: boolean) =>
    start(async () => {
      const r = await markTextThreadRead(t.id, read);
      if (!r.ok) return void toast.error(r.error);
      toast.success(read ? "Marked read" : "Marked unread");
      // Left open, the conversation would read itself again: close it, as its header's Mark unread does.
      if (!read && active) set({ t: null });
    });
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={() => set({ t: t.id })}
        aria-current={active ? "true" : undefined}
        className={clsx("flex w-full gap-2.5 px-3 py-2.5 text-left", active ? "bg-accent-soft" : "hover:bg-sunken/60")}
      >
        <span className="relative mt-0.5">
          <Avatar name={t.personName ?? t.organizationName ?? "#"} size="md" />
          {state.unread ? <span className="absolute -top-0.5 -left-0.5 size-2.5 rounded-full border-2 border-surface bg-accent" aria-hidden /> : null}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2 pr-6">
            <span className={clsx("min-w-0 flex-1 truncate text-[13.5px]", state.unread ? "font-semibold text-primary" : "text-secondary")}>
              {name}
              {state.unread ? <span className="sr-only">, unread</span> : null}
            </span>
            {t.lastMessageAt ? (
              <time className={clsx("shrink-0 text-[11.5px]", state.unread ? "font-medium text-primary" : "text-faint")} dateTime={t.lastMessageAt} suppressHydrationWarning>
                {formatAgo(t.lastMessageAt, workspace.timezone)}
              </time>
            ) : null}
          </span>
          <span className={clsx("line-clamp-2 text-[12.5px]", state.unread ? "text-primary" : "text-muted")}>
            {failed ? <ExclamationCircleIcon className="mr-1 inline size-3.5 align-[-2px] text-error" aria-label="Didn't send" /> : null}
            {preview}
          </span>
          {t.personName && (t.organizationName || t.clientName) || showNumber ? (
            <span className="mt-0.5 flex min-w-0 flex-wrap gap-1">
              {t.clientName ? <span className="truncate rounded-sm bg-sunken px-1.5 py-0.5 text-[11px] font-medium text-secondary">{t.clientName}</span> : t.personName && t.organizationName ? <span className="truncate rounded-sm bg-sunken px-1.5 py-0.5 text-[11px] font-medium text-secondary">{t.organizationName}</span> : null}
              {showNumber && t.numberLabel ? <span className="truncate rounded-sm border border-line px-1.5 py-0.5 text-[11px] text-muted">{t.numberLabel}</span> : null}
            </span>
          ) : null}
        </span>
      </button>
      {state.canChange ? (
        <div className="absolute top-2 right-2 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 has-[[data-state=open]]:opacity-100">
          <Menu>
            <MenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`More for ${name}`}>
                <EllipsisHorizontalIcon />
              </Button>
            </MenuTrigger>
            <MenuContent align="end" className="w-44">
              {t.read ? (
                <MenuItem icon={<EnvelopeIcon />} onSelect={() => mark(false)}>
                  Mark unread
                </MenuItem>
              ) : (
                <MenuItem icon={<EnvelopeOpenIcon />} onSelect={() => mark(true)}>
                  Mark read
                </MenuItem>
              )}
            </MenuContent>
          </Menu>
        </div>
      ) : null}
    </li>
  );
}

const statusLabel: Partial<Record<string, string>> = { queued: "Sending", sending: "Sending", sent: "Sent", delivered: "Delivered", undelivered: "Not delivered", failed: "Didn't send" };

function Conversation({ thread }: { thread: Open }) {
  const { workspace, member, comms, canEdit } = useApp();
  const { set } = useListParams();
  const tz = workspace.timezone;
  const [pending, start] = useTransition();
  const [body, setBody] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const name = nameOf(thread);

  // Opening it: read now if it's this teammate's to read, and a number since added to the CRM moves onto its record.
  const unlinked = !thread.personId && !thread.organizationId;
  // Unread for this teammate to read. A reply arriving while it's open turns this back on, so the effect runs again.
  const needsRead = !thread.read && thread.readState.canChange;
  // A number nobody had is checked against the CRM once per opening, not on every refresh.
  const checkedLinks = useRef(false);
  useEffect(() => {
    const checkLinks = unlinked && !checkedLinks.current;
    if (!needsRead && !checkLinks) return;
    if (checkLinks) checkedLinks.current = true;
    void openTextThread(thread.id);
  }, [thread.id, needsRead, unlinked]);

  const count = thread.messages.length;
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [count]);

  const mark = (read: boolean) =>
    start(async () => {
      const r = await markTextThreadRead(thread.id, read);
      if (!r.ok) return void toast.error(r.error);
      toast.success(read ? "Marked read" : "Marked unread");
      if (!read) set({ t: null });
    });

  const send = () =>
    start(async () => {
      if (!body.trim()) return;
      const r = await replyToTextThread(thread.id, { body });
      if (!r.ok) return void toast.error(r.error);
      setBody("");
    });

  const usable = thread.number && comms.numbers.some((n) => n.id === thread.number!.id);
  const blocked = !canEdit
    ? "Your role can read conversations but not text. Ask an admin for edit access."
    : !thread.number
      ? "The number this conversation was on was deleted. Text them from their record with another number."
      : !usable
        ? `You don't have access to ${thread.number.label}. Ask an admin to add you in Settings → Phone numbers.`
        : thread.optedOut
          ? `${name} replied STOP, so texts to them are blocked. They can reply START to opt back in.`
          : null;
  const segments = smsSegments(body);

  return (
    <>
      <header className="flex items-start gap-2.5 border-b border-line bg-surface px-4 py-3 lg:px-5">
        <button type="button" onClick={() => set({ t: null })} className="-ml-1 rounded-md p-1 text-muted hover:bg-sunken hover:text-primary lg:hidden" aria-label="Back to conversations">
          <ChevronLeftIcon className="size-5" />
        </button>
        <Avatar name={thread.personName ?? thread.organizationName ?? "#"} size="md" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold text-primary">
            {thread.personId ? (
              <Link href={`/people/${thread.personId}`} className="hover:underline">
                {name}
              </Link>
            ) : thread.organizationId ? (
              <Link href={`/organizations/${thread.organizationId}`} className="hover:underline">
                {name}
              </Link>
            ) : (
              name
            )}
          </h2>
          <p className="truncate text-[12.5px] text-muted">
            {[
              thread.personName || thread.organizationName ? formatPhone(thread.remote) : null,
              thread.number ? `On ${thread.number.label}, ${formatPhone(thread.number.number)}` : "On a deleted number",
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <ReadNote state={thread.readState} read={thread.read} />
        </div>
        {thread.readState.canChange ? (
          <Tooltip content={thread.read ? "Mark unread" : "Mark read"}>
            <Button variant="ghost" size="icon-sm" onClick={() => mark(!thread.read)} disabled={pending} aria-label={thread.read ? "Mark unread" : "Mark read"}>
              {thread.read ? <EnvelopeIcon /> : <EnvelopeOpenIcon />}
            </Button>
          </Tooltip>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-canvas px-4 py-4 scroll-thin lg:px-5">
        <ol className="mx-auto flex max-w-3xl flex-col gap-1.5">
          {thread.messages.map((m, i) => {
            // A day divider before the first text of each day.
            const prev = thread.messages[i - 1];
            const divider = !prev || dayKey(prev.createdAt, tz) !== dayKey(m.createdAt, tz);
            const out = m.direction === "outbound";
            const campaign = !!m.campaignId;
            // Teammates are credited by name under every text they sent; campaign texts go to whoever created the campaign.
            const author = out ? member(m.userId) : undefined;
            const sender = out ? (author?.name ?? "A teammate") : (thread.personName ?? thread.organizationName ?? formatPhone(thread.remote));
            const failed = m.status === "failed" || m.status === "undelivered";
            return (
              <li key={m.id} className="flex flex-col">
                {divider ? (
                  <p className="my-3 text-center text-[11.5px] font-medium text-faint" suppressHydrationWarning>
                    {formatDay(m.createdAt, tz)}
                  </p>
                ) : null}
                <div className={clsx("flex max-w-[85%]", out ? "self-end" : "self-start")}>
                  <div className={clsx("flex min-w-0 flex-col", out ? "items-end" : "items-start")}>
                    {campaign ? (
                      <span className="mb-0.5 flex items-center gap-1 text-[11px] font-medium text-secondary">
                        <MegaphoneIcon className="size-3.5 text-faint" aria-hidden />
                        Campaign{m.campaignName ? `: ${m.campaignName}` : ""}
                      </span>
                    ) : null}
                    <div
                      className={clsx(
                        "rounded-2xl px-3.5 py-2 text-[13.5px] leading-relaxed break-words whitespace-pre-wrap",
                        m.deleted
                          ? "border border-dashed border-line bg-transparent text-muted italic"
                          : out
                            ? failed
                              ? "border border-error-border bg-error-surface text-primary"
                              : campaign
                                ? "border border-dashed border-line-strong bg-accent-soft text-accent-soft-foreground"
                                : "bg-accent text-accent-foreground"
                            : "border border-line bg-surface text-primary",
                        out ? "rounded-br-md" : "rounded-bl-md",
                      )}
                    >
                      {m.deleted ? "Deleted from the record" : m.body}
                      {m.media.length ? (
                        <span className={clsx("flex items-center gap-1 text-[12px]", m.body ? "mt-1" : "", out ? "opacity-80" : "text-muted")}>
                          <PaperClipIcon className="size-3.5" aria-hidden />
                          {m.media.length === 1 ? "A picture or file" : `${m.media.length} pictures or files`} (open them in Twilio)
                        </span>
                      ) : null}
                    </div>
                    <Tooltip content={formatFull(m.createdAt, tz)}>
                      <span className="mt-0.5 flex items-center gap-1 text-[11px] text-faint" suppressHydrationWarning>
                        {out ? `${campaign ? `Campaign by ${sender}` : sender} · ` : ""}
                        {formatTime(m.createdAt, tz)}
                        {out && statusLabel[m.status] ? <span className={failed ? "text-error" : undefined}>· {statusLabel[m.status]}</span> : null}
                      </span>
                    </Tooltip>
                    {out && failed && m.error ? <p className="mt-0.5 max-w-full text-right text-[11.5px] text-error">{m.error}</p> : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
        <div ref={end} />
      </div>

      {/* Room on the right for the assistant's button, which sits over this corner until the details column takes it. */}
      <div className="border-t border-line bg-surface py-3 pr-[5.5rem] pl-4 lg:pl-5 xl:pr-5">
        {blocked ? (
          <p className="flex items-center gap-1.5 text-[13px] text-muted">
            <ChatBubbleLeftEllipsisIcon className="size-4 text-faint" aria-hidden />
            {blocked}
          </p>
        ) : (
          <>
            <div className="flex items-end gap-2">
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    if (!pending) send();
                  }
                }}
                rows={2}
                maxLength={1600}
                placeholder={`Text ${name.split(" ")[0]}`}
                aria-label={`Text ${name}`}
                className="min-h-11 flex-1 resize-none"
              />
              <Button variant="primary" size="icon" loading={pending} disabled={!body.trim()} onClick={send} aria-label="Send text">
                {!pending ? <ArrowUpIcon /> : null}
              </Button>
            </div>
            <p className="mt-1.5 flex flex-wrap gap-x-2 text-[11.5px] text-faint">
              <span>
                From {thread.number!.label} · Enter sends, Shift+Enter adds a line
              </span>
              {body.length ? (
                <span className="ml-auto tabular-nums">
                  {body.length} characters · {segments} {segments === 1 ? "message" : "messages"}
                </span>
              ) : null}
            </p>
          </>
        )}
      </div>
    </>
  );
}

/** A text to someone in the CRM, from the Messages page. Opens the conversation once it's sent. */
function NewMessage({ onClose }: { onClose: () => void }) {
  const { comms } = useApp();
  const { set } = useListParams();
  const [person, setPerson] = useState<PickerValue>(null);
  const [numberId, setNumberId] = useState(comms.defaultNumberId ?? comms.numbers[0]?.id ?? "");
  const [body, setBody] = useState("");
  const [pending, start] = useTransition();
  const personId = person && "record" in person ? person.record.id : null;
  const send = () =>
    start(async () => {
      if (!personId) return void toast.error("Pick who to text.");
      const r = await sendTextMessage({ phoneNumberId: numberId, personId, body });
      if (!r.ok) return void toast.error(r.error);
      toast.success("Text sent");
      onClose();
      if (r.data.threadId) set({ t: r.data.threadId, filter: null, q: null });
    });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New message"
      description="Texts a person from one of the team's numbers. Their replies come back here and to their timeline."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} disabled={!personId || !body.trim()} onClick={send}>
            Send text
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="To">{(p) => <RecordPicker id={p.id} kind="person" value={person} onChange={setPerson} allowCreate={false} placeholder="Find a person" autoFocus />}</Field>
        {comms.numbers.length > 1 ? (
          <Field label="From">
            {(p) => (
              <Select id={p.id} value={numberId} onChange={(e) => setNumberId(e.target.value)}>
                {comms.numbers.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.label} · {formatPhone(n.number)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        <Field label="Message">{(p) => <Textarea {...p} value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={1600} />}</Field>
      </div>
    </Dialog>
  );
}
