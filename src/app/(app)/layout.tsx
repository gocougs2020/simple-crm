import { Suspense } from "react";
import { AppProvider } from "@/components/app-context";
import { AppShell } from "@/components/shell/app-shell";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/menu";
import { requireUser, toViewer } from "@/lib/auth";
import { myDueCounts } from "@/lib/crm/activities";
import { getAppData } from "@/lib/crm/context";
import { unreadCount } from "@/lib/email/inbox";
import { commsFor } from "@/lib/comms";
import { unreadTextCount } from "@/lib/conversations/texts";
import { phoneConfigured } from "@/lib/twilio/config";
import { CallPanel } from "@/components/phone/call-panel";

/** Everything inside requires a signed-in, active teammate. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-canvas" />}>
      <Gate>{children}</Gate>
    </Suspense>
  );
}

async function Gate({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const data = await getAppData();
  const [due, unread, unreadTexts, comms] = await Promise.all([
    myDueCounts(user.id, data.workspace.timezone),
    data.services.email ? unreadCount(user.id) : 0,
    phoneConfigured() ? unreadTextCount(user.id) : 0,
    commsFor(user),
  ]);
  return (
    <AppProvider data={data} viewer={toViewer(user)} comms={comms}>
      <TooltipProvider delayDuration={300}>
        <AppShell due={due} unread={unread} unreadTexts={unreadTexts}>{children}</AppShell>
        {comms.calling ? <CallPanel /> : null}
        <Toaster />
      </TooltipProvider>
    </AppProvider>
  );
}
