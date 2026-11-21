"use client";

import clsx from "clsx";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { MicrophoneIcon, PhoneXMarkIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { callState, saveCallNotes } from "@/actions/phone";
import { Button } from "@/components/ui/button";
import { RichText, type RichTextHandle } from "@/components/ui/rich-text";
import { toast } from "@/components/ui/toast";
import { formatPhone } from "@/lib/phone/numbers";
import { dismissCall, hangUp, sendDigits, toggleMute, useCall } from "./call-store";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

/**
 * The call in progress, bottom left on every page: who, how long, mute,
 * keypad, hang up, and notes. Notes save onto the call's activity when the
 * call ends (and with Save notes any time), so writing up a call is part of
 * making it.
 */
export function CallPanel() {
  const c = useCall();
  if (c.phase === "idle") return null;
  // Keyed by call, so each call starts with empty notes.
  return <ActiveCall key={c.callId ?? "starting"} />;
}

function ActiveCall() {
  const c = useCall();
  const [notes, setNotes] = useState("");
  const [savedNotes, setSavedNotes] = useState("");
  const [keypad, setKeypad] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const editor = useRef<RichTextHandle>(null);
  const now = useTicker(c.phase === "live");
  const callId = c.callId;

  const save = (body = notes, quiet = false) =>
    start(async () => {
      if (!callId || body === savedNotes) return;
      const r = await saveCallNotes(callId, body);
      if (!r.ok) return void (!quiet && toast.error(r.error));
      setSavedNotes(body);
      if (!quiet) toast.success("Notes saved to the call");
    });

  // When the call ends: save what's written, then show how it went once Twilio has reported.
  const ended = c.phase === "ended";
  useEffect(() => {
    if (!ended || !callId) return;
    if (notes && notes !== savedNotes) save(notes, true);
    let tries = 0;
    const check = async () => {
      const s = await callState(callId);
      if (s && ["completed", "busy", "no-answer", "failed", "canceled"].includes(s.status)) {
        setOutcome(s.status === "completed" && s.durationSeconds ? `Call lasted ${formatDuration(s.durationSeconds)}` : s.status === "busy" ? "Line was busy" : s.status === "no-answer" ? "No answer" : s.status === "failed" ? "The call didn't go through" : "Call ended");
        return;
      }
      if (++tries < 5) timer = setTimeout(check, 1500);
    };
    let timer = setTimeout(check, 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the call ends
  }, [ended, callId]);

  const live = c.phase === "live";
  const elapsed = live && c.answeredAt ? Math.max(0, Math.floor((now - c.answeredAt) / 1000)) : c.answeredAt && c.endedAt ? Math.floor((c.endedAt - c.answeredAt) / 1000) : 0;
  const status = c.phase === "connecting" ? "Connecting…" : c.phase === "ringing" ? "Ringing…" : live ? clock(elapsed) : (outcome ?? (c.error ? "Couldn't call" : "Call ended"));

  return (
    <section
      aria-label="Call"
      className="fixed bottom-[max(1.25rem,env(safe-area-inset-bottom),calc(var(--shell-bottom)+0.75rem))] left-[max(1rem,env(safe-area-inset-left))] lg:bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-40 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-3 rounded-xl border border-line bg-surface p-3.5 shadow-lg lg:left-[calc(232px+1rem)]"
    >
      <header className="flex items-start gap-2">
        <span className={clsx("mt-1.5 size-2 shrink-0 rounded-full", live ? "bg-success" : ended ? "bg-line-strong" : "animate-pulse bg-warning")} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold text-primary">{c.href ? <Link href={c.href} className="hover:underline">{c.name}</Link> : c.name}</p>
          <p className="truncate text-[12.5px] text-muted">
            {c.to ? formatPhone(c.to) : ""}
            {c.from ? ` · from ${formatPhone(c.from)}` : ""}
          </p>
        </div>
        <span className="shrink-0 text-[13px] font-medium text-secondary tabular-nums" aria-live="polite">
          {status}
        </span>
        {ended ? (
          <button type="button" className="-mt-0.5 -mr-1 rounded-md p-1 text-faint hover:bg-sunken hover:text-primary" aria-label="Close" onClick={() => (notes && notes !== savedNotes ? save(notes) : null, dismissCall())}>
            <XMarkIcon className="size-4" />
          </button>
        ) : null}
      </header>
      {c.error ? <p className="text-[12.5px] text-error">{c.error}</p> : null}

      {!ended ? (
        <div className="flex items-center gap-2">
          <Button size="sm" variant={c.muted ? "primary" : "outline"} onClick={toggleMute} disabled={!live} aria-pressed={c.muted}>
            <MicrophoneIcon />
            {c.muted ? "Unmute" : "Mute"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setKeypad(!keypad)} disabled={!live} aria-expanded={keypad}>
            Keypad
          </Button>
          <Button size="sm" variant="destructive" className="ml-auto" onClick={hangUp}>
            <PhoneXMarkIcon />
            Hang up
          </Button>
        </div>
      ) : null}
      {keypad && live ? (
        <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="Keypad">
          {KEYS.map((k) => (
            <button key={k} type="button" onClick={() => sendDigits(k)} className="h-9 rounded-md border border-line text-[15px] font-medium text-primary hover:bg-sunken">
              {k}
            </button>
          ))}
        </div>
      ) : null}

      {c.callId && !(ended && c.error && !c.answeredAt) ? (
        <div className="flex flex-col gap-2">
          <RichText handle={editor} value={notes} onChange={setNotes} minHeight={72} toolbar={false} placeholder="Notes from the call. They save to the call when it ends." dictation />
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-muted">{notes && notes === savedNotes ? "Saved" : ""}</span>
            <Button size="sm" variant={ended ? "primary" : "ghost"} className="ml-auto" loading={pending} disabled={!notes || notes === savedNotes} onClick={() => save()}>
              Save notes
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function clock(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function formatDuration(s: number) {
  return s < 60 ? `${s} sec` : `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} sec` : ""}`.trim();
}

/** The time now, every second while `on`. */
function useTicker(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}
