import type { AgentMessage } from "@/db/schema";
import { attachmentsOf, cleanAttachments } from "./attachments";

/**
 * How agent threads are stored and continued. Pure (tested): the chat
 * route loads a thread, merges in the one message the browser sent, and saves
 * what comes back. The browser never sends the whole history, so it can't
 * rewrite what the agent said or what a tool returned.
 */

export const DEFAULT_TITLE = "New chat";
/** One typed message. Longer pastes are cut here. */
export const MAX_USER_TEXT = 8_000;
/** A thread's stored messages, as JSON. The oldest turns go first when it grows past this. */
export const MAX_STORED_CHARS = 800_000;
export const MAX_TITLE = 80;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function messageText(m: { parts?: unknown } | null | undefined) {
  if (!m || !Array.isArray(m.parts)) return "";
  return m.parts
    .filter((p): p is { type: "text"; text: string } => isRecord(p) && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}

/**
 * A message the teammate typed: an id, its text and the files they attached
 * (as text, checked again here), nothing else. Returns null when there's
 * nothing to send.
 */
export function cleanUserMessage(raw: unknown, now = Date.now()): AgentMessage | null {
  if (!isRecord(raw) || raw.role !== "user" || typeof raw.id !== "string" || !/^[\w-]{1,64}$/.test(raw.id)) return null;
  const files = cleanAttachments(isRecord(raw.metadata) ? raw.metadata.files : undefined);
  const text = messageText(raw).slice(0, MAX_USER_TEXT).trim() || (files.length ? `Attached ${files.map((f) => f.name).join(", ")}.` : "");
  if (!text) return null;
  return { id: raw.id, role: "user", parts: [{ type: "text", text }], metadata: { createdAt: now, ...(files.length ? { files } : {}) } };
}

/**
 * Applies the teammate's answers to confirmation requests (approve or deny an
 * archive, say) from the browser's copy of the agent's last message onto
 * the stored copy. Only approvals change; tool inputs and outputs stay as stored.
 */
export function applyApprovals(stored: AgentMessage, incoming: unknown): { message: AgentMessage; changed: boolean } {
  const answers = new Map<string, { approved: boolean; reason?: string }>();
  if (isRecord(incoming) && Array.isArray(incoming.parts)) {
    for (const p of incoming.parts) {
      if (!isRecord(p) || p.state !== "approval-responded" || !isRecord(p.approval)) continue;
      const { id, approved, reason } = p.approval;
      if (typeof id === "string" && typeof approved === "boolean") answers.set(id, { approved, ...(typeof reason === "string" && reason ? { reason: reason.slice(0, 500) } : {}) });
    }
  }
  let changed = false;
  const parts = stored.parts.map((p) => {
    if (p.state !== "approval-requested" || !isRecord(p.approval) || typeof p.approval.id !== "string") return p;
    const answer = answers.get(p.approval.id);
    if (!answer) return p;
    changed = true;
    return { ...p, state: "approval-responded", approval: { ...p.approval, ...answer } };
  });
  return { message: { ...stored, parts }, changed };
}

export type Merge = { ok: true; messages: AgentMessage[]; submitted: boolean } | { ok: false; error: string };

/**
 * The history to answer from, given what's stored and the message the browser sent:
 * - a new message from the teammate is added at the end;
 * - an edited one (an id that's already stored) replaces that turn and everything after it;
 * - the agent's last message comes back when the teammate answers a confirmation.
 */
export function mergeIncoming(stored: AgentMessage[], incoming: unknown, now = Date.now()): Merge {
  if (isRecord(incoming) && incoming.role === "assistant") {
    const last = stored.at(-1);
    // Answers saved before ids were sent with the stream have none: the last one takes the browser's.
    const legacy = !!last && last.id === "" && typeof incoming.id === "string" && /^[\w-]{1,64}$/.test(incoming.id);
    if (!last || last.role !== "assistant" || (last.id !== incoming.id && !legacy)) return { ok: false, error: "That confirmation is out of date. Ask again." };
    const { message, changed } = applyApprovals(last, incoming);
    if (!changed) return { ok: false, error: "Nothing to confirm in that message." };
    return { ok: true, messages: [...stored.slice(0, -1), legacy ? { ...message, id: incoming.id as string } : message], submitted: false };
  }
  const message = cleanUserMessage(incoming, now);
  if (!message) return { ok: false, error: "Write a message first." };
  const at = stored.findIndex((m) => m.id === message.id);
  if (at >= 0 && stored[at].role !== "user") return { ok: false, error: "Only your own messages can be edited." };
  // An edit changes the words: the files that came with the message stay with it.
  const kept = at >= 0 && !attachmentsOf(message).length ? attachmentsOf(stored[at]) : [];
  const next = kept.length ? { ...message, metadata: { ...message.metadata, files: kept } } : message;
  return { ok: true, messages: [...(at >= 0 ? stored.slice(0, at) : stored), next], submitted: true };
}

/** Drops the oldest turns until the thread fits MAX_STORED_CHARS. A thread always starts with the teammate. */
export function trimForStorage(messages: AgentMessage[], max = MAX_STORED_CHARS) {
  const kept = [...messages];
  while (kept.length > 1 && JSON.stringify(kept).length > max) {
    kept.shift();
    while (kept.length > 1 && kept[0].role !== "user") kept.shift();
  }
  return kept;
}

/** Voice transcripts saved into the thread: user and assistant text only, newest 60 turns. */
export function cleanTranscript(raw: unknown, now = Date.now()): AgentMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentMessage[] = [];
  for (const m of raw) {
    if (!isRecord(m) || (m.role !== "user" && m.role !== "assistant")) continue;
    const text = messageText(m).slice(0, MAX_USER_TEXT).trim();
    if (!text) continue;
    out.push({ id: `voice-${now.toString(36)}-${out.length}`, role: m.role, parts: [{ type: "text", text }], metadata: { createdAt: now, voice: true } });
  }
  return out.slice(-60);
}

