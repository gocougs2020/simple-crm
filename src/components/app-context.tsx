"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Viewer } from "@/lib/auth";
import type { Comms } from "@/lib/comms";
import type { AppData, Pipeline, Stage, TeamMember } from "@/lib/crm/context";
import { formatMoney } from "@/lib/format";
import { roleCan } from "@/lib/permissions";

type Ctx = AppData & {
  /** The zone set in Settings → Workspace. Scheduled jobs run in it; `workspace.timezone` is the viewer's own zone, for showing times. */
  workspaceTimezone: string;
  viewer: Viewer;
  /** What the viewer can call, text and email from (src/lib/comms.ts). */
  comms: Comms;
  member: (id: string | null | undefined) => TeamMember | undefined;
  stage: (id: string) => (Stage & { pipeline: Pipeline }) | undefined;
  money: (cents: number, opts?: { compact?: boolean }) => string;
  isAdmin: boolean;
  /** Whether the viewer's role can change records (viewers can't). The server checks too; this only hides controls. */
  canEdit: boolean;
  apiKey: (id: string | null | undefined) => AppData["apiKeys"][number] | undefined;
};

const AppContext = createContext<Ctx | null>(null);

/** Team, pipelines, custom fields and the signed-in viewer, available to every client component. */
const noComms: Comms = { phone: false, numbers: [], defaultNumberId: null, texting: false, calling: false, microsoft: false, mailbox: null };

export function AppProvider({ data, viewer, comms = noComms, timezone, children }: { data: AppData; viewer: Viewer; comms?: Comms; /** The viewer's time zone (src/lib/time-zone.ts). */ timezone?: string; children: ReactNode }) {
  const value = useMemo<Ctx>(() => {
    const members = new Map(data.team.map((m) => [m.id, m]));
    const stages = new Map(data.pipelines.flatMap((p) => p.stages.map((s) => [s.id, { ...s, pipeline: p }] as const)));
    const keys = new Map(data.apiKeys.map((k) => [k.id, k]));
    return {
      ...data,
      // Every time on screen is in the viewer's own zone; the workspace's stays available for what runs on its clock.
      workspace: { ...data.workspace, timezone: timezone ?? data.workspace.timezone },
      workspaceTimezone: data.workspace.timezone,
      viewer,
      comms,
      member: (id) => (id ? members.get(id) : undefined),
      stage: (id) => stages.get(id),
      money: (cents, opts) => formatMoney(cents, data.workspace.currency, opts),
      isAdmin: viewer.role === "owner" || viewer.role === "admin",
      canEdit: roleCan(viewer.role, "records:write"),
      apiKey: (id) => (id ? keys.get(id) : undefined),
    };
  }, [data, viewer, comms, timezone]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}
