"use client";

import { useSyncExternalStore } from "react";
import type { Call, Device } from "@twilio/voice-sdk";
import { refreshCallToken, startCall } from "@/actions/phone";

/**
 * The one call this browser is on. Any "Call" button starts it; the call
 * panel (mounted once in the app layout) shows it and survives navigating
 * between records, so notes can be written while moving around the CRM.
 */

export type CallPhase = "idle" | "connecting" | "ringing" | "live" | "ended";

export type CallState = {
  phase: CallPhase;
  callId: string | null;
  name: string;
  to: string;
  from: string;
  /** When the other side answered, for the timer. */
  answeredAt: number | null;
  endedAt: number | null;
  muted: boolean;
  error: string | null;
  /** The record the call is about, to link back to. */
  href: string | null;
};

export type CallRequest = {
  phoneNumberId: string;
  name: string;
  to?: string | null;
  personId?: string | null;
  organizationId?: string | null;
  clientId?: string | null;
};

const idle: CallState = { phase: "idle", callId: null, name: "", to: "", from: "", answeredAt: null, endedAt: null, muted: false, error: null, href: null };
let state: CallState = idle;
let device: Device | null = null;
let call: Call | null = null;
const listeners = new Set<() => void>();

function set(patch: Partial<CallState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useCall() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => idle,
  );
}

const busy = () => state.phase === "connecting" || state.phase === "ringing" || state.phase === "live";

/** Bumped by every new call and every hang-up, so a call still being set up knows it was cancelled. */
let attempt = 0;

/** Places a call from the browser. Asks for the microphone the first time. */
export async function placeCall(req: CallRequest) {
  if (busy()) return { ok: false as const, error: "You're already on a call. Hang up first." };
  const href = req.clientId ? `/clients/${req.clientId}` : req.personId ? `/people/${req.personId}` : req.organizationId ? `/organizations/${req.organizationId}` : null;
  const mine = ++attempt;
  const cancelled = () => mine !== attempt;
  set({ ...idle, phase: "connecting", name: req.name, to: req.to ?? "", href });
  const r = await startCall({ phoneNumberId: req.phoneNumberId, to: req.to, personId: req.personId, organizationId: req.organizationId, clientId: req.clientId });
  // Hung up while the server was preparing it: never dial.
  if (cancelled()) return { ok: false as const, error: "The call was cancelled." };
  if (!r.ok) {
    set({ phase: "ended", error: r.error, endedAt: Date.now() });
    return r;
  }
  set({ callId: r.data.callId, to: r.data.to, from: r.data.from });
  try {
    const { Device: VoiceDevice, Call: VoiceCall } = await import("@twilio/voice-sdk");
    if (!device) {
      device = new VoiceDevice(r.data.token, { codecPreferences: [VoiceCall.Codec.Opus, VoiceCall.Codec.PCMU], closeProtection: "You're on a call. Leaving ends it." });
      device.on("tokenWillExpire", async () => {
        const fresh = await refreshCallToken();
        if (fresh.ok) device?.updateToken(fresh.data.token);
      });
    } else device.updateToken(r.data.token);
    if (cancelled()) return { ok: false as const, error: "The call was cancelled." };
    const placed = await device.connect({ params: { callId: r.data.callId } });
    // Hung up while the browser was connecting: drop the call that just started.
    if (cancelled()) {
      placed.disconnect();
      return { ok: false as const, error: "The call was cancelled." };
    }
    call = placed;
    call.on("ringing", () => set({ phase: "ringing" }));
    call.on("accept", () => set({ phase: "live", answeredAt: Date.now() }));
    call.on("mute", (muted: boolean) => set({ muted }));
    const end = (error?: string) => {
      call = null;
      set({ phase: "ended", endedAt: Date.now(), error: error ?? state.error });
    };
    call.on("disconnect", () => end());
    call.on("cancel", () => end());
    call.on("reject", () => end());
    call.on("error", (e: { message?: string; code?: number }) => end(e.code === 31401 || e.code === 31208 ? "The browser couldn't use your microphone. Allow it in the address bar and try again." : (e.message ?? "The call dropped.")));
    return { ok: true as const };
  } catch (err) {
    call = null;
    if (cancelled()) return { ok: false as const, error: "The call was cancelled." };
    const message = err instanceof Error && /permission|notallowed/i.test(err.message) ? "The browser couldn't use your microphone. Allow it in the address bar and try again." : "The call couldn't start. Check your connection and try again.";
    set({ phase: "ended", error: message, endedAt: Date.now() });
    return { ok: false as const, error: message };
  }
}

export function hangUp() {
  if (call) call.disconnect();
  else if (busy()) {
    // Still being set up: cancel it, so it never dials.
    attempt++;
    set({ phase: "ended", endedAt: Date.now() });
  }
}

export function toggleMute() {
  call?.mute(!state.muted);
}

export function sendDigits(digits: string) {
  call?.sendDigits(digits);
}

/** Closes the panel after a call. */
export function dismissCall() {
  if (busy()) return;
  state = idle;
  listeners.forEach((l) => l());
}
