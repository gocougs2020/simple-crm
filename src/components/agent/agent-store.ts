"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the agent panel is open, from anywhere: its button, the command
 * palette, or a page that wants to ask something ("Ask the agent about
 * this client"). `prompt` fills the composer without sending.
 */
type State = { open: boolean; prompt: string | null; seq: number };
let state: State = { open: false, prompt: null, seq: 0 };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function openAssistant(prompt?: string) {
  state = { open: true, prompt: prompt ?? null, seq: state.seq + 1 };
  emit();
}

export function closeAssistant() {
  state = { ...state, open: false, prompt: null };
  emit();
}

export function useAssistantState() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}
