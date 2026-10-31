import { Suspense } from "react";
import { AppProvider } from "@/components/app-context";
import { AppShell } from "@/components/shell/app-shell";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/menu";
import { requireUser, toViewer } from "@/lib/auth";
import { myDueCounts } from "@/lib/crm/activities";
import { getAppData } from "@/lib/crm/context";

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
  const due = await myDueCounts(user.id, data.workspace.timezone);
  return (
    <AppProvider data={data} viewer={toViewer(user)}>
      <TooltipProvider delayDuration={300}>
        <AppShell due={due}>{children}</AppShell>
        <Toaster />
      </TooltipProvider>
    </AppProvider>
  );
}
