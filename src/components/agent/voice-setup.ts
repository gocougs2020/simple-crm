"use client";

import { voiceSetupFresh, type VoiceSetup } from "@/lib/agent/voice";

/**
 * Voice chat's setup (token, tools, instructions), fetched as soon as the
 * teammate points at "Start voice chat" so the click only has to open the
 * microphone and the socket. One setup at a time; the token is single use, so
 * starting a call takes it and the next call fetches a new one.
 */

let entry: { at: number; page: string; expiresAt?: number; promise: Promise<VoiceSetup> } | null = null;

async function fetchSetup(page: string): Promise<VoiceSetup> {
  const res = await fetch("/api/agent/voice/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ page }) });
  const data = (await res.json().catch(() => ({}))) as Partial<VoiceSetup> & { message?: string };
  if (!res.ok || !data.token || !data.url || typeof data.instructions !== "string") throw new Error(data.message || "Voice chat couldn't start. Try again in a moment.");
  return data as VoiceSetup;
}

/** Starts fetching the setup for this page, unless a fresh one is already on its way. */
export function prefetchVoiceSetup(page: string) {
  if (voiceSetupFresh(entry, page, Date.now())) return entry!.promise;
  const current: NonNullable<typeof entry> = { at: Date.now(), page, promise: fetchSetup(page) };
  entry = current;
  current.promise.then(
    (s) => {
      current.expiresAt = s.expiresAt;
    },
    () => {
      if (entry === current) entry = null;
    },
  );
  return current.promise;
}

/** The setup for a call that's starting now: the prefetched one if it's still good, else a new one. */
export function takeVoiceSetup(page: string) {
  const promise = prefetchVoiceSetup(page);
  entry = null;
  return promise;
}
