"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { appConfig } from "@/app.config";
import { liveCheckDue } from "@/lib/live-rules";

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
 *   so the database can sleep.
 */
export function LiveUpdates() {
  const router = useRouter();
  const state = useRef({ version: null as string | null, lastCheck: 0, lastActive: 0, inFlight: false, again: false });

  useEffect(() => {
    const s = state.current;
    const { pollSeconds, idleMinutes } = appConfig.live;
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
        if (before !== null && before !== v) router.refresh();
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
      pollSeconds > 0
        ? window.setInterval(() => {
            if (liveCheckDue({ now: Date.now(), lastCheck: s.lastCheck, lastActive: s.lastActive, visible: document.visibilityState === "visible", pollSeconds, idleMinutes })) void check();
          }, 5_000)
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
  }, [router]);

  return null;
}
