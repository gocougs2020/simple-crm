/**
 * Mentioning a teammate in a note or a reply: "@" and their name, as it's
 * written on the team ("@Sam Lee"), or their first name alone when nobody
 * else on the team shares it ("@Sam"). Pure, so the composer and the server
 * agree on who a note calls on. The agent has its own rule (`mentionsAgent`
 * in src/lib/agent/run-rules.ts).
 */

type Teammate = { id: string; name: string; active: boolean };

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
