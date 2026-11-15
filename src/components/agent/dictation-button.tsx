"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowPathIcon, MicrophoneIcon, StopIcon } from "@heroicons/react/24/outline";
import { createAudioContext, levelFromTimeDomain } from "@/lib/agent/voice";
import { LiveBars } from "./voice-presence";

export type DictationState = { recording: boolean; transcribing: boolean };

async function transcribe(blob: Blob) {
  const form = new FormData();
  form.append("file", blob, `dictation.${blob.type.includes("mp4") ? "m4a" : "webm"}`);
  const res = await fetch("/api/agent/transcribe", { method: "POST", body: form });
  const data = (await res.json().catch(() => ({}))) as { text?: string; message?: string };
  if (!res.ok) throw new Error(data.message || "Your recording couldn't be transcribed. Try again, or type instead.");
  return data.text ?? "";
}

/** The composer's microphone: record, then the speech-to-text model fills in the message. */
export function DictationButton({ disabled, active, onTranscript, onStateChange, onError }: { disabled?: boolean; active: boolean; onTranscript: (text: string) => void; onStateChange: (s: DictationState) => void; onError: (message: string) => void }) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const keep = useRef(true);
  const level = useRef(0);
  const meter = useRef<{ ctx: AudioContext; raf: number } | null>(null);
  // Bumped on abort: a start still waiting on the permission prompt checks it, so closing the panel never leaves a recorder running.
  const generation = useRef(0);
  const starting = useRef(false);
  const stateChange = useRef(onStateChange);
  useEffect(() => {
    stateChange.current = onStateChange;
  }, [onStateChange]);
  useEffect(() => {
    stateChange.current({ recording, transcribing });
  }, [recording, transcribing]);

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
  const abort = useCallback(() => {
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
    setRecording(false);
  }, [release, stopMeter]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- closing the panel stops a recording in progress
    if (!active) abort();
  }, [active, abort]);
  useEffect(() => abort, [abort]);

  async function start() {
    if (starting.current || recorder.current || transcribing || disabled) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return onError("This browser can't record audio. Type your message instead.");
    starting.current = true;
    const gen = generation.current;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
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
        setRecording(false);
        const shouldSend = keep.current;
        keep.current = true;
        release();
        stopMeter();
        const blob = new Blob(chunks.current, { type: r.mimeType || "audio/webm" });
        chunks.current = [];
        recorder.current = null;
        if (!shouldSend || !blob.size) return;
        setTranscribing(true);
        try {
          const text = (await transcribe(blob)).trim();
          if (text) onTranscript(text);
          else onError("Nothing was heard. Try again a little closer to the microphone.");
        } catch (err) {
          onError(err instanceof Error ? err.message : "Your recording couldn't be transcribed.");
        } finally {
          setTranscribing(false);
        }
      };
      keep.current = true;
      recorder.current = r;
      r.start();
      setRecording(true);
    } catch {
      release();
      stopMeter();
      recorder.current = null;
      if (gen === generation.current) onError("Allow microphone access in your browser to dictate.");
    } finally {
      starting.current = false;
    }
  }

  const btn = "inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-sunken hover:text-primary disabled:opacity-50";
  if (transcribing)
    return (
      <button type="button" className={btn} disabled aria-label="Transcribing">
        <ArrowPathIcon className="size-4 animate-spin" aria-hidden />
      </button>
    );
  if (recording)
    return (
      <span className="inline-flex items-center gap-1">
        <LiveBars active energetic={false} levelRef={level} tone="dictation" />
        <button
          type="button"
          className="inline-flex size-8 items-center justify-center rounded-full bg-error-surface text-error"
          aria-label="Stop recording"
          title="Stop recording"
          onClick={() => {
            keep.current = true;
            recorder.current?.stop();
          }}
        >
          <StopIcon className="size-3.5" aria-hidden />
        </button>
      </span>
    );
  return (
    <button type="button" className={btn} aria-label="Dictate" title="Dictate" disabled={disabled} onClick={() => void start()}>
      <MicrophoneIcon className="size-[18px]" aria-hidden />
    </button>
  );
}
