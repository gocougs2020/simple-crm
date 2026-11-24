/**
 * How a team chat message reads on screen: plain text, with "@Name" mentions
 * of teammates and web links picked out. Pure, so the page and the tests
 * agree. Mentions follow the same rule notes use (src/lib/crm/mentions.ts):
 * the full name, or a first name nobody else on the team shares.
 */

import { findMentions, mentionAliases } from "@/lib/crm/mentions";

type Teammate = { id: string; name: string; active: boolean };

export type ChatSegment = { kind: "text"; text: string } | { kind: "mention"; text: string; userId: string } | { kind: "link"; text: string; href: string };

export const MAX_CHAT_LENGTH = 4000;
export const MAX_CHAT_FILES = 10;

const linkPattern = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/gi;
/**
 * "[Acme](/clients/<id>)": a labeled link, as the agent writes them. The target is a
 * path on this site or a web address; anything else stays plain text.
 */
const labeledPattern = /\[([^\]\n]{1,200})\]\((\/[\w\-./?=&#%]*|https?:\/\/[^\s<>"')]+)\)/g;
/** Bare web addresses and labeled links, in one pass. */
const anyLink = new RegExp(`${labeledPattern.source}|${linkPattern.source}`, "gi");

function splitMentions(text: string, team: Teammate[]): ChatSegment[] {
  const aliases = mentionAliases(team);
  const found = findMentions(text, [...aliases].map(([id, names]) => ({ id, aliases: names })));
  const out: ChatSegment[] = [];
  let last = 0;
  for (const m of found) {
    if (m.start > last) out.push({ kind: "text", text: text.slice(last, m.start) });
    out.push({ kind: "mention", text: text.slice(m.start, m.end), userId: m.id });
    last = m.end;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

/** A message's text as segments: plain text, mentions and links. A link to a path on this site (`href` starting "/") opens in the app. */
export function chatSegments(text: string, team: Teammate[]): ChatSegment[] {
  const out: ChatSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(anyLink)) {
    if (m.index > last) out.push(...splitMentions(text.slice(last, m.index), team));
    // "//evil.example" is a link to another site, not a path here.
    if (m[1] && m[2] && !m[2].startsWith("//")) out.push({ kind: "link", text: m[1], href: m[2] });
    else if (m[1]) out.push(...splitMentions(m[0], team));
    else out.push({ kind: "link", text: m[0], href: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(...splitMentions(text.slice(last), team));
  return out.filter((s) => s.text.length > 0);
}

/** The "@query" being typed at the cursor, if any: what the mention picker filters by, and where it starts. */
export function mentionQuery(text: string, cursor: number): { query: string; start: number } | null {
  const before = text.slice(0, cursor);
  const m = before.match(/(^|[\s(])@([\p{L}\p{N}'.-]*(?: [\p{L}\p{N}'.-]*)?)$/u);
  if (!m) return null;
  const query = m[2];
  // A second word only counts while it could still be a surname being typed.
  if (query.includes(" ") && query.endsWith(" ")) return null;
  return { query, start: before.length - query.length - 1 };
}

/**
 * The agent's markdown answer as a team chat message: plain text, with
 * labeled links kept ("[Acme](/clients/<id>)", which the chat shows as links),
 * emphasis, headings and code marks dropped, list items as bullets, and cut to
 * fit one message.
 */
export function chatTextFromMarkdown(md: string, max = MAX_CHAT_LENGTH) {
  const text = md
    .replace(/\r\n/g, "\n")
    .replace(/^```[^\n]*\n?/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "• ")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length <= max) return text;
  const note = "\n\n… The rest is under Background tasks in the agent panel.";
  return `${text.slice(0, max - note.length).trimEnd()}${note}`;
}
