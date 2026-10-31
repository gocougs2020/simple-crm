"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Viewer } from "@/lib/auth";
import type { AppData, Pipeline, Stage, TeamMember } from "@/lib/crm/context";
import { formatMoney } from "@/lib/format";

type Ctx = AppData & {
  viewer: Viewer;
  member: (id: string | null | undefined) => TeamMember | undefined;
  stage: (id: string) => (Stage & { pipeline: Pipeline }) | undefined;
  money: (cents: number, opts?: { compact?: boolean }) => string;
  isAdmin: boolean;
};

const AppContext = createContext<Ctx | null>(null);

/** Team, pipelines, custom fields and the signed-in viewer, available to every client component. */
export function AppProvider({ data, viewer, children }: { data: AppData; viewer: Viewer; children: ReactNode }) {
  const value = useMemo<Ctx>(() => {
    const members = new Map(data.team.map((m) => [m.id, m]));
    const stages = new Map(data.pipelines.flatMap((p) => p.stages.map((s) => [s.id, { ...s, pipeline: p }] as const)));
    return {
      ...data,
      viewer,
      member: (id) => (id ? members.get(id) : undefined),
      stage: (id) => stages.get(id),
      money: (cents, opts) => formatMoney(cents, data.workspace.currency, opts),
      isAdmin: viewer.role === "owner" || viewer.role === "admin",
    };
  }, [data, viewer]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}
