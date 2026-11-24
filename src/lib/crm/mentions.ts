/**
 * Mentioning a teammate in a note or a reply: "@" and their name, as it's
 * written on the team ("@Sam Lee"), or their first name alone when nobody
 * else on the team shares it ("@Sam"). The picker always puts in the full name. Pure, so the composer and the server
 * agree on who a note calls on. The agent has its own rule (`mentionsAgent`
 * in src/lib/agent/run-rules.ts).
 */

import { appConfig } from "@/app.config";

type Teammate = { id: string; name: string; active: boolean };

/** The id the agent goes by in the @ list. Never a teammate's: theirs are uuids. */
export const AGENT_MENTION_ID = "agent";

/**
 * The names that call on the agent, once each: its handle (`agent.mentionName`, "Agent"), its full name
 * ("Recruiting Insight AI") and plain "agent". The first is what the @ list puts in.
 */
export function agentMentionNames(name = appConfig.agent.name, handle = appConfig.agent.mentionName) {
  const seen = new Set<string>();
  return [handle, name, "agent"]
    .map((n) => (n ?? "").trim().replace(/\s+/g, " "))
    .filter((n) => n && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** "@Name" as its own word: not part of an email address, not the start of a longer name. */
const mentions = (text: string, name: string) => new RegExp(`(^|[^\\w@.])@${escape(name).replace(/\s+/g, "\\s+")}(?![\\w@]|\\.\\w)`, "i").test(text);

/** The active teammates a note's plain text mentions. */
export function mentionedTeammates(text: string | null | undefined, team: Teammate[]): string[] {
  if (!text || !text.includes("@")) return [];
  const active = team.filter((m) => m.active && m.name.trim());
  const first = (m: Teammate) => m.name.trim().split(/\s+/)[0].toLowerCase();
  const shared = new Map<string, number>();
  for (const m of active) shared.set(first(m), (shared.get(first(m)) ?? 0) + 1);
  return active.filter((m) => mentions(text, m.name.trim()) || (shared.get(first(m)) === 1 && mentions(text, first(m)))).map((m) => m.id);
}

/**
 * The names that mention each active teammate: their full name, and their
 * first name too when no other active teammate shares it.
 */
export function mentionAliases(team: readonly Teammate[]): Map<string, string[]> {
  const active = team.filter((m) => m.active && m.name.trim());
  const first = (m: Teammate) => m.name.trim().split(/\s+/)[0];
  const shared = new Map<string, number>();
  for (const m of active) shared.set(first(m).toLowerCase(), (shared.get(first(m).toLowerCase()) ?? 0) + 1);
  return new Map(
    active.map((m) => {
      const full = m.name.trim();
      const f = first(m);
      return [m.id, shared.get(f.toLowerCase()) === 1 && f !== full ? [full, f] : [full]];
    }),
  );
}

/**
 * Where a text mentions teammates: each "@Name" with its start, end and who
 * it is. The longest name wins, so "@Sam Lee" is one mention, not "@Sam".
 * What the chat and the note editor highlight.
 */
export function findMentions(text: string, people: readonly { id: string; aliases: readonly string[] }[]): { start: number; end: number; id: string }[] {
  if (!text.includes("@")) return [];
  const names = people.flatMap((p) => p.aliases.map((name) => ({ name, id: p.id }))).sort((a, b) => b.name.length - a.name.length);
  if (!names.length) return [];
  const pattern = new RegExp(`(^|[^\\w@.])@(${names.map((n) => escape(n.name).replace(/\s+/g, "\\s+")).join("|")})(?![\\w@]|\\.\\w)`, "gi");
  const out: { start: number; end: number; id: string }[] = [];
  for (const m of text.matchAll(pattern)) {
    const said = m[2].replace(/\s+/g, " ").toLowerCase();
    const who = names.find((n) => n.name.toLowerCase() === said);
    if (!who) continue;
    const start = m.index + m[1].length;
    out.push({ start, end: start + 1 + m[2].length, id: who.id });
  }
  return out;
}

/**
 * Who the "@" picker offers, in alphabetical order by name: the active
 * teammates other than the one typing, each with what picking them inserts
 * (always their full name, "@Sam Lee") and the names that mention them.
 */
export function mentionOptions<T extends Teammate>(team: readonly T[], viewerId: string): (T & { insert: string; aliases: string[] })[] {
  const aliases = mentionAliases(team);
  return team
    .filter((m) => aliases.has(m.id) && m.id !== viewerId)
    .map((m) => ({ ...m, insert: `@${m.name.trim()}`, aliases: aliases.get(m.id)! }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** The options whose name (or another name they go by), or any word of it, starts with what's typed after "@". Everyone for a bare "@". */
export function matchMentions<T extends { name: string; aliases?: readonly string[] }>(options: readonly T[], query: string): T[] {
  const term = query.trim().toLowerCase();
  if (!term) return [...options];
  return options.filter((m) =>
    [m.name, ...(m.aliases ?? [])].some((n) => {
      const name = n.toLowerCase();
      return name.startsWith(term) || name.split(/\s+/).some((w) => w.startsWith(term));
    }),
  );
}
