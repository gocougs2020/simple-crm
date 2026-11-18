"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses, type Experimental_RealtimeSessionConfig, type UIMessage } from "ai";
import clsx from "clsx";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  ArrowUpIcon,
  BeakerIcon,
  CheckIcon,
  ChevronDownIcon,
  ClipboardDocumentIcon,
  HandThumbDownIcon,
  HandThumbUpIcon,
  MinusIcon,
  PencilIcon,
  PencilSquareIcon,
  SparklesIcon,
  SpeakerWaveIcon,
  StopIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { deleteAgentThread, listAgentThreads, loadAgentThread, rateAgentMessage, saveVoiceTranscript, type ThreadSummary } from "@/actions/agent";
import { appConfig } from "@/app.config";
import { useApp } from "@/components/app-context";
import { endMessage, isGreetingCue, primeAudio, VOICE_MIC_CONSTRAINTS, voiceSessionConfig, type VoiceEndReason } from "@/lib/agent/voice";
import { closeAssistant, useAssistantState } from "./agent-store";
import { AssistantParts, awaitingApproval, hasVisibleContent, textOf } from "./agent-message";
import { AgentTasks } from "./agent-tasks";
import { DictationButton, type DictationState } from "./dictation-button";
import { VoicePresence } from "./voice-presence";
import VoiceSession, { type VoiceApi, type VoiceStatus } from "./voice-session";
import { prefetchVoiceSetup, takeVoiceSetup } from "./voice-setup";
import { checkForChanges } from "@/components/live-updates";

const COMPOSER_MIN = 40;
const COMPOSER_MAX = 160;
const AT_BOTTOM_PX = 48;
const LAST_THREAD_KEY = "crm-agent-thread";
const IDLE_VOICE: VoiceStatus = { status: "disconnected", isCapturing: false, isPlaying: false };

type Feedback = "up" | "down" | null;
const feedbackOf = (m: UIMessage): Feedback => {
  const f = (m.metadata as { feedback?: unknown } | undefined)?.feedback;
  return f === "up" || f === "down" ? f : null;
};

/** The error the server sent ({ message }), or the transport's own. */
function errorText(error: Error | undefined) {
  if (!error) return "";
  try {
    const parsed = JSON.parse(error.message) as { message?: unknown };
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Not JSON: a network error.
  }
  return error.message?.includes("fetch") ? "You seem to be offline. Check your connection and try again." : error.message || "Something went wrong. Try again.";
}

const recordPage = /^\/(clients|people|organizations)\/[0-9a-f-]{36}/i;
const recordWord = { clients: "client", people: "person", organizations: "organization" } as const;

/** Suggested actions on a new chat. On a record's page, ones about that record come first. */
function suggestionsFor(pathname: string, canEdit: boolean) {
  const base = [...(canEdit ? appConfig.agent.suggestions : appConfig.agent.viewerSuggestions)];
  const m = recordPage.exec(pathname);
  if (!m) return base;
  const word = recordWord[m[1].toLowerCase() as keyof typeof recordWord];
  const here = [`Summarize this ${word}`, `What happened with this ${word} recently?`, ...(canEdit ? [`Add a follow-up task for this ${word}`] : [])];
  return [...here, ...base].slice(0, 5);
}

function readLastThread() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(LAST_THREAD_KEY) ?? "null") as { id?: string; at?: number } | null;
    // Pick up where they left off within a working day; after that, start fresh.
    return saved?.id && saved.at && Date.now() - saved.at < 12 * 3600_000 ? saved.id : null;
  } catch {
    return null;
  }
}

function rememberThread(id: string) {
  try {
    window.localStorage.setItem(LAST_THREAD_KEY, JSON.stringify({ id, at: Date.now() }));
  } catch {
    // Private mode or storage full: nothing to remember.
  }
}

/**
 * The agent: a chat panel in the bottom right corner (the whole screen on
 * a phone). It answers with the teammate's own access: it reads and changes
 * records through the same operations as the API and MCP, as them. Threads
 * are saved per teammate; voice chat talks to a speech-to-speech model.
 * Each AI feature (voice, dictation) shows only where the deployment turned it on.
 */
