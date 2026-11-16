"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createAudioContext, levelFromTimeDomain } from "@/lib/agent/voice";

export type DictationPhase = "idle" | "recording" | "transcribing";

/** Sends a recording to the speech-to-text model (Grok STT through AI Gateway) and returns its text. */
export async function transcribe(blob: Blob) {
  const form = new FormData();
  form.append("file", blob, `dictation.${blob.type.includes("mp4") ? "m4a" : "webm"}`);
  const res = await fetch("/api/agent/transcribe", { method: "POST", body: form });
  const data = (await res.json().catch(() => ({}))) as { text?: string; message?: string };
  if (!res.ok) throw new Error(data.message || "Your recording couldn't be transcribed. Try again, or type instead.");
  return data.text ?? "";
}

/**
 * Record from the microphone, then transcribe. Shared by the assistant's
 * composer and the activity editors. `level` is the mic level (a ref, read
 * every frame by LiveBars). Unmounting, or `active` turning false, throws
 * away a recording in progress, even one still waiting on the permission prompt.
 */
export function useDictation({ active = true, onText, onError }: { active?: boolean; onText: (text: string) => void; onError: (message: string) => void }) {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const keep = useRef(true);
  const level = useRef(0);
  const meter = useRef<{ ctx: AudioContext; raf: number } | null>(null);
  const generation = useRef(0);
  const starting = useRef(false);
  const callbacks = useRef({ onText, onError });
  useEffect(() => {
    callbacks.current = { onText, onError };
  }, [onText, onError]);

  const stopMeter = useCallback(() => {
    const m = meter.current;
    meter.current = null;
    level.current = 0;
    if (!m) return;
    cancelAnimationFrame(m.raf);
    if (m.ctx.state !== "closed") void m.ctx.close();
  }, []);
  const release = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }, []);
  const cancel = useCallback(() => {
    generation.current += 1;
    keep.current = false;
    const r = recorder.current;
    if (r && r.state !== "inactive") {
      r.onstop = null;
      r.stop();
    }
    recorder.current = null;
    chunks.current = [];
    release();
    stopMeter();
    setPhase((p) => (p === "recording" ? "idle" : p));
  }, [release, stopMeter]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- closing the panel or form stops a recording in progress
    if (!active) cancel();
  }, [active, cancel]);
  useEffect(() => cancel, [cancel]);

  const start = useCallback(async () => {
    if (starting.current || recorder.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return callbacks.current.onError("This browser can't record audio. Type instead.");
    starting.current = true;
    const gen = generation.current;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (gen !== generation.current) return s.getTracks().forEach((t) => t.stop());
      stream.current = s;
      const ctx = createAudioContext();
      if (ctx) {
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.82;
        ctx.createMediaStreamSource(s).connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        const m = { ctx, raf: 0 };
        const loop = () => {
          analyser.getByteTimeDomainData(data);
          level.current = levelFromTimeDomain(data);
          m.raf = requestAnimationFrame(loop);
        };
        m.raf = requestAnimationFrame(loop);
        meter.current = m;
      }
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
      const r = mimeType ? new MediaRecorder(s, { mimeType }) : new MediaRecorder(s);
      chunks.current = [];
      r.ondataavailable = (e) => {
        if (e.data?.size) chunks.current.push(e.data);
      };
      r.onstop = async () => {
        const shouldSend = keep.current;
        keep.current = true;
        release();
        stopMeter();
        const blob = new Blob(chunks.current, { type: r.mimeType || "audio/webm" });
        chunks.current = [];
        recorder.current = null;
        if (!shouldSend || !blob.size) return setPhase("idle");
        setPhase("transcribing");
        try {
          const text = (await transcribe(blob)).trim();
          if (text) callbacks.current.onText(text);
          else callbacks.current.onError("Nothing was heard. Try again a little closer to the microphone.");
        } catch (err) {
          callbacks.current.onError(err instanceof Error ? err.message : "Your recording couldn't be transcribed.");
        } finally {
          setPhase("idle");
        }
      };
      keep.current = true;
      recorder.current = r;
      r.start();
      setPhase("recording");
    } catch {
      release();
      stopMeter();
      recorder.current = null;
      if (gen === generation.current) callbacks.current.onError("Allow microphone access in your browser to dictate.");
    } finally {
      starting.current = false;
    }
  }, [release, stopMeter]);

  const stop = useCallback(() => {
    keep.current = true;
    if (recorder.current?.state === "recording") recorder.current.stop();
  }, []);

  return { phase, level, start, stop, cancel };
}
