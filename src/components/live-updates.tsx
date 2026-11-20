"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";
import { appConfig } from "@/app.config";
import { liveCheckDue } from "@/lib/live-rules";
import { watchArrivals } from "./live-highlight";

const CHANGED_EVENT = "crm:changed";

/**
 * Something on this page may be out of date (the agent just changed a
 * record, say): check now and refresh if anything moved. Safe to call often:
 * calls while a check is under way share one follow-up request.
 */
export function checkForChanges() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGED_EVENT));
}

/**
 * Keeps open pages current without a reload. It asks /api/live for the
 * newest change's version and calls router.refresh() when it moved, which
 * re-renders the page and the sidebar counts on the server while keeping
 * whatever is typed or open in the browser. It asks:
 * - right away when checkForChanges() is called (after the agent acts),
 * - when the tab comes back into view or the window regains focus,
 * - every `live.pollSeconds` while the tab is visible and someone clicked or
 *   typed in the last `live.idleMinutes`; a tab left open overnight stops,
 *   so the database can sleep. The team chat asks every `live.chatPollSeconds`
 *   instead, so messages show up quickly.
 * What a refresh adds or changes on the page glows for a moment (live-highlight.ts),
 * so the agent's work is seen as it lands.
 */
export function LiveUpdates() {
  const router = useRouter();
  const pathname = usePathname();
  const state = useRef({ version: null as string | null, lastCheck: 0, lastActive: 0, inFlight: false, again: false });
  const { pollSeconds: everyPage, chatPollSeconds } = appConfig.live;
  const pollRef = useRef(everyPage);
  // While a refresh is on its way, what it changes in the page is highlighted.
  const [refreshing, startRefresh] = useTransition();
  const refreshRef = useRef(startRefresh);
  const stopWatching = useRef<(() => void) | null>(null);
  useEffect(() => {
    refreshRef.current = startRefresh;
  });
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
        const { v } = (await res.json()) as { v?: string };
        if (typeof v !== "string") return;
        const before = s.version;
        s.version = v;
        if (before !== null && before !== v) refreshRef.current(() => router.refresh());
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
    const active = () => {
      const wasIdle = Date.now() - s.lastActive > idleMinutes * 60_000;
      s.lastActive = Date.now();
      if (wasIdle) soon();
    };

    void check();
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
    window.addEventListener("pointerdown", active, { passive: true });
    window.addEventListener("keydown", active);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", soon);
      window.removeEventListener("focus", soon);
      window.removeEventListener(CHANGED_EVENT, onChanged);
      window.removeEventListener("pointerdown", active);
      window.removeEventListener("keydown", active);
    };
  }, [router, everyPage, chatPollSeconds]);

  return null;
}
