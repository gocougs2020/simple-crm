/**
 * How a team chat message reads on screen: plain text, with "@Name" mentions
 * of teammates and web links picked out. Pure, so the page and the tests
 * agree. Mentions follow the same rule notes use (src/lib/crm/mentions.ts):
 * the full name, or a first name nobody else on the team shares.
 */

type Teammate = { id: string; name: string; active: boolean };

export type ChatSegment = { kind: "text"; text: string } | { kind: "mention"; text: string; userId: string } | { kind: "link"; text: string; href: string };

export const MAX_CHAT_LENGTH = 4000;
export const MAX_CHAT_FILES = 10;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const linkPattern = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/gi;

/** The names a mention can use for each active teammate, longest first so "@Sam Lee" wins over "@Sam". */
function mentionNames(team: Teammate[]) {
  const active = team.filter((m) => m.active && m.name.trim());
  const first = (m: Teammate) => m.name.trim().split(/\s+/)[0];
  const shared = new Map<string, number>();
  for (const m of active) shared.set(first(m).toLowerCase(), (shared.get(first(m).toLowerCase()) ?? 0) + 1);
  const names = active.flatMap((m) => {
    const full = m.name.trim();
    const f = first(m);
    return [{ name: full, id: m.id }, ...(shared.get(f.toLowerCase()) === 1 && f !== full ? [{ name: f, id: m.id }] : [])];
  });
  return names.sort((a, b) => b.name.length - a.name.length);
}

function splitMentions(text: string, team: Teammate[]): ChatSegment[] {
  const names = mentionNames(team);
  if (!names.length || !text.includes("@")) return [{ kind: "text", text }];
  const pattern = new RegExp(`(^|[^\\w@.])@(${names.map((n) => escape(n.name).replace(/\s+/g, "\\s+")).join("|")})(?![\\w@]|\\.\\w)`, "gi");
  const out: ChatSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const start = m.index + m[1].length;
    const said = m[2].replace(/\s+/g, " ").toLowerCase();
    const who = names.find((n) => n.name.toLowerCase() === said);
    if (!who) continue;
    if (start > last) out.push({ kind: "text", text: text.slice(last, start) });
    out.push({ kind: "mention", text: text.slice(start, start + 1 + m[2].length), userId: who.id });
    last = start + 1 + m[2].length;
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
