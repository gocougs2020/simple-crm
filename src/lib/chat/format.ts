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

/** A message's text as segments: plain text, mentions and links. */
export function chatSegments(text: string, team: Teammate[]): ChatSegment[] {
  const out: ChatSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(linkPattern)) {
    if (m.index > last) out.push(...splitMentions(text.slice(last, m.index), team));
    out.push({ kind: "link", text: m[0], href: m[0] });
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
