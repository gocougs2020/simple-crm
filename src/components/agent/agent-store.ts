"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the agent panel is open, from anywhere: its button, the command
 * palette, or a page that wants to ask something ("Ask the agent about
 * this client"). `prompt` fills the composer without sending. `voice` is
 * whether a voice chat is on, which keeps going while the panel is minimized.
 */
type State = { open: boolean; prompt: string | null; seq: number; voice: boolean };
let state: State = { open: false, prompt: null, seq: 0, voice: false };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function openAssistant(prompt?: string) {
  state = { ...state, open: true, prompt: prompt ?? null, seq: state.seq + 1 };
  emit();
}

export function closeAssistant() {
  state = { ...state, open: false, prompt: null };
  emit();
}

/** The panel says when a voice chat starts and ends, so its buttons can show one is still on. */
export function setAssistantVoice(voice: boolean) {
  if (state.voice === voice) return;
  state = { ...state, voice };
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
