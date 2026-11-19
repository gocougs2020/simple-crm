"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useApp } from "@/components/app-context";
import { TIME_ZONE_COOKIE } from "@/lib/time-zone";

/**
 * Tells the server this browser's time zone, so times show in the teammate's
 * own zone. The first visit (or one after travelling) renders in the zone the
 * server knew, then refreshes once in the right one.
 */
export function TimeZoneSync() {
  const { workspace } = useApp();
  const router = useRouter();
  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz || tz === workspace.timezone) return;
    const saved = `${TIME_ZONE_COOKIE}=${encodeURIComponent(tz)}`;
    document.cookie = `${saved}; path=/; max-age=31536000; samesite=lax${location.protocol === "https:" ? "; secure" : ""}`;
    // Refresh only if the cookie stuck (a browser that blocks cookies keeps the workspace's zone), and once per tab per zone.
    if (!document.cookie.split("; ").includes(saved)) return;
    try {
      if (sessionStorage.getItem(TIME_ZONE_COOKIE) === tz) return;
      sessionStorage.setItem(TIME_ZONE_COOKIE, tz);
    } catch {
      // Storage blocked: the cookie check above already stops a loop.
    }
    router.refresh();
  }, [workspace.timezone, router]);
  return null;
}
