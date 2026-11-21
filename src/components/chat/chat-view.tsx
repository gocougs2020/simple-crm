"use client";

import clsx from "clsx";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from "react";
import { ArrowUpIcon, PaperClipIcon, PencilSquareIcon, TrashIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { ChatBubbleOvalLeftEllipsisIcon } from "@heroicons/react/24/outline";
import { deleteChatMessage, editChatMessage, loadChatChanges, loadEarlierChat, markChatRead, postChatMessage } from "@/actions/chat";
import { useApp } from "@/components/app-context";
import { FileIcon } from "@/components/files/files-panel";
import { uploadFile } from "@/components/files/upload";
import { adoptVersions, MOVED_EVENT } from "@/components/live-updates";
import { setBadges } from "@/components/shell/badge-store";
import { PageHeader } from "@/components/shell/app-shell";
import { Avatar } from "@/components/ui/avatar";
import { Button, Spinner } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Kbd } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import type { TeamMember } from "@/lib/crm/context";
import type { ChatMessage } from "@/lib/chat/service";
import { chatSegments, MAX_CHAT_FILES, MAX_CHAT_LENGTH, mentionQuery } from "@/lib/chat/format";
import { dayKey, formatBytes, formatDay, formatFull, formatTime } from "@/lib/format";

/** Messages from the same person this close together read as one block. */
const GROUP_MS = 5 * 60_000;

/** Fetch what changed in the chat now (after posting, editing or deleting here). */
const pullChat = () => window.dispatchEvent(new CustomEvent(MOVED_EVENT, { detail: { scopes: ["chat"] } }));

/**
 * The team chat: one thread for the whole company. New, edited and deleted
 * messages arrive on their own: src/components/live-updates.tsx asks often
 * while this page is open, and when the chat moved this fetches only what
 * changed since `version` (no page refresh). Scrolling to the top loads earlier ones.
 */
