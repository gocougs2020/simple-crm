"use client";

import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { PhoneXMarkIcon } from "@heroicons/react/24/outline";
import { LiveBars } from "@/components/ui/live-bars";
import { createAudioContext, dialogueState, levelFromTimeDomain, VOICE_SPEAK_LEVEL } from "@/lib/agent/voice";

const QUIET_HOLD_MS = 320;

/** The mic's level (a ref, read every frame) and whether the teammate is talking. */
function useMicActivity(stream: MediaStream | null, enabled: boolean) {
  const levelRef = useRef(0);
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    levelRef.current = 0;
    if (!stream || !enabled) return;
    const ctx = createAudioContext();
    if (!ctx) return;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.7;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    let raf = 0;
    let now = false;
    let quietSince = 0;
    const loop = (t: number) => {
      analyser.getByteTimeDomainData(data);
      const level = levelFromTimeDomain(data);
      levelRef.current = level;
      if (level > VOICE_SPEAK_LEVEL) {
        quietSince = 0;
        if (!now) setSpeaking((now = true));
      } else if (now) {
        quietSince ||= t;
        if (t - quietSince > QUIET_HOLD_MS) {
          quietSince = 0;
          setSpeaking((now = false));
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      source.disconnect();
      analyser.disconnect();
      void ctx.close();
      levelRef.current = 0;
      setSpeaking(false);
    };
  }, [stream, enabled]);
  return { levelRef, speaking: enabled ? speaking : false };
}

/** The voice stage: who's talking, and the button to hang up. Centered on an empty chat, docked above the transcript otherwise. */
export function VoicePresence({ status, isPlaying, stream, error, onEnd, name, layout = "dock" }: { status: string; isPlaying: boolean; stream: MediaStream | null; error: string; onEnd: () => void; name: string; layout?: "dock" | "center" }) {
  const micOn = status === "connected" && !isPlaying;
  const { levelRef, speaking } = useMicActivity(stream, micOn);
  const d = dialogueState({ status, isPlaying, userSpeaking: speaking, name });
  const isUser = d.speaker === "user";
  return (
    <div className={clsx("flex flex-col items-center gap-3 px-3", layout === "center" ? "min-h-48 w-full justify-center py-8" : "border-t border-line bg-sunken/40 py-3")}>
      <p className={clsx("text-[13.5px] font-medium", d.phase === "error" ? "text-error" : "text-primary")} aria-live="polite">
        {d.label}
      </p>
      {d.speaker ? (
        <div
          className={clsx(
            "flex items-center justify-center rounded-full ring-8 ring-accent/10",
            layout === "center" ? "size-32" : "size-20",
            isUser ? "bg-accent text-accent-foreground" : "border-2 border-accent bg-surface",
          )}
        >
          <LiveBars active energetic={!isUser} levelRef={isUser ? levelRef : null} tone={isUser ? "user" : "assistant"} />
        </div>
      ) : null}
      {error ? <p className="text-center text-[12px] text-error">{error}</p> : null}
      <button type="button" onClick={onEnd} className="inline-flex h-9 items-center gap-2 rounded-full border border-line bg-surface px-4 text-[13.5px] font-medium text-primary hover:bg-sunken">
        <PhoneXMarkIcon className="size-4" aria-hidden />
        End voice chat
      </button>
    </div>
  );
}
