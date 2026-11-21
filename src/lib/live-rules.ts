/**
 * When an open page asks whether anything changed, and what it refreshes
 * (src/components/live-updates.tsx). Pure, so it's tested and the cost stays
 * predictable: only visible tabs that someone used lately ask, at most once
 * per `pollSeconds`, and a change refreshes only what shows it.
 */
export function liveCheckDue({ now, lastCheck, lastActive, visible, pollSeconds, idleMinutes }: { now: number; lastCheck: number; lastActive: number; visible: boolean; pollSeconds: number; idleMinutes: number }) {
  if (!visible || pollSeconds <= 0) return false;
  if (now - lastActive > idleMinutes * 60_000) return false;
  return now - lastCheck >= pollSeconds * 1000;
}

/**
 * The parts of the CRM that change on their own (src/lib/live.ts):
 * `records` (record history and activities), `chat` (the team chat) and
 * `mail` (email and text conversations: unread, folders, links).
 */
export const liveScopes = ["records", "chat", "mail"] as const;
export type LiveScope = (typeof liveScopes)[number];
/** Each scope's version: microseconds since the epoch, as a string. */
export type LiveVersions = Record<LiveScope, string>;
export const noVersions: LiveVersions = { records: "0", chat: "0", mail: "0" };

/**
 * What each page shows, so a change elsewhere doesn't re-render it. Every
 * page with records on it shows `records` (new mail and texts are activities
 * too); the inbox and Messages also show `mail`, and Files `chat` (its chat attachments). The team chat shows nothing
 * that needs a page refresh: it fetches new and changed messages itself.
 */
export function pageScopes(pathname: string): LiveScope[] {
  if (pathname === "/chat" || pathname.startsWith("/chat/")) return [];
  // Files lists team chat attachments too ("From chat"), which come and go with chat messages.
  if (pathname === "/files" || pathname.startsWith("/files/")) return ["records", "chat"];
  if (pathname === "/email" || pathname.startsWith("/email/outlook") || pathname === "/messages" || pathname.startsWith("/messages/")) return ["records", "mail"];
  return ["records"];
}

/** The sidebar's badges count due work (`records`), unread conversations (`mail`) and team chat (`chat`). */
export const badgeScopes: readonly LiveScope[] = ["records", "chat", "mail"];

const newer = (a: string, b: string) => BigInt(a) > BigInt(b);

/** The scopes that moved past what was last seen. */
export function movedScopes(seen: LiveVersions, now: LiveVersions): LiveScope[] {
  return liveScopes.filter((s) => newer(now[s], seen[s]));
}

/** The newer of each scope's version: what a page has caught up to. */
export function latestVersions(a: LiveVersions, b: Partial<LiveVersions>): LiveVersions {
  const out = { ...a };
  for (const s of liveScopes) {
    const v = b[s];
    if (v !== undefined && /^\d+$/.test(v) && newer(v, out[s])) out[s] = v;
  }
  return out;
}

/**
 * What a check that saw `moved` should do on this page: re-render it (which
 * also brings new badges), only fetch the badges, or nothing.
 */
export function liveAction(moved: LiveScope[], pathname: string): "refresh" | "badges" | "none" {
  if (!moved.length) return "none";
  const shown = pageScopes(pathname);
  if (moved.some((s) => shown.includes(s))) return "refresh";
  if (moved.some((s) => badgeScopes.includes(s))) return "badges";
  return "none";
}