export function ChatView({ latest, hasMore, version }: { latest: ChatMessage[]; hasMore: boolean; version: string }) {
  const { team, viewer } = useApp();
  const [older, setOlder] = useState<ChatMessage[]>([]);
  // What changed since the page rendered: a message by id, or null once deleted.
  const [changed, setChanged] = useState<{ from: ChatMessage[]; map: Map<string, ChatMessage | null> }>({ from: latest, map: new Map() });
  const since = useRef({ from: latest, version });
  const [moreBefore, setMoreBefore] = useState(hasMore);
  const [loadingOlder, startOlder] = useTransition();
  const [highlight, setHighlight] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const keepFrom = useRef<number | null>(null);

  const messages = useMemo(() => {
    const byId = new Map<string, ChatMessage>();
    for (const m of [...older, ...latest]) byId.set(m.id, m);
    // Changes fetched since this render: edits and deletes to what's shown, and new messages.
    if (changed.from === latest) {
      const earliest = byId.size ? Math.min(...[...byId.values()].map((m) => new Date(m.createdAt).getTime())) : -Infinity;
      for (const [id, m] of changed.map) {
        if (!m) byId.delete(id);
        // An edit to a message further back than what's loaded stays there until it's scrolled to.
        else if (byId.has(id) || new Date(m.createdAt).getTime() >= earliest) byId.set(id, m);
      }
    }
    return [...byId.values()].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }, [older, latest, changed]);
  const newest = messages.at(-1)?.id;

  // When the chat moved (someone posted, edited or deleted), fetch only what changed.
  useEffect(() => {
    if (since.current.from !== latest) since.current = { from: latest, version };
    let busy = false;
    let again = false;
    let ended = false;
    let retry = 0;
    const pull = async () => {
      if (ended) return;
      if (busy) return void (again = true);
      busy = true;
      try {
        const from = since.current.from;
        const r = await loadChatChanges(since.current.version);
        if (since.current.from !== from) return;
        // The chat counts as caught up only once its changes are here: a failed read tries again shortly,
        // and a backlog bigger than one read keeps reading.
        if (!r.ok) {
          window.clearTimeout(retry);
          retry = window.setTimeout(() => void pull(), 5_000);
          return;
        }
        since.current.version = r.data.version;
        adoptVersions({ chat: r.data.version });
        if (r.data.more) again = true;
        if (!r.data.changes.length) return;
        setChanged((c) => {
          const map = new Map(c.from === from ? c.map : []);
          for (const m of r.data.changes) map.set(m.id, m.deleted ? null : { id: m.id, userId: m.userId, body: m.body, mentions: m.mentions, createdAt: m.createdAt, editedAt: m.editedAt, files: m.files });
          return { from, map };
        });
      } finally {
        busy = false;
        if (again) {
          again = false;
          void pull();
        }
      }
    };
    const onMoved = (e: Event) => {
      if ((e as CustomEvent<{ scopes: string[] }>).detail?.scopes.includes("chat")) void pull();
    };
    window.addEventListener(MOVED_EVENT, onMoved);
    return () => {
      ended = true;
      window.clearTimeout(retry);
      window.removeEventListener(MOVED_EVENT, onMoved);
    };
  }, [latest, version]);

  // Stay at the bottom as messages arrive, unless the viewer scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (keepFrom.current !== null) {
      el.scrollTop = el.scrollHeight - keepFrom.current;
      keepFrom.current = null;
    } else if (atBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, newest]);

  // Pictures load after the first scroll and push the newest message down: keep up with them while at the bottom.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onLoad = (e: Event) => {
      if (e.target instanceof HTMLImageElement && atBottom.current) el.scrollTop = el.scrollHeight;
    };
    el.addEventListener("load", onLoad, true);
    return () => el.removeEventListener("load", onLoad, true);
  }, []);

  // Seen it: clear the sidebar count when a new message shows while the tab is in view.
  useEffect(() => {
    const mark = () => {
      if (document.visibilityState !== "visible") return;
      // The sidebar's count clears from the badges this returns, without re-rendering the page.
      void markChatRead().then((r) => r.ok && setBadges(r.data));
    };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [newest]);

  // A notification links to one message: scroll to it and mark it for a moment.
  useEffect(() => {
    const id = window.location.hash.match(/^#m-([\w-]+)$/)?.[1];
    if (!id) return;
    const el = document.getElementById(`m-${id}`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    atBottom.current = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time highlight of the linked message
    setHighlight(id);
    const t = setTimeout(() => setHighlight(null), 2500);
    return () => clearTimeout(t);
  }, []);

  const loadOlder = () => {
    const first = messages[0];
    if (!first || loadingOlder) return;
    startOlder(async () => {
      const r = await loadEarlierChat(first.id);
      if (!r.ok) return void toast.error(r.error);
      const el = scroller.current;
      if (el) keepFrom.current = el.scrollHeight - el.scrollTop;
      setOlder((o) => [...r.data.messages, ...o]);
      setMoreBefore(r.data.hasMore);
    });
  };

  return (
    <div className="flex h-app flex-col">
      <PageHeader title="Team chat" sub={<p className="mt-0.5 text-[12.5px] text-muted">One conversation for everyone on the team. Type @ to mention someone.</p>} />
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto scroll-thin"
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          if (el.scrollTop < 200 && moreBefore && !loadingOlder) loadOlder();
        }}
      >
        <div className="mx-auto flex min-h-full max-w-4xl flex-col justify-end px-4 py-4 lg:px-6">
          {moreBefore ? (
            <div className="flex justify-center pb-3">
              <Button size="sm" variant="ghost" onClick={loadOlder} loading={loadingOlder}>
                Load earlier messages
              </Button>
            </div>
          ) : messages.length ? (
            <p className="pb-4 text-center text-fine">This is the start of the team chat.</p>
          ) : null}
          {messages.length ? (
            <MessageList messages={messages} team={team} viewerId={viewer.id} highlight={highlight} />
          ) : (
            <EmptyState icon={ChatBubbleOvalLeftEllipsisIcon} title="No messages yet" description="Say hello to the team. Everyone who can sign in sees this chat, and @ mentions send a notification." variant="subtle" />
          )}
        </div>
      </div>
      <Composer
        onPosted={() => {
          atBottom.current = true;
        }}
      />
    </div>
  );
}

