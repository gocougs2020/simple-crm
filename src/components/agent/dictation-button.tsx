"use client";

import { useEffect, useRef } from "react";
import { ArrowPathIcon, MicrophoneIcon, StopIcon } from "@heroicons/react/24/outline";
import { useDictation } from "@/components/dictation/use-dictation";
import { LiveBars } from "@/components/ui/live-bars";

export type DictationState = { recording: boolean; transcribing: boolean };

/** The assistant composer's microphone: record, then the speech-to-text model fills in the message. */
export function DictationButton({ disabled, active, onTranscript, onStateChange, onError }: { disabled?: boolean; active: boolean; onTranscript: (text: string) => void; onStateChange: (s: DictationState) => void; onError: (message: string) => void }) {
  const { phase, level, start, stop } = useDictation({ active, onText: onTranscript, onError });
  const stateChange = useRef(onStateChange);
  useEffect(() => {
    stateChange.current = onStateChange;
  }, [onStateChange]);
  useEffect(() => {
    stateChange.current({ recording: phase === "recording", transcribing: phase === "transcribing" });
  }, [phase]);

  const btn = "inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-sunken hover:text-primary disabled:opacity-50";
  if (phase === "transcribing")
    return (
      <button type="button" className={btn} disabled aria-label="Transcribing">
        <ArrowPathIcon className="size-4 animate-spin" aria-hidden />
      </button>
    );
  if (phase === "recording")
    return (
      <span className="inline-flex items-center gap-1">
        <LiveBars active energetic={false} levelRef={level} tone="dictation" />
        <button type="button" className="inline-flex size-8 items-center justify-center rounded-full bg-error-surface text-error" aria-label="Stop recording" title="Stop recording" onClick={stop}>
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