/** A title from the model's answer: one line, no quotes or trailing period, at most MAX_TITLE characters. */
export function cleanTitle(raw: string) {
  let text = String(raw || "").split("\n")[0].replace(/\s+/g, " ").trim();
  text = text.replace(/^["'`“”]+|["'`“”]+$/g, "").replace(/\.+$/, "").trim();
  if (text.length <= MAX_TITLE) return text;
  const cut = text.slice(0, MAX_TITLE);
  const space = cut.lastIndexOf(" ");
  return (space > 24 ? cut.slice(0, space) : cut).trim();
}

/** Until a model names it, a thread is called by the start of its first message. */
export const fallbackTitle = (text: string) => cleanTitle(text) || DEFAULT_TITLE;

/** What the model is sent of a thread, at most (about 60k tokens). Storage keeps more (MAX_STORED_CHARS). */
export const MAX_MODEL_CHARS = 240_000;
/** Tool results from this many of the latest turns are sent in full; older ones are stubbed. */
export const FULL_RESULT_TURNS = 3;
export const OMITTED_RESULT = "Result omitted from this older turn; call the tool again if it's needed.";

const isToolPart = (p: unknown): p is Record<string, unknown> & { type: string } => isRecord(p) && typeof p.type === "string" && (p.type.startsWith("tool-") || p.type === "dynamic-tool");
/** A part waiting on the teammate's button, or just answered: never pruned or stubbed. */
const awaitsApproval = (p: unknown) => isRecord(p) && (p.state === "approval-requested" || p.state === "approval-responded");

/**
 * The history as the model reads it, without changing what's stored: tool
 * results older than the last `FULL_RESULT_TURNS` turns become a one-line
 * stub, and the oldest turns are left out until it fits `maxChars`. A turn
 * starts at a teammate's message. Anything awaiting or just given the
 * teammate's approval is kept as it is, and so is the latest turn.
 */
export function historyForModel<M extends AgentMessage>(messages: M[], { maxChars = MAX_MODEL_CHARS, fullTurns = FULL_RESULT_TURNS } = {}): M[] {
  const starts = messages.flatMap((m, i) => (m.role === "user" ? [i] : []));
  const fullFrom = starts.length > fullTurns ? starts[starts.length - fullTurns] : 0;
  let out = messages.map((m, i) => {
    if (i >= fullFrom || m.role !== "assistant") return m;
    let changed = false;
    const parts = m.parts.map((p) => {
      if (!isToolPart(p) || awaitsApproval(p) || p.state !== "output-available") return p;
      changed = true;
      return { ...p, output: OMITTED_RESULT };
    });
    return changed ? ({ ...m, parts } as M) : m;
  });
  // Oldest turns out first, keeping the latest one whole and anything awaiting approval.
  while (JSON.stringify(out).length > maxChars) {
    const next = out.findIndex((m, i) => i > 0 && m.role === "user");
    const lastUser = out.findLastIndex((m) => m.role === "user");
    if (next <= 0 || next >= lastUser || out.slice(0, next).some((m) => m.parts.some(awaitsApproval))) break;
    out = out.slice(next);
  }
  return out;
}
