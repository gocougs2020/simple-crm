"use client";

import { MicrophoneIcon, StopIcon } from "@heroicons/react/24/outline";
import { useApp } from "@/components/app-context";
import { Spinner } from "@/components/ui/button";
import { LiveBars } from "@/components/ui/live-bars";
import { toast } from "@/components/ui/toast";
import { useDictation } from "./use-dictation";

/**
 * A microphone for a text box's toolbar. Click to record (it turns into a
 * stop button, with a live waveform and "Listening…"), click stop to
 * transcribe ("Transcribing…"), and the text goes to `onText`. Uses the
 * speech-to-text model through AI Gateway, so it hides itself when dictation
 * is off on the deployment (`agent.dictation`) or there's no AI Gateway access.
 */
export function Dictation({ onText, disabled }: { onText: (text: string) => void; disabled?: boolean }) {
  const { services } = useApp();
  const { phase, level, start, stop } = useDictation({ onText, onError: (m) => toast.error(m) });
  if (!services.ai.dictation) return null;

  if (phase === "transcribing")
    return (
      <span className="inline-flex h-7 items-center gap-1.5 px-1.5 text-[12.5px] text-muted" role="status">
        <Spinner className="size-3.5" />
        Transcribing…
      </span>
    );
  if (phase === "recording")
    return (
      <span className="inline-flex h-7 items-center gap-1.5 pl-1.5" role="status">
        <LiveBars active energetic={false} levelRef={level} tone="dictation" />
        <span className="text-[12.5px] text-secondary">Listening…</span>
        <button type="button" onClick={stop} className="inline-flex size-7 items-center justify-center rounded-md bg-error-surface text-error hover:bg-error-surface/80" aria-label="Stop and transcribe" title="Stop and transcribe">
          <StopIcon className="size-3.5" aria-hidden />
        </button>
      </span>
    );
  return (
    <button type="button" onClick={() => void start()} disabled={disabled} className="inline-flex size-7 items-center justify-center rounded-md text-faint transition-colors hover:bg-sunken hover:text-secondary disabled:opacity-50" aria-label="Dictate" title="Dictate">
      <MicrophoneIcon className="size-4" aria-hidden />
    </button>
  );
}
