/**
 * The last few records a teammate opened from search, shown at the top of
 * the search box so they can go straight back. Kept in this browser only
 * (localStorage, one list per teammate), so it never reaches the server and
 * a shared computer doesn't show one teammate's searches to another.
 */

export type RecentKind = "client" | "person" | "organization";
export type RecentRecord = { kind: RecentKind; id: string; label: string; detail?: string };

export const RECENT_MAX = 3;
const KINDS: RecentKind[] = ["client", "person", "organization"];

export const recentKey = (viewerId: string) => `recent-searches:${viewerId}`;

/** Puts a record first, once, keeping the newest `max`. */
export function addRecent(list: RecentRecord[], item: RecentRecord, max = RECENT_MAX): RecentRecord[] {
  return [item, ...list.filter((r) => !(r.kind === item.kind && r.id === item.id))].slice(0, max);
}

/** Whatever was stored, read defensively: anything malformed (an older format, a hand edit) is dropped. */
export function parseRecent(raw: string | null | undefined, max = RECENT_MAX): RecentRecord[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (r): r is RecentRecord =>
          !!r && typeof r === "object" && KINDS.includes(r.kind) && typeof r.id === "string" && typeof r.label === "string" && (r.detail === undefined || typeof r.detail === "string"),
      )
      .map((r) => ({ kind: r.kind, id: r.id, label: r.label, ...(r.detail ? { detail: r.detail } : {}) }))
      .slice(0, max);
  } catch {
    return [];
  }
}

export function loadRecent(viewerId: string): RecentRecord[] {
  try {
    return parseRecent(window.localStorage.getItem(recentKey(viewerId)));
  } catch {
    // Storage blocked (private mode, site data cleared): no recents, search works the same.
    return [];
  }
}

export function rememberRecent(viewerId: string, item: RecentRecord): RecentRecord[] {
  const next = addRecent(loadRecent(viewerId), item);
  try {
    window.localStorage.setItem(recentKey(viewerId), JSON.stringify(next));
  } catch {
    // Nothing to keep it in; it just won't show next time.
  }
  return next;
}
