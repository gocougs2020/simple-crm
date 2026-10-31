"use client";

import { useSyncExternalStore } from "react";
import { Dialog } from "@/components/ui/dialog";
import { ScheduleNext } from "./schedule-next";

type Request = { dealId: string; title: string } | null;
let current: Request = null;
const listeners = new Set<() => void>();

/** Asks for a deal's next step after its last planned activity is checked off, wherever that happened. */
export function askNextStep(req: Request) {
  current = req;
  listeners.forEach((l) => l());
}

export function NextStepDialog() {
  const req = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => null,
  );
  if (!req) return null;
  return (
    <Dialog open onOpenChange={(o) => !o && askNextStep(null)} title="What's next?" description={req.title} size="md">
      <ScheduleNext dealId={req.dealId} compact onDone={() => askNextStep(null)} />
    </Dialog>
  );
}