export function AgentPanel({ configured }: { configured: boolean }) {
  const { open, prompt, seq } = useAssistantState();
  const { canEdit, viewer, services } = useApp();
  const pathname = usePathname();
  const name = appConfig.agent.name;

  const [threadId, setThreadId] = useState(() => readLastThread() ?? crypto.randomUUID());
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [tasksKey, setTasksKey] = useState(0);
  const [loadingThread, setLoadingThread] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [input, setInput] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [dictation, setDictation] = useState<DictationState>({ recording: false, transcribing: false });
  const [dictationError, setDictationError] = useState("");
  const [voiceConfig, setVoiceConfig] = useState<Partial<Experimental_RealtimeSessionConfig> | null>(null);
  const [voiceStarting, setVoiceStarting] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const [voiceNotice, setVoiceNotice] = useState("");
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>(IDLE_VOICE);
  const [voiceStream, setVoiceStream] = useState<MediaStream | null>(null);
  const [voiceSocket, setVoiceSocket] = useState<{ token: string; url: string } | null>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const voiceApi = useRef<VoiceApi | null>(null);
  const voiceClosed = useRef(false);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceEpoch = useRef(0);
  /** Threads made in this panel and not saved yet: nothing to load for them. */
  const fresh = useRef(new Set<string>());
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/agent/chat",
        // Only the new message goes up; the server has the rest of the thread.
        prepareSendMessagesRequest: ({ id, messages }) => ({ body: { threadId: id, message: messages.at(-1), page: window.location.pathname } }),
      }),
    [],
  );

  const refreshThreads = useCallback(async () => {
    const res = await listAgentThreads();
    if (res.ok) setThreads(res.data);
  }, []);

  const { messages, sendMessage, setMessages, status, stop, error, clearError, addToolApprovalResponse } = useChat({
    id: threadId,
    transport,
    // After the teammate confirms or cancels an archive, the agent carries on.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: () => {
      void refreshThreads();
      // The answer may have handed a job to the background worker: the task list reads again.
      setTasksKey((k) => k + 1);
    },
    onError: (err) => console.error("[agent]", err),
  });
  const busy = status === "submitted" || status === "streaming";
  const busyRef = useRef(busy);
  useEffect(() => {
    busyRef.current = busy;
  });
  const voiceLive = !!voiceConfig;

  // A tool finished while the agent is answering: the page behind the panel catches up right away,
  // so a task it just added shows on the record without a reload. Read-only tools change nothing, so nothing refreshes.
  const settledTools = useRef(new Set<string>());
  useEffect(() => {
    let finished = false;
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const p of m.parts as { type: string; state?: string; toolCallId?: string }[]) {
        if (!(p.type === "dynamic-tool" || p.type.startsWith("tool-")) || p.state !== "output-available" || !p.toolCallId) continue;
        if (settledTools.current.has(p.toolCallId)) continue;
        settledTools.current.add(p.toolCallId);
        finished = true;
      }
    }
    // A saved thread loading isn't news; only tools that finish during an answer are.
    if (finished && busy) checkForChanges();
  }, [messages, busy]);

  // Opening the panel: the thread list, and the saved messages of the current thread.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads the list from the server when the panel opens
    if (open) void refreshThreads();
  }, [open, refreshThreads]);

  useEffect(() => {
    rememberThread(threadId);
    if (fresh.current.has(threadId)) return;
    let current = true;
    setLoadingThread(true);
    loadAgentThread(threadId).then((res) => {
      if (!current) return;
      setLoadingThread(false);
      if (res.ok) setMessages(res.data.messages as UIMessage[]);
    });
    return () => {
      current = false;
    };
  }, [threadId, setMessages]);

  // A background task started from this chat finished: its answer was saved into the thread, so show it.
  const showBackgroundAnswer = useCallback(() => {
    if (busyRef.current) return;
    void loadAgentThread(threadId).then((res) => {
      if (res.ok && !busyRef.current) setMessages(res.data.messages as UIMessage[]);
    });
  }, [threadId, setMessages]);

  // Something asked the agent a question ("Ask about this client"): put it in the composer.
  const [seenSeq, setSeenSeq] = useState(0);
  if (seq !== seenSeq) {
    setSeenSeq(seq);
    if (prompt) setInput(prompt);
  }

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [open, threadId]);

  // The composer grows with its text.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el || dictation.recording) return;
    el.style.height = `${COMPOSER_MIN}px`;
    el.style.height = `${Math.min(Math.max(el.scrollHeight, COMPOSER_MIN), COMPOSER_MAX)}px`;
    el.style.overflowY = el.scrollHeight > COMPOSER_MAX ? "auto" : "hidden";
  }, [input, dictation.recording, open]);

  // Stay on the newest message unless the teammate scrolled up.
  useEffect(() => {
    const el = viewportRef.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [messages, status, open, atBottom, voiceConfig]);

  useEffect(() => {
    if (!menuOpen) return;
    const down = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("pointerdown", down);
    return () => window.removeEventListener("pointerdown", down);
  }, [menuOpen]);

  // ── Voice ─────────────────────────────────────────────────────────────

  const releaseMic = () => {
    voiceEpoch.current += 1;
    voiceStreamRef.current?.getTracks().forEach((t) => t.stop());
    voiceStreamRef.current = null;
    setVoiceStream(null);
  };

  const endVoice = () => {
    voiceClosed.current = true;
    voiceApi.current?.disconnect();
    releaseMic();
    setVoiceConfig(null);
    setVoiceSocket(null);
    setVoiceStarting(false);
    setVoiceStatus(IDLE_VOICE);
  };

  /** Pointing at the button fetches the setup, so the click only waits for the microphone and the socket. */
  const warmVoice = () => {
    if (!services.ai.voice || voiceConfig || voiceStarting) return;
    prefetchVoiceSetup(window.location.pathname).catch(() => {});
  };

  async function startVoice() {
    if (voiceConfig || voiceStarting || !services.ai.voice) return;
    voiceClosed.current = false;
    // Before any await: browsers only allow audio that a click started.
    primeAudio();
    setVoiceError("");
    setVoiceNotice("");
    setVoiceStarting(true);
    const epoch = ++voiceEpoch.current;
    const cancelled = () => voiceClosed.current || voiceEpoch.current !== epoch;
    let micError: unknown = null;
    const mic = (navigator.mediaDevices?.getUserMedia ? navigator.mediaDevices.getUserMedia(VOICE_MIC_CONSTRAINTS) : Promise.reject(new Error("no mic")))
      .then((s) => {
        if (cancelled()) {
          s.getTracks().forEach((t) => t.stop());
          return null;
        }
        voiceStreamRef.current = s;
        return s;
      })
      .catch((err: unknown) => {
        micError = err;
        return null;
      });
    try {
      // The setup was usually fetched on hover; the microphone opens alongside it.
      const [setup, stream] = await Promise.all([takeVoiceSetup(window.location.pathname), mic]);
      if (cancelled()) return releaseMic();
      if (micError || !stream?.getTracks().some((t) => t.readyState === "live")) {
        releaseMic();
        setVoiceError("Allow microphone access in your browser to use voice chat.");
        return;
      }
      fresh.current.delete(threadId);
      setVoiceStream(stream);
      setVoiceSocket({ token: setup.token, url: setup.url });
      setVoiceConfig(voiceSessionConfig(setup.instructions, setup.tools));
    } catch (err) {
      const wasCancelled = cancelled();
      releaseMic();
      if (!wasCancelled) setVoiceError((err as Error)?.message || "Voice chat couldn't start. Try again.");
    } finally {
      setVoiceStarting(false);
    }
  }

  const onVoiceEnd = (reason?: VoiceEndReason) => {
    if (voiceClosed.current) return;
    endVoice();
    const notice = endMessage(reason);
    if (notice) setVoiceNotice(notice);
  };

  /** When a call ends, what was said joins the thread as text. */
  const onTranscript = (said: UIMessage[]) => {
    const transcript = said.filter((m) => !(m.role === "user" && isGreetingCue(textOf(m)))).map((m) => ({ role: m.role, parts: m.parts.filter((p) => p.type === "text") }));
    if (!transcript.some((m) => textOf(m as UIMessage).trim())) return;
    const id = threadId;
    void saveVoiceTranscript(id, transcript).then(async (res) => {
      if (!res.ok || !res.data.saved) return;
      const loaded = await loadAgentThread(id);
      if (loaded.ok && id === threadIdRef.current) setMessages(loaded.data.messages as UIMessage[]);
      void refreshThreads();
    });
  };
  const threadIdRef = useRef(threadId);
  useEffect(() => {
    threadIdRef.current = threadId;
  }, [threadId]);

  // ── Threads ───────────────────────────────────────────────────────────

  const resetComposer = () => {
    setInput("");
    setEditingId(null);
    setMenuOpen(false);
    setAtBottom(true);
    clearError();
  };

  const switchTo = (id: string) => {
    if (voiceConfig || voiceStarting) endVoice();
    if (busy) void stop();
    resetComposer();
    setThreadId(id);
  };

  const newChat = () => {
    const id = crypto.randomUUID();
    fresh.current.add(id);
    switchTo(id);
    setMessages([]);
  };

  const removeThread = async (id: string) => {
    setThreads((list) => list.filter((t) => t.id !== id));
    await deleteAgentThread(id);
    if (id === threadId) newChat();
  };

  const close = () => {
    if (voiceConfig || voiceStarting) endVoice();
    setMenuOpen(false);
    closeAssistant();
  };

  useEffect(() => {
    if (!open) return;
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (menuOpen) return setMenuOpen(false);
      close();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  // ── Messages ──────────────────────────────────────────────────────────

  const submit = (text: string, replaceId: string | null = null) => {
    const trimmed = text.trim();
    if (!trimmed || busy || dictation.recording || !configured) return;
    fresh.current.delete(threadId);
    resetComposer();
    void sendMessage({ text: trimmed, ...(replaceId ? { messageId: replaceId } : {}) });
  };

  const onSubmit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!voiceLive) submit(input, editingId);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    onSubmit();
  };

  const pickSuggestion = (s: string) => {
    // "Log a call with…" needs a name: it goes to the composer instead of straight to the agent.
    if (s.endsWith("…")) {
      setInput(s.slice(0, -1) + " ");
      window.setTimeout(() => inputRef.current?.focus(), 0);
    } else submit(s);
  };

  const copy = async (m: UIMessage) => {
    try {
      await navigator.clipboard.writeText(textOf(m));
      setCopiedId(m.id);
      window.setTimeout(() => setCopiedId((c) => (c === m.id ? null : c)), 1500);
    } catch {
      // Clipboard blocked: nothing to do.
    }
  };

  const rate = (m: UIMessage, value: Feedback) => {
    setMessages((list) => list.map((x) => (x.id === m.id ? { ...x, metadata: { ...(x.metadata as object), feedback: value } } : x)));
    void rateAgentMessage(threadId, m.id, value);
  };

  const edit = (m: UIMessage) => {
    if (busy || dictation.recording) return;
    setEditingId(m.id);
    setInput(textOf(m));
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const approve = (id: string, approved: boolean) => void addToolApprovalResponse({ id, approved });

  const onScroll = () => {
    const el = viewportRef.current;
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_PX);
  };

  // On a phone the panel covers the page, so following a link closes it.
  const onNavigate = () => {
    if (window.matchMedia("(max-width: 639px)").matches) close();
  };

  const visible = messages.filter((m) => m.role === "user" || hasVisibleContent(m));
  const last = messages.at(-1);
  const thinking = busy && (!last || last.role === "user" || !hasVisibleContent(last));
  const empty = visible.length === 0;
  const current = threads.find((t) => t.id === threadId);
  const suggestions = suggestionsFor(pathname, canEdit);

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="agent-title"
      hidden={!open}
      className="fixed inset-0 z-40 flex flex-col overflow-hidden bg-surface sm:inset-auto sm:right-4 sm:bottom-4 sm:h-[min(42rem,calc(100dvh-2rem))] sm:w-[25rem] sm:rounded-xl sm:border sm:border-line sm:shadow-lg"
    >
      {/* Header: name, new chat, thread menu, minimize */}
      <div className="flex items-center justify-between gap-2 bg-accent px-3 pt-[max(0.625rem,env(safe-area-inset-top))] pb-2.5 text-accent-foreground sm:pt-2.5">
        <h2 id="agent-title" className="flex min-w-0 items-center gap-2 text-[14px] font-semibold text-accent-foreground">
          <SparklesIcon className="size-[18px] shrink-0" aria-hidden />
          <span className="truncate">{name}</span>
        </h2>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={newChat} disabled={empty && !voiceLive} className="inline-flex size-8 items-center justify-center rounded-md hover:bg-white/15 disabled:opacity-50" aria-label="New chat" title="New chat">
            <PencilSquareIcon className="size-[18px]" aria-hidden />
          </button>
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Choose a chat"
              className="inline-flex min-h-8 max-w-40 items-center gap-1 rounded-md bg-surface px-2.5 py-1 text-left text-[12px] leading-snug text-primary hover:bg-surface/90"
            >
              <span className="line-clamp-2 min-w-0 flex-1 break-words">{current?.title ?? (empty ? "New chat" : "This chat")}</span>
              <ChevronDownIcon className="size-4 shrink-0" aria-hidden />
            </button>
            {menuOpen ? (
              <div role="menu" className="absolute top-[calc(100%+4px)] right-0 z-10 max-h-80 w-80 max-w-[calc(100vw-2rem)] animate-pop-in overflow-y-auto rounded-lg border border-line bg-surface p-1 text-primary shadow-md">
                <button type="button" role="menuitem" onClick={newChat} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13.5px] font-medium text-primary hover:bg-sunken">
                  <PencilSquareIcon className="size-4 text-muted" aria-hidden />
                  New chat
                </button>
                {threads.length ? <div className="-mx-1 my-1 h-px bg-line" /> : null}
                {threads.map((t) => (
                  <div key={t.id} className={clsx("group flex items-start gap-1 rounded-md hover:bg-sunken", t.id === threadId && "bg-accent-soft")}>
                    <button type="button" role="menuitem" onClick={() => switchTo(t.id)} className="min-w-0 flex-1 px-2 py-2 text-left text-[13.5px] leading-snug" aria-current={t.id === threadId ? "true" : undefined}>
                      <span className={clsx("line-clamp-2 break-words", t.id === threadId ? "font-medium text-primary" : "text-secondary")}>{t.title}</span>
                    </button>
                    <button type="button" onClick={() => void removeThread(t.id)} className="m-1 rounded p-1 text-muted hover:bg-error-surface hover:text-error" aria-label={`Delete ${t.title}`} title="Delete">
                      <TrashIcon className="size-3.5" aria-hidden />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <button type="button" onClick={close} className="inline-flex size-8 items-center justify-center rounded-md hover:bg-white/15" aria-label={`Minimize ${name}`} title="Minimize">
            <MinusIcon className="size-[18px]" aria-hidden />
          </button>
        </div>
      </div>

      {services.ai.background ? <AgentTasks open={open} threadId={threadId} refreshKey={tasksKey} onAnswer={showBackgroundAnswer} onNavigate={onNavigate} /> : null}

      {/* Conversation */}
      <div className="relative flex min-h-0 flex-1">
        <div ref={viewportRef} onScroll={onScroll} className="scroll-thin min-h-0 flex-1 overflow-y-auto p-3" aria-label="Conversation">
          <div className={clsx("flex min-h-full flex-col gap-4", empty && "items-center justify-center")} aria-live="polite" aria-relevant="additions text">
            {(voiceStarting || voiceLive) && empty ? (
              <VoicePresence layout="center" name={name} status={voiceLive ? voiceStatus.status : "connecting"} isPlaying={voiceStatus.isPlaying} stream={voiceStream} error={voiceError} onEnd={endVoice} />
            ) : null}

            {empty && !voiceLive && !voiceStarting ? (
              <div className="flex w-full flex-col items-center gap-3 px-2 py-6 text-center">
                <div className="flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent-soft-foreground">
                  <SparklesIcon className="size-6" aria-hidden />
                </div>
                <div>
                  <p className="text-[16px] font-semibold text-primary">How can I help, {viewer.name.split(" ")[0]}?</p>
                  <p className="mt-0.5 text-[12.5px] text-muted">{canEdit ? "Ask about your clients and contacts, or have me log calls, add tasks and update records." : "Ask about your clients, contacts and tasks. Your role can look things up but not change them."}</p>
                </div>
                {!configured ? (
                  <p className="rounded-lg border border-warning-border bg-warning-surface px-3 py-2 text-left text-[12.5px] text-primary">
                    The agent isn&apos;t connected to AI Gateway on this deployment yet. An admin can set it up; docs/AGENT.md has the steps.
                  </p>
                ) : loadingThread ? (
                  <p className="text-shimmer text-[13px]">Loading…</p>
                ) : (
                  <>
                    <div className="flex w-full flex-col gap-1.5 pt-1">
                      {suggestions.map((s) => (
                        <button key={s} type="button" onClick={() => pickSuggestion(s)} disabled={busy} className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-left text-[13.5px] text-primary transition-colors hover:border-line-strong hover:bg-sunken disabled:opacity-50">
                          {s}
                        </button>
                      ))}
                    </div>
                    {services.ai.voice ? (
                      <>
                        {voiceError ? <p className="max-w-64 text-[12px] text-error">{voiceError}</p> : null}
                        {voiceNotice ? <p className="max-w-64 text-[12px] text-muted">{voiceNotice}</p> : null}
                        <button
                          type="button"
                          onClick={() => void startVoice()}
                          onPointerEnter={warmVoice}
                          onFocus={warmVoice}
                          onTouchStart={warmVoice}
                          disabled={voiceStarting} className="mt-1 inline-flex h-10 items-center gap-2 rounded-full border border-line-strong bg-surface px-5 text-[13.5px] font-medium text-primary hover:bg-sunken disabled:opacity-50">
                          <SpeakerWaveIcon className="size-4" aria-hidden />
                          Start voice chat
                        </button>
                        <p className="max-w-64 text-[12px] text-muted">Talk it through out loud. {name} can look things up and make changes while you talk.</p>
                      </>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}

            {visible.map((m) => {
              const isUser = m.role === "user";
              const fb = feedbackOf(m);
              const voice = !!(m.metadata as { voice?: boolean } | undefined)?.voice;
              return (
                <div key={m.id} className={clsx("flex max-w-full flex-col gap-0.5", isUser ? "items-end" : "items-start")}>
                  <div className={clsx("rounded-2xl px-3 py-2 break-words", isUser ? "max-w-[85%] bg-accent text-accent-foreground" : "w-full max-w-full bg-sunken text-secondary")}>
                    {isUser ? <p className="text-[14px] whitespace-pre-wrap">{textOf(m)}</p> : <AssistantParts message={m} onApprove={approve} onNavigate={onNavigate} />}
                  </div>
                  {isUser ? (
                    <div className="flex items-center gap-1 px-1 text-muted">
                      {voice ? <span className="text-[11px]">Said in voice chat</span> : null}
                      {!voice ? (
                        <button type="button" onClick={() => edit(m)} disabled={busy || dictation.recording || voiceLive} className="rounded p-1 hover:bg-sunken hover:text-primary disabled:pointer-events-none disabled:opacity-40" aria-label="Edit message" title="Edit">
                          <PencilIcon className="size-3.5" aria-hidden />
                        </button>
                      ) : null}
                    </div>
                  ) : textOf(m).trim() && !(busy && m.id === last?.id) ? (
                    <div className="mt-1 flex items-center gap-0.5 text-muted">
                      <button type="button" onClick={() => void copy(m)} className="inline-flex size-7 items-center justify-center rounded-md hover:bg-sunken hover:text-primary" aria-label={copiedId === m.id ? "Copied" : "Copy answer"} title={copiedId === m.id ? "Copied" : "Copy"}>
                        {copiedId === m.id ? <CheckIcon className="size-3.5 text-success" aria-hidden /> : <ClipboardDocumentIcon className="size-3.5" aria-hidden />}
                      </button>
                      <button type="button" onClick={() => rate(m, fb === "up" ? null : "up")} aria-pressed={fb === "up"} className={clsx("inline-flex size-7 items-center justify-center rounded-md", fb === "up" ? "bg-success-surface text-success" : "hover:bg-sunken hover:text-primary")} aria-label="Good answer" title="Good answer">
                        <HandThumbUpIcon className="size-3.5" aria-hidden />
                      </button>
                      <button type="button" onClick={() => rate(m, fb === "down" ? null : "down")} aria-pressed={fb === "down"} className={clsx("inline-flex size-7 items-center justify-center rounded-md", fb === "down" ? "bg-error-surface text-error" : "hover:bg-sunken hover:text-primary")} aria-label="Bad answer" title="Bad answer">
                        <HandThumbDownIcon className="size-3.5" aria-hidden />
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}

            {thinking ? <p className="text-shimmer text-[13.5px]">Thinking…</p> : null}
            {awaitingApproval(last) && !busy ? <p className="text-[12.5px] text-muted">Waiting for you to confirm.</p> : null}
            {error ? (
              <p className="text-[13px] text-error" role="alert">
                {errorText(error)}
              </p>
            ) : null}
          </div>
        </div>
        {!atBottom ? (
          <button
            type="button"
            onClick={() => {
              viewportRef.current?.scrollTo({ top: viewportRef.current.scrollHeight, behavior: "smooth" });
              setAtBottom(true);
            }}
            className="absolute bottom-3 left-1/2 inline-flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-surface text-primary shadow-sm"
            aria-label="Scroll to the newest message"
          >
            <ChevronDownIcon className="size-4" aria-hidden />
          </button>
        ) : null}
      </div>

      {voiceConfig && voiceStream && voiceSocket ? (
        <VoiceSession
          socket={voiceSocket}
          sessionConfig={voiceConfig}
          captureStream={voiceStream}
          onStatus={(s) => {
            setVoiceStatus(s);
            if (s.status === "connected") setVoiceError("");
          }}
          onError={(err) => {
            if (!voiceClosed.current) setVoiceError(err?.message || "Voice chat ran into a problem.");
          }}
          onSessionEnd={onVoiceEnd}
          onTranscript={onTranscript}
          apiRef={voiceApi}
        />
      ) : null}

      {voiceLive && !empty ? <VoicePresence name={name} status={voiceStatus.status} isPlaying={voiceStatus.isPlaying} stream={voiceStream} error={voiceError} onEnd={endVoice} /> : null}

      {/* Composer */}
      {!voiceLive && !voiceStarting ? (
        <form onSubmit={onSubmit} className="flex flex-col gap-1.5 border-t border-line px-3 pt-3 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {editingId ? (
            <div className="flex items-center justify-between gap-2 px-1 text-[12px] text-muted">
              <span className="inline-flex items-center gap-1">
                <PencilIcon className="size-3" aria-hidden />
                Editing your message
              </span>
              <button type="button" onClick={() => (setEditingId(null), setInput(""))} className="font-medium text-primary hover:underline">
                Cancel
              </button>
            </div>
          ) : null}
          {dictationError ? <p className="px-1 text-[12px] text-error">{dictationError}</p> : null}
          <div className="flex items-end gap-2">
            <div className="flex min-h-10 min-w-0 flex-1 items-center gap-1 rounded-2xl border border-line bg-surface px-2 shadow-sm focus-within:border-ring">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                rows={1}
                placeholder={dictation.recording ? "Listening…" : `Ask ${name}…`}
                aria-label={`Message ${name}`}
                disabled={dictation.transcribing || !configured}
                readOnly={dictation.recording}
                maxLength={8000}
                className="min-h-10 min-w-0 flex-1 resize-none border-0 bg-transparent px-1.5 py-2.5 text-[14px] leading-5 text-primary outline-none placeholder:text-faint focus-visible:outline-none disabled:opacity-60"
              />
              {services.ai.dictation ? (
              <DictationButton
                active={open}
                disabled={busy || !configured}
                onTranscript={(text) => {
                  setDictationError("");
                  setInput((prev) => (!prev ? text : `${prev}${/\s$/.test(prev) ? "" : " "}${text}`));
                  window.setTimeout(() => inputRef.current?.focus(), 0);
                }}
                onStateChange={setDictation}
                onError={setDictationError}
              />
              ) : null}
            </div>
            {busy ? (
              <button type="button" onClick={() => void stop()} className="inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-primary hover:bg-sunken" aria-label="Stop">
                <StopIcon className="size-4" aria-hidden />
              </button>
            ) : (
              <button type="submit" disabled={!input.trim() || dictation.recording || dictation.transcribing || !configured} className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground hover:bg-accent-hover disabled:opacity-50" aria-label="Send">
                <ArrowUpIcon className="size-5" strokeWidth={2.5} aria-hidden />
              </button>
            )}
          </div>
          <p className="flex items-center justify-center gap-1 text-center text-[10.5px] text-muted">
            <span className="inline-flex h-4 items-center gap-0.5 rounded-md bg-accent-soft px-1 text-[9.5px] font-semibold text-accent-soft-foreground">
              <BeakerIcon className="size-2.5" aria-hidden />
              Beta
            </span>
            {name} acts as you and can make mistakes. Changes show in history.
          </p>
        </form>
      ) : null}
    </div>
  );
}
