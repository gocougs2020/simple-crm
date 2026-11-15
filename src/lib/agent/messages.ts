import type { AgentMessage } from "@/db/schema";

/**
 * How assistant threads are stored and continued. Pure (tested): the chat
 * route loads a thread, merges in the one message the browser sent, and saves
 * what comes back. The browser never sends the whole history, so it can't
 * rewrite what the assistant said or what a tool returned.
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

/** A message the teammate typed: an id and its text, nothing else. Returns null when there's nothing to send. */
export function cleanUserMessage(raw: unknown, now = Date.now()): AgentMessage | null {
  if (!isRecord(raw) || raw.role !== "user" || typeof raw.id !== "string" || !/^[\w-]{1,64}$/.test(raw.id)) return null;
  const text = messageText(raw).slice(0, MAX_USER_TEXT).trim();
  if (!text) return null;
  return { id: raw.id, role: "user", parts: [{ type: "text", text }], metadata: { createdAt: now } };
}

/**
 * Applies the teammate's answers to confirmation requests (approve or deny an
 * archive, say) from the browser's copy of the assistant's last message onto
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
 * - the assistant's last message comes back when the teammate answers a confirmation.
 */
export function mergeIncoming(stored: AgentMessage[], incoming: unknown, now = Date.now()): Merge {
  if (isRecord(incoming) && incoming.role === "assistant") {
    const last = stored.at(-1);
    if (!last || last.role !== "assistant" || last.id !== incoming.id) return { ok: false, error: "That confirmation is out of date. Ask again." };
    const { message, changed } = applyApprovals(last, incoming);
    if (!changed) return { ok: false, error: "Nothing to confirm in that message." };
    return { ok: true, messages: [...stored.slice(0, -1), message], submitted: false };
  }
  const message = cleanUserMessage(incoming, now);
  if (!message) return { ok: false, error: "Write a message first." };
  const at = stored.findIndex((m) => m.id === message.id);
  if (at >= 0 && stored[at].role !== "user") return { ok: false, error: "Only your own messages can be edited." };
  return { ok: true, messages: [...(at >= 0 ? stored.slice(0, at) : stored), message], submitted: true };
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
