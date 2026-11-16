import type { Experimental_RealtimeSessionConfig } from "ai";

/**
 * Voice chat helpers for the browser: the 5-minute cap, the 30-second
 * silence timeout, and the audio-context workarounds for Safari and Chrome
 * autoplay rules. Pure where possible (tested).
 */

const SAMPLE_RATE = 24_000;

/** Mic level that counts as the teammate talking. */
export const VOICE_SPEAK_LEVEL = 0.22;
/** Hard cap for one call, from when the socket is ready. */
export const VOICE_MAX_SESSION_MS = 5 * 60 * 1000;
/** After the assistant finishes speaking, this much silence ends the call. */
export const VOICE_USER_SILENCE_MS = 30 * 1000;
/** Brief gaps between playback chunks don't start the silence clock. */
export const VOICE_PLAYBACK_SETTLE_MS = 600;

export const VOICE_MIC_CONSTRAINTS: MediaStreamConstraints = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };

export const VOICE_GREETINGS = ["Hi, how can I help?", "Hello, what can I do for you?", "Hey, what do you need?"];

export function pickGreeting(random: () => number = Math.random) {
  const i = Math.min(VOICE_GREETINGS.length - 1, Math.max(0, Math.floor(Number(random()) * VOICE_GREETINGS.length)));
  return VOICE_GREETINGS[i];
}

/** Hidden cue: the model says the greeting; it isn't saved into the thread. */
export const greetingCue = (greeting: string) => `The teammate just connected. Say exactly this sentence, don't call any tools, then wait: ${greeting}`;
export const isGreetingCue = (text: string) => text.startsWith("The teammate just connected.");

/** Speech to speech: audio in, audio out, the server decides when a turn ends. */
export function voiceSessionConfig(instructions: string): Partial<Experimental_RealtimeSessionConfig> {
  const format = { type: "audio/pcm", rate: SAMPLE_RATE };
  return {
    instructions,
    outputModalities: ["audio"],
    inputAudioFormat: format,
    outputAudioFormat: format,
    turnDetection: { type: "server-vad" },
  } as Partial<Experimental_RealtimeSessionConfig>;
}

/** 0–1 mic level from an analyser's time-domain samples (silence is 128). */
export function levelFromTimeDomain(data: Uint8Array | null | undefined) {
  if (!data || data.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const s = ((data[i] ?? 128) - 128) / 128;
    sum += s * s;
  }
  return Math.min(1, Math.sqrt(sum / data.length) / 0.11);
}

export const sessionExpired = (connectedAt: number | null, now: number | null, limit = VOICE_MAX_SESSION_MS) => connectedAt != null && now != null && now - connectedAt >= limit;

export type VoiceEndReason = "max-duration" | "silence" | undefined;

export function endMessage(reason: VoiceEndReason) {
  if (reason === "max-duration") return "Voice chat ended after 5 minutes. What was said is saved in this chat.";
  if (reason === "silence") return "Voice chat ended after 30 seconds of quiet. What was said is saved in this chat.";
  return "";
}

export type SilenceClock = { assistantHasSpoken: boolean; quietSince: number | null; silenceStartedAt: number | null; reason: "silence" | null };

/** The listening-gap clock: `reason: "silence"` ends the call. */
export function reduceSilenceClock(state: SilenceClock | null, { now, assistantSpeaking = false, userSpeaking = false, responseInProgress = false }: { now: number; assistantSpeaking?: boolean; userSpeaking?: boolean; responseInProgress?: boolean }): SilenceClock {
  const current = state ?? { assistantHasSpoken: false, quietSince: null, silenceStartedAt: null, reason: null };
  if (current.reason) return current;
  if (assistantSpeaking) return { assistantHasSpoken: true, quietSince: null, silenceStartedAt: null, reason: null };
  if (!current.assistantHasSpoken) return current;
  const quietSince = current.quietSince ?? now;
  if (now - quietSince < VOICE_PLAYBACK_SETTLE_MS) return { ...current, quietSince, silenceStartedAt: null, reason: null };
  if (userSpeaking || responseInProgress) return { ...current, quietSince, silenceStartedAt: null, reason: null };
  const silenceStartedAt = current.silenceStartedAt ?? now;
  return { ...current, quietSince, silenceStartedAt, reason: now - silenceStartedAt >= VOICE_USER_SILENCE_MS ? "silence" : null };
}

