import { unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { AppProvider } from "@/components/app-context";
import { AppShell } from "@/components/shell/app-shell";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/menu";
import { requireUser, toViewer } from "@/lib/auth";
import { getAppData } from "@/lib/crm/context";
import { commsFor } from "@/lib/comms";
import { CallPanel } from "@/components/phone/call-panel";
import { LiveUpdates } from "@/components/live-updates";
import { liveVersions } from "@/lib/live";
import { noVersions } from "@/lib/live-rules";
import { TimeZoneSync } from "@/components/time-zone-sync";
import { viewerTimeZone } from "@/lib/viewer-time-zone";
import { noCounts, sidebarCounts } from "@/lib/sidebar-counts";

/** Everything inside requires a signed-in, active teammate. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-canvas" />}>
      <Gate>{children}</Gate>
    </Suspense>
  );
}

async function Gate({ children }: { children: React.ReactNode }) {
  // The session check and the app-wide data start together. A signed-out visitor is redirected
  // here, before anything renders, so none of the data reaches them.
  const data = getAppData();
  // Read before any page data (the page renders after this), so the browser never adopts a version newer than what it shows.
  // If they can't be read, the page still renders; the next check refreshes once.
  const live = liveVersions().catch((err) => {
    // Next's own signals (a prerender ending) pass through; only a real failure falls back.
    unstable_rethrow(err);
    console.error("[live] versions", err);
    return noVersions;
  });
  // A rejection that loses the race with the redirect is dropped here; awaiting below still surfaces it.
  data.catch(() => {});
  const user = await requireUser();
  const [app, versions] = await Promise.all([data, live]);
  const tz = await viewerTimeZone(app.workspace.timezone);
  // The badges don't hold up the shell: the sidebar reads them when they arrive (AppShell).
  // A failed count shows no badge rather than breaking the page.
  const counts = sidebarCounts(user, tz).catch((err) => {
    console.error("[sidebar] counts", err);
    return noCounts;
  });
  const comms = await commsFor(user);
  return (
    <AppProvider data={app} viewer={toViewer(user)} comms={comms} timezone={tz}>
      <TooltipProvider delayDuration={300}>
        <AppShell counts={counts}>{children}</AppShell>
        {comms.calling ? <CallPanel /> : null}
        <LiveUpdates versions={versions} />
        <TimeZoneSync />
        <Toaster />
      </TooltipProvider>
    </AppProvider>
  );
}