function MessageList({ messages, team, viewerId, highlight }: { messages: ChatMessage[]; team: TeamMember[]; viewerId: string; highlight: string | null }) {
  const { workspace } = useApp();
  const tz = workspace.timezone;
  return (
    <ol className="flex flex-col" aria-label="Messages">
      {messages.map((m, i) => {
        const prev = messages[i - 1];
        const newDay = !prev || dayKey(prev.createdAt, tz) !== dayKey(m.createdAt, tz);
        const grouped = !newDay && prev.userId === m.userId && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_MS;
        return (
          <Fragment key={m.id}>
            {newDay ? (
              <li className="flex items-center gap-3 py-2" aria-hidden>
                <span className="h-px flex-1 bg-line" />
                <span className="rounded-full border border-line bg-background px-2.5 py-0.5 text-[11.5px] font-medium text-muted" suppressHydrationWarning>
                  {formatDay(m.createdAt, tz)}
                </span>
                <span className="h-px flex-1 bg-line" />
              </li>
            ) : null}
            <Message message={m} grouped={grouped} team={team} mine={m.userId === viewerId} mentionsMe={m.mentions.includes(viewerId)} highlight={highlight === m.id} />
          </Fragment>
        );
      })}
    </ol>
  );
}

function Message({ message: m, grouped, team, mine, mentionsMe, highlight }: { message: ChatMessage; grouped: boolean; team: TeamMember[]; mine: boolean; mentionsMe: boolean; highlight: boolean }) {
  const { member, workspace, isAdmin, viewer } = useApp();
  const tz = workspace.timezone;
  const author = member(m.userId);
  const name = author?.name ?? "Former teammate";
  const [editing, setEditing] = useState(false);
  const [pending, start] = useTransition();
  const segments = useMemo(() => chatSegments(m.body, team), [m.body, team]);
  const pictures = m.files.filter((f) => /^image\/(png|jpe?g|gif|webp|avif)$/i.test(f.contentType));
  const others = m.files.filter((f) => !pictures.includes(f));

  return (
    <li
      id={`m-${m.id}`}
      className={clsx(
        "group relative -mx-2 flex gap-3 rounded-lg px-2 transition-colors hover:bg-sunken/60",
        grouped ? "py-0.5" : "mt-2 pt-1.5 pb-0.5",
        mentionsMe && "bg-warning-surface/60 shadow-[inset_2px_0_0_var(--warning)]",
        highlight && "bg-accent-soft",
      )}
    >
      <div className="w-8 shrink-0">
        {grouped ? (
          <time dateTime={new Date(m.createdAt).toISOString()} title={formatFull(m.createdAt, tz)} className="invisible block pt-0.5 text-right text-[10.5px] text-faint tabular-nums group-hover:visible" suppressHydrationWarning>
            {formatTime(m.createdAt, tz).replace(/\s?[AP]M$/, "")}
          </time>
        ) : (
          <Avatar name={name} size="md" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped ? (
          <p className="flex items-baseline gap-2">
            <span className="text-[13.5px] font-semibold text-primary">{name}</span>
            <time dateTime={new Date(m.createdAt).toISOString()} title={formatFull(m.createdAt, tz)} className="text-[11.5px] text-faint" suppressHydrationWarning>
              {formatTime(m.createdAt, tz)}
            </time>
          </p>
        ) : null}
        {editing ? (
          <EditBox
            initial={m.body}
            pending={pending}
            onCancel={() => setEditing(false)}
            onSave={(body) =>
              start(async () => {
                const r = await editChatMessage(m.id, body);
                if (!r.ok) return void toast.error(r.error);
                setEditing(false);
                pullChat();
              })
            }
          />
        ) : m.body ? (
          <p className="text-[14px] leading-6 break-words whitespace-pre-wrap text-primary">
            {segments.map((s, i) =>
              s.kind === "mention" ? (
                <span key={i} className={clsx("rounded px-0.5 font-medium", s.userId === viewer.id ? "bg-warning-surface text-warning" : "bg-accent-soft text-accent-soft-foreground")}>
                  {s.text}
                </span>
              ) : s.kind === "link" ? (
                <a key={i} href={s.href} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2 hover:text-accent-hover">
                  {s.text}
                </a>
              ) : (
                <Fragment key={i}>{s.text}</Fragment>
              ),
            )}
            {m.editedAt ? (
              <span className="ml-1 text-[11.5px] text-faint" title={`Edited ${formatFull(m.editedAt, tz)}`} suppressHydrationWarning>
                (edited)
              </span>
            ) : null}
          </p>
        ) : null}
        {pictures.length ? (
          <ul className="mt-1.5 flex flex-wrap gap-2" aria-label="Pictures">
            {pictures.map((f) => (
              <li key={f.id}>
                <a href={`/api/files/${f.id}`} target="_blank" rel="noopener" className="block overflow-hidden rounded-lg border border-line bg-sunken hover:border-line-strong">
                  {/* eslint-disable-next-line @next/next/no-img-element -- private files behind the session; the image optimizer can't fetch them */}
                  <img src={`/api/files/${f.id}`} alt={f.name} loading="lazy" className="max-h-56 max-w-72 object-contain" />
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        {others.length ? (
          <ul className="mt-1.5 flex flex-wrap gap-2" aria-label="Attachments">
            {others.map((f) => (
              <li key={f.id}>
                <a href={`/api/files/${f.id}`} target="_blank" rel="noopener" className="flex h-11 max-w-72 items-center gap-2 rounded-lg border border-line bg-surface px-3 hover:border-line-strong">
                  <FileIcon type={f.contentType} className="size-5" />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium text-primary">{f.name}</span>
                    <span className="block text-[11.5px] text-muted">{formatBytes(f.size)}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {!editing && (mine || isAdmin) ? (
        <div className="absolute -top-3 right-2 hidden items-center rounded-md border border-line bg-surface shadow-sm group-focus-within:flex group-hover:flex">
          {mine ? (
            <button type="button" onClick={() => setEditing(true)} className="rounded-l-md p-1.5 text-faint hover:bg-sunken hover:text-primary" aria-label="Edit message">
              <PencilSquareIcon className="size-4" />
            </button>
          ) : null}
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              if (!confirm(m.files.length ? "Delete this message and its files? Files someone put in a folder or attached to a record stay in Files." : "Delete this message?")) return;
              start(async () => {
                const r = await deleteChatMessage(m.id);
                if (!r.ok) toast.error(r.error);
                else pullChat();
              });
            }}
            className={clsx("p-1.5 text-faint hover:bg-sunken hover:text-error", mine ? "rounded-r-md" : "rounded-md")}
            aria-label="Delete message"
          >
            <TrashIcon className="size-4" />
          </button>
        </div>
      ) : null}
    </li>
  );
}

function EditBox({ initial, pending, onSave, onCancel }: { initial: string; pending: boolean; onSave: (body: string) => void; onCancel: () => void }) {
  const [body, setBody] = useState(initial);
  return (
    <div className="mt-1">
      <MentionTextarea value={body} onChange={setBody} onSubmit={() => onSave(body)} onEscape={onCancel} autoFocus label="Edit message" />
      <div className="mt-1.5 flex items-center gap-2">
        <Button size="sm" variant="primary" loading={pending} onClick={() => onSave(body)}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <span className="text-fine">
          <Kbd>Enter</Kbd> saves, <Kbd>Esc</Kbd> cancels
        </span>
      </div>
    </div>
  );
}

type Pending = { key: string; name: string; pct: number; id?: string; failed?: boolean };

function Composer({ onPosted }: { onPosted: () => void }) {
  // Viewers can post, but not attach files.
  const { services, canEdit } = useApp();
  const [body, setBody] = useState("");
  const [attached, setAttached] = useState<Pending[]>([]);
  const [over, setOver] = useState(false);
  const [sending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  const uploading = attached.some((a) => !a.id && !a.failed);
  const ready = attached.filter((a) => a.id);

  const attach = async (list: FileList | File[]) => {
    const picked = [...list].slice(0, Math.max(0, MAX_CHAT_FILES - attached.length));
    if (list.length > picked.length) toast.error(`Attach ${MAX_CHAT_FILES} files at most to one message.`);
    const rows = picked.map((f) => ({ key: `${f.name}:${f.size}:${Math.random()}`, name: f.name, pct: 0 }));
    setAttached((a) => [...a, ...rows]);
    await Promise.all(
      picked.map(async (f, i) => {
        const key = rows[i].key;
        try {
          const id = await uploadFile(f, { origin: "chat" }, services.blob, (pct) => setAttached((a) => a.map((x) => (x.key === key ? { ...x, pct } : x))));
          setAttached((a) => a.map((x) => (x.key === key ? { ...x, id, pct: 100 } : x)));
        } catch (err) {
          toast.error((err as Error).message);
          setAttached((a) => a.filter((x) => x.key !== key));
        }
      }),
    );
  };

  const send = () => {
    if (sending || uploading || (!body.trim() && !ready.length)) return;
    start(async () => {
      const r = await postChatMessage({ body, fileIds: ready.map((a) => a.id!) });
      if (!r.ok) return void toast.error(r.error);
      setBody("");
      setAttached([]);
      onPosted();
      pullChat();
    });
  };

  return (
    <div
      className={clsx("border-t border-line bg-background px-4 pt-3 pb-3 lg:px-6 lg:pb-[max(0.75rem,env(safe-area-inset-bottom))]", over && "bg-accent-soft")}
      onDragOver={(e) => {
        if (!canEdit || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (!canEdit || !e.dataTransfer.files.length) return;
        e.preventDefault();
        void attach(e.dataTransfer.files);
      }}
    >
      {/* Room on the right for the agent's button, which sits in the bottom corner. */}
      <div className="mx-auto max-w-4xl pr-[4.25rem]">
        <div className="rounded-xl border border-line bg-surface shadow-sm focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
          {attached.length ? (
            <ul className="flex flex-wrap gap-1.5 border-b border-line px-3 py-2" aria-label="Attached files">
              {attached.map((a) => (
                <li key={a.key} className="inline-flex h-7 max-w-64 items-center gap-1.5 rounded-full border border-line bg-sunken pr-1 pl-2.5 text-[12px] text-secondary">
                  {a.id ? <PaperClipIcon className="size-3.5 shrink-0 text-faint" aria-hidden /> : <Spinner className="size-3.5 shrink-0 text-faint" />}
                  <span className="truncate">{a.name}</span>
                  {!a.id ? <span className="text-faint tabular-nums">{a.pct}%</span> : null}
                  <button type="button" onClick={() => setAttached((x) => x.filter((y) => y.key !== a.key))} className="rounded-full p-0.5 text-faint hover:bg-surface hover:text-primary" aria-label={`Remove ${a.name}`}>
                    <XMarkIcon className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex items-end gap-1 p-1.5">
            {canEdit ? (
              <>
                <input ref={input} type="file" multiple hidden onChange={(e) => e.target.files && attach(e.target.files).then(() => (e.target.value = ""))} />
                <button type="button" onClick={() => input.current?.click()} className="rounded-md p-2 text-faint hover:bg-sunken hover:text-primary" aria-label="Attach files">
                  <PaperClipIcon className="size-5" />
                </button>
              </>
            ) : (
              <span className="w-2" />
            )}
            <div className="min-w-0 flex-1">
              <MentionTextarea value={body} onChange={setBody} onSubmit={send} onPasteFiles={canEdit ? attach : undefined} placeholder="Message the team" label="Message" bare />
            </div>
            <Button variant="primary" size="icon-sm" onClick={send} disabled={uploading || (!body.trim() && !ready.length)} loading={sending} aria-label="Send">
              <ArrowUpIcon />
            </Button>
          </div>
        </div>
        <p className="mt-1.5 hidden text-fine sm:block">
          <Kbd>Enter</Kbd> sends, <Kbd>Shift</Kbd> + <Kbd>Enter</Kbd> adds a line.{canEdit ? " Drop or paste files to attach them." : ""}
        </p>
      </div>
    </div>
  );
}

/**
 * A growing textarea with an @ mention picker: typing "@" lists teammates,
 * arrows pick, Enter or Tab puts their name in.
 */
function MentionTextarea({
  value,
  onChange,
  onSubmit,
  onEscape,
  onPasteFiles,
  placeholder,
  label,
  autoFocus,
  bare,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onEscape?: () => void;
  onPasteFiles?: (files: File[]) => void;
  placeholder?: string;
  label: string;
  autoFocus?: boolean;
  bare?: boolean;
}) {
  const { team, viewer } = useApp();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const q = mentionQuery(value, cursor);
  const people = useMemo(() => {
    if (!q) return [];
    const term = q.query.toLowerCase();
    return team
      .filter((m) => m.active && m.id !== viewer.id)
      .filter((m) => !term || m.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(term)) || m.name.toLowerCase().startsWith(term))
      .slice(0, 6);
  }, [q, team, viewer.id]);
  const open = !!q && people.length > 0 && dismissed !== q.start;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [value]);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const pick = (m: TeamMember) => {
    if (!q) return;
    // The full name when a first name is shared on the team, so it's clear who's meant.
    const first = m.name.split(/\s+/)[0];
    const shared = team.filter((t) => t.active && t.name.split(/\s+/)[0].toLowerCase() === first.toLowerCase()).length > 1;
    const insert = `@${shared ? m.name : first} `;
    const next = value.slice(0, q.start) + insert + value.slice(cursor);
    onChange(next);
    const at = q.start + insert.length;
    setCursor(at);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(at, at);
    });
  };

  return (
    <div className="relative">
      <textarea
        ref={ref}
        rows={1}
        value={value}
        maxLength={MAX_CHAT_LENGTH}
        aria-label={label}
        placeholder={placeholder}
        aria-autocomplete="list"
        onChange={(e) => {
          onChange(e.target.value);
          setCursor(e.target.selectionStart);
          setActive(0);
        }}
        onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
        onPaste={(e) => {
          if (!onPasteFiles || !e.clipboardData.files.length) return;
          e.preventDefault();
          onPasteFiles([...e.clipboardData.files]);
        }}
        onKeyDown={(e) => {
          if (open) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => (a + (e.key === "ArrowDown" ? 1 : people.length - 1)) % people.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              pick(people[active] ?? people[0]);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setDismissed(q!.start);
              return;
            }
          }
          if (e.key === "Escape" && onEscape) {
            e.preventDefault();
            onEscape();
          } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSubmit();
          }
        }}
        className={clsx(
          "block w-full resize-none bg-transparent text-[14px] leading-6 text-primary placeholder:text-faint focus:outline-none",
          bare ? "px-1.5 py-1" : "rounded-md border border-line bg-surface px-3 py-1.5 shadow-sm focus:border-ring focus:ring-1 focus:ring-ring",
        )}
      />
      {open ? (
        <ul role="listbox" aria-label="Mention a teammate" className="absolute bottom-full left-0 z-30 mb-2 w-64 animate-pop-in rounded-lg border border-line bg-surface p-1 shadow-md">
          {people.map((m, i) => (
            <li
              key={m.id}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(m)}
              onMouseMove={() => setActive(i)}
              className={clsx("flex h-9 cursor-default items-center gap-2 rounded-md px-2 text-[13.5px]", i === active ? "bg-sunken text-primary" : "text-secondary")}
            >
              <Avatar name={m.name} size="xs" />
              <span className="truncate">{m.name}</span>
              {m.title ? <span className="truncate text-[12px] text-muted">{m.title}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
