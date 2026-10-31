"use client";

import { useSyncExternalStore } from "react";

/**
 * Which quick-create dialog is open, from anywhere: the sidebar's New menu,
 * the command palette, an empty state, or a "+" in a board column. Defaults
 * prefill the form (a deal created from a person's page starts linked to them).
 */
export type CreateRequest =
  | { kind: "person"; defaults?: { organizationId?: string; organizationName?: string; firstName?: string } }
  | { kind: "organization"; defaults?: { name?: string } }
  | { kind: "deal"; defaults?: { stageId?: string; pipelineId?: string; personId?: string; personName?: string; organizationId?: string; organizationName?: string; title?: string } }
  | null;

let current: CreateRequest = null;
const listeners = new Set<() => void>();

export function openCreate(req: CreateRequest) {
  current = req;
  listeners.forEach((l) => l());
}

export function useCreateRequest() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => null,
  );
}