export type VoiceDialogue = { phase: "error" | "connecting" | "assistant" | "user" | "listening"; label: string; speaker: "assistant" | "user" | null };

/** Who the voice stage shows. The assistant's playback wins over the mic. */
export function dialogueState({ status, isPlaying, userSpeaking, name }: { status?: string; isPlaying?: boolean; userSpeaking?: boolean; name: string }): VoiceDialogue {
  if (status === "error") return { phase: "error", label: "Voice chat disconnected", speaker: null };
  if (status !== "connected") return { phase: "connecting", label: "Connecting…", speaker: null };
  if (isPlaying) return { phase: "assistant", label: `${name} is speaking`, speaker: "assistant" };
  if (userSpeaking) return { phase: "user", label: "You're speaking", speaker: "user" };
  return { phase: "listening", label: "Listening", speaker: "user" };
}

const SETTLED_TOOL_STATES = new Set(["output-available", "output-error", "output-denied"]);
type Part = { type?: string; toolName?: string; state?: string };

/** A tool is still running, so a pause isn't a listening gap yet. */
export function responseInProgress(messages: { role?: string; parts?: unknown }[] | null | undefined) {
  if (!Array.isArray(messages)) return false;
  return messages.some(
    (m) => m?.role === "assistant" && Array.isArray(m.parts) && (m.parts as Part[]).some((p) => (p.type === "dynamic-tool" || p.type?.startsWith("tool-")) && !SETTLED_TOOL_STATES.has(String(p.state))),
  );
}

// ─── Audio contexts (browser only) ───────────────────────────────────────

type AudioContextCtor = typeof AudioContext;
type AudioWindow = { AudioContext?: AudioContextCtor & { __crmVoiceResume?: boolean }; webkitAudioContext?: AudioContextCtor & { __crmVoiceResume?: boolean } };

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as AudioWindow;
  return w.AudioContext || w.webkitAudioContext || null;
}

export function createAudioContext(): AudioContext | null {
  const Ctx = audioContextCtor();
  return Ctx ? new Ctx() : null;
}

let primed: AudioContext | null = null;

/** Call from the click that starts voice chat, before any await, so playback is allowed later. */
export function primeAudio() {
  const Ctx = audioContextCtor();
  if (!Ctx) return;
  if (!primed || primed.state === "closed") primed = new Ctx();
  primed.resume?.().catch(() => {});
}

/**
 * Audio contexts made after the click start suspended, so capture never
 * emits samples. While a call is up, resume each one the realtime hook makes.
 */
export function installAudioResume() {
  if (typeof window === "undefined") return () => {};
  const w = window as unknown as AudioWindow;
  const original = w.AudioContext;
  const webkit = w.webkitAudioContext;
  const Base = original || webkit;
  if (!Base || Base.__crmVoiceResume) return () => {};
  function Resumed(this: unknown, ...args: ConstructorParameters<AudioContextCtor>) {
    const ctx = new Base!(...args);
    const resume = () => {
      if (ctx.state === "suspended") ctx.resume?.().catch(() => {});
    };
    resume();
    ctx.addEventListener?.("statechange", resume);
    return ctx;
  }
  Resumed.prototype = Base.prototype;
  (Resumed as unknown as { __crmVoiceResume: boolean }).__crmVoiceResume = true;
  const replacement = Resumed as unknown as AudioContextCtor & { __crmVoiceResume?: boolean };
  if (original) w.AudioContext = replacement;
  if (webkit) w.webkitAudioContext = replacement;
  return () => {
    if (original) w.AudioContext = original;
    if (webkit) w.webkitAudioContext = webkit;
  };
}
