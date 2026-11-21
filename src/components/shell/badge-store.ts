"use client";

import { useSyncExternalStore } from "react";
import type { SidebarCounts } from "@/lib/sidebar-counts";

/**
 * The sidebar's badges when they were fetched on their own (a team chat
 * message or a conversation changed, but nothing the page shows). A page
 * render brings fresh counts with it and clears this (AppShell).
 */
let current: SidebarCounts | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setBadges(counts: SidebarCounts | null) {
  current = counts;
  emit();
}

let inFlight: Promise<void> | null = null;
/** Fetches the badges (one small statement) and shows them, without re-rendering the page. */
export function refreshBadges() {
  inFlight ??= fetch("/api/live/badges", { cache: "no-store" })
    .then(async (res) => {
      if (res.ok) setBadges((await res.json()) as SidebarCounts);
    })
    .catch(() => {})
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function useBadgeOverride() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => null,
  );
}
