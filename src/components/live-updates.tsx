"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";
import { appConfig } from "@/app.config";
import { latestVersions, liveAction, liveCheckDue, movedScopes, type LiveScope, type LiveVersions } from "@/lib/live-rules";
import { refreshBadges } from "./shell/badge-store";
import { watchArrivals } from "./live-highlight";

const CHANGED_EVENT = "crm:changed";
/** Sent with the scopes that moved, for parts of a page that fetch their own updates (the team chat). */
export const MOVED_EVENT = "crm:moved";
const VERSIONS_EVENT = "crm:versions";

/**
 * Something on this page may be out of date (the agent just changed a
 * record, say): check now and refresh if anything moved. Safe to call often:
 * calls while a check is under way share one follow-up request.
 */
export function checkForChanges() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGED_EVENT));
}

/**
 * Versions read elsewhere (the task panel's list): treated like a check's
 * answer, so what moved refreshes, without asking /api/live again.
 */
export function noteVersions(versions: LiveVersions) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(VERSIONS_EVENT, { detail: { versions, adopt: false } }));
}

/**
 * This page already shows everything up to these versions (it just fetched
 * the newest chat messages itself, say): take them as seen, without refreshing.
 */
export function adoptVersions(versions: Partial<LiveVersions>) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(VERSIONS_EVENT, { detail: { versions, adopt: true } }));
}

/**
 * Keeps open pages current without a reload. It asks /api/live for the
 * newest change in each scope (records, chat, mail; src/lib/live-rules.ts)
 * and refreshes only what shows a scope that moved: the page, with
 * router.refresh(), when it shows it, otherwise just the sidebar's badges.
 * It asks:
 * - right away when checkForChanges() is called (after the agent acts),
 * - when the tab comes back into view or the window regains focus,
 * - every `live.pollSeconds` while the tab is visible and someone clicked or
 *   typed in the last `live.idleMinutes`; a tab left open overnight stops,
 *   so the database can sleep. The team chat asks every `live.chatPollSeconds`
 *   instead, so messages show up quickly.
 *
 * `versions` comes from the app layout on every render, including the one a
 * teammate's own action triggers with refresh(): what's rendered is taken as
 * seen, so the next check doesn't refresh a second time for their own change.
 * What a refresh adds or changes on the page glows for a moment (live-highlight.ts),
 * so the agent's work is seen as it lands.
 */
export function LiveUpdates({ versions }: { versions: LiveVersions }) {
  const router = useRouter();
  const pathname = usePathname();
  const state = useRef({ seen: versions, lastCheck: 0, lastActive: 0, inFlight: false, again: false });
  const pathRef = useRef(pathname);
  const { pollSeconds: everyPage, chatPollSeconds } = appConfig.live;
  const pollRef = useRef(everyPage);
  // While a refresh is on its way, what it changes in the page is highlighted.
  const [refreshing, startRefresh] = useTransition();
  const refreshRef = useRef(startRefresh);
  const stopWatching = useRef<(() => void) | null>(null);
  useEffect(() => {
    refreshRef.current = startRefresh;
    pathRef.current = pathname;
  });
  // A render of the layout: what it shows is seen.
  useEffect(() => {
    state.current.seen = latestVersions(state.current.seen, versions);
  }, [versions]);
  useEffect(() => {
    if (refreshing) {
      const main = document.getElementById("main");
      if (main && !stopWatching.current) stopWatching.current = watchArrivals(main);
      return;
    }
    // The new page has rendered; give its last pieces a moment to land, then stop watching.
    const t = window.setTimeout(() => {
      stopWatching.current?.();
      stopWatching.current = null;
    }, 400);
    return () => window.clearTimeout(t);
  }, [refreshing]);
  // Going to another page changes everything: that's not news.
  useEffect(() => {
    stopWatching.current?.();
    stopWatching.current = null;
  }, [pathname]);
  useEffect(() => {
    pollRef.current = pathname.startsWith("/chat") && chatPollSeconds > 0 ? chatPollSeconds : everyPage;
  }, [pathname, chatPollSeconds, everyPage]);

  useEffect(() => {
    const s = state.current;
    const { idleMinutes } = appConfig.live;
    s.lastActive = Date.now();
    // The layout just rendered with the newest versions: the first check is one interval from now.
    s.lastCheck = Date.now();

    /** What a check found: refresh the page if it shows what moved, else only the badges. */
    const apply = (now: LiveVersions) => {
      const moved: LiveScope[] = movedScopes(s.seen, now);
      s.seen = latestVersions(s.seen, now);
      if (!moved.length) return;
      window.dispatchEvent(new CustomEvent(MOVED_EVENT, { detail: { scopes: moved, versions: now } }));
      const action = liveAction(moved, pathRef.current);
      if (action === "refresh") refreshRef.current(() => router.refresh());
      else if (action === "badges") void refreshBadges();
    };

    const check = async () => {
      if (s.inFlight) {
        s.again = true;
        return;
      }
      s.inFlight = true;
      s.lastCheck = Date.now();
      try {
        const res = await fetch("/api/live", { cache: "no-store" });
        if (!res.ok) return;
        const { versions: now } = (await res.json()) as { versions?: LiveVersions };
        if (now && typeof now === "object") apply(now);
      } catch {
        // Offline or a deploy in progress: the next check catches up.
      } finally {
        s.inFlight = false;
        if (s.again) {
          s.again = false;
          void check();
        }
      }
    };

    const soon = () => {
      if (document.visibilityState === "visible" && Date.now() - s.lastCheck > 1000) void check();
    };
    // A check already under way may have read the version before the change: it runs once more when done.
    const onChanged = () => void check();
    const onVersions = (e: Event) => {
      const { versions: v, adopt } = (e as CustomEvent<{ versions: LiveVersions; adopt: boolean }>).detail;
      if (adopt) s.seen = latestVersions(s.seen, v);
      else apply(latestVersions(s.seen, v));
    };
    const active = () => {
      const wasIdle = Date.now() - s.lastActive > idleMinutes * 60_000;
      s.lastActive = Date.now();
      if (wasIdle) soon();
    };

    const timer =
      everyPage > 0 || chatPollSeconds > 0
        ? window.setInterval(() => {
            const pollSeconds = pollRef.current;
            if (pollSeconds > 0 && liveCheckDue({ now: Date.now(), lastCheck: s.lastCheck, lastActive: s.lastActive, visible: document.visibilityState === "visible", pollSeconds, idleMinutes })) void check();
          }, Math.min(5_000, Math.max(1_000, (chatPollSeconds || 5) * 1000)))
        : 0;

    document.addEventListener("visibilitychange", soon);
    window.addEventListener("focus", soon);
    window.addEventListener(CHANGED_EVENT, onChanged);
    window.addEventListener(VERSIONS_EVENT, onVersions);
    window.addEventListener("pointerdown", active, { passive: true });
    window.addEventListener("keydown", active);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", soon);
      window.removeEventListener("focus", soon);
      window.removeEventListener(CHANGED_EVENT, onChanged);
      window.removeEventListener(VERSIONS_EVENT, onVersions);
      window.removeEventListener("pointerdown", active);
      window.removeEventListener("keydown", active);
    };
  }, [router, everyPage, chatPollSeconds]);

  return null;
}
