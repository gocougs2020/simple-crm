"use client";

import { experimental_useRealtime as useRealtime } from "@ai-sdk/react";
import { gateway, type Experimental_RealtimeSessionConfig, type UIMessage } from "ai";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import { appConfig } from "@/app.config";
import { checkForChanges } from "@/components/live-updates";
import {
  createAudioContext,
  greetingCue,
  installAudioResume,
  levelFromTimeDomain,
  pickGreeting,
  reduceSilenceClock,
  responseInProgress,
  sessionExpired,
  VOICE_MAX_SESSION_MS,
  VOICE_SPEAK_LEVEL,
  type SilenceClock,
  type VoiceEndReason,
} from "@/lib/agent/voice";

// Creating the model is safe in the browser; only the token is minted on the server.
const voiceModel = gateway.experimental_realtime(appConfig.agent.voiceModel);

export type VoiceStatus = { status: string; isCapturing: boolean; isPlaying: boolean };
export type VoiceApi = { disconnect: () => void };

/**
 * One live voice call. Speech goes straight to the voice model through AI
 * Gateway with a short-lived token from /api/agent/voice/session, fetched
 * before this mounts (see voice-setup.ts), so the socket opens right away
 * instead of waiting on another round trip; tool calls
 * come back here and run on our server as the signed-in teammate. Unmounting
 * ends the call and hands what was said to `onTranscript`.
 */
export default function VoiceSession({
  socket,
  sessionConfig,
  captureStream,
  onStatus,
  onError,
  onSessionEnd,
  onTranscript,
  apiRef,
}: {
  socket: { token: string; url: string };
  sessionConfig: Partial<Experimental_RealtimeSessionConfig>;
  captureStream: MediaStream;
  onStatus: (s: VoiceStatus) => void;
  onError: (e: Error) => void;
  onSessionEnd: (reason?: VoiceEndReason) => void;
  onTranscript: (messages: UIMessage[]) => void;
  apiRef: RefObject<VoiceApi | null>;
}) {
  const callbacks = useRef({ onStatus, onError, onSessionEnd, onTranscript });
  useEffect(() => {
    callbacks.current = { onStatus, onError, onSessionEnd, onTranscript };
  }, [onStatus, onError, onSessionEnd, onTranscript]);

  // The same socket the hook opens from a token endpoint (the token rides in the subprotocol), without fetching it again.
  const api = useMemo(() => ({ websocket: socket.url, protocols: voiceModel.getWebSocketConfig?.({ token: socket.token, url: socket.url })?.protocols ?? [] }), [socket]);
  const realtime = useRealtime({
    model: voiceModel,
    api,
    sessionConfig,
    onToolCall: async ({ toolCall }) => {
      if (!toolCall) return undefined;
      const res = await fetch("/api/agent/voice/tool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolName: toolCall.toolName, input: toolCall.args && typeof toolCall.args === "object" ? toolCall.args : {} }),
      });
      const data = (await res.json().catch(() => ({}))) as { result?: unknown; message?: string };
      if (!res.ok) return { error: data.message ?? "That didn't work. Try again." };
      // If it changed a record, the page behind the panel shows it now.
      checkForChanges();
      return data.result;
    },
    onError: (err) => callbacks.current.onError(err),
  });
  const { connect, disconnect, startAudioCapture, stopAudioCapture, sendTextMessage, status, messages, isCapturing, isPlaying } = realtime;

  const live = useRef({ startAudioCapture, stopAudioCapture, sendTextMessage, disconnect, isPlaying, messages, captureStream });
  useEffect(() => {
    live.current = { startAudioCapture, stopAudioCapture, sendTextMessage, disconnect, isPlaying, messages, captureStream };
  });

  useEffect(() => {
    apiRef.current = { disconnect };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, disconnect]);

  useEffect(() => {
    callbacks.current.onStatus({ status, isCapturing, isPlaying });
  }, [status, isCapturing, isPlaying]);

  // One connection per mounted call. Strict Mode mounts twice; wait a tick so only the mount that stays opens the socket.
  useEffect(() => {
    const restore = installAudioResume();
    let started = false;
    const timer = window.setTimeout(() => {
      started = true;
      connect();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      restore();
      // useRealtime disposes the session itself on unmount (closing the socket and the audio), and its controls
      // throw once it has let go, which would take the page down. So this only hands over what was said.
      if (started) callbacks.current.onTranscript(live.current.messages);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the parent unmounts this to end the call
  }, []);

  const greeted = useRef(false);
  useEffect(() => {
    if (status !== "connected" || greeted.current) return;
    greeted.current = true;
    live.current.sendTextMessage(greetingCue(pickGreeting()));
  }, [status]);

  // The 5-minute cap and the 30-second listening gap.
  useEffect(() => {
    if (status !== "connected") return;
    const connectedAt = Date.now();
    let clock: SilenceClock | null = null;
    let ended = false;
    let ctx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let watched: MediaStream | null = null;
    const samples = new Uint8Array(512);
    const finish = (reason: VoiceEndReason) => {
      if (ended) return;
      ended = true;
      window.clearInterval(timer);
      callbacks.current.onSessionEnd(reason);
    };
    const userSpeaking = () => {
      const stream = live.current.captureStream;
      if (!stream) return false;
      try {
        if (watched !== stream) {
          source?.disconnect();
          if (ctx && ctx.state !== "closed") void ctx.close();
          ctx = createAudioContext();
          if (!ctx) return false;
          analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          source = ctx.createMediaStreamSource(stream);
          source.connect(analyser);
          watched = stream;
          ctx.resume?.().catch(() => {});
        }
        if (!analyser) return false;
        analyser.getByteTimeDomainData(samples);
        return levelFromTimeDomain(samples) > VOICE_SPEAK_LEVEL;
      } catch {
        return false;
      }
    };
    const timer = window.setInterval(() => {
      if (ended) return;
      const now = Date.now();
      if (sessionExpired(connectedAt, now, VOICE_MAX_SESSION_MS)) return finish("max-duration");
      clock = reduceSilenceClock(clock, { now, assistantSpeaking: live.current.isPlaying, userSpeaking: userSpeaking(), responseInProgress: responseInProgress(live.current.messages) });
      if (clock.reason === "silence") finish("silence");
    }, 200);
    return () => {
      ended = true;
      window.clearInterval(timer);
      source?.disconnect();
      if (ctx && ctx.state !== "closed") void ctx.close();
    };
  }, [status]);

  // The microphone was opened from the click; hand it over once connected.
  useEffect(() => {
    if (status !== "connected" || !captureStream) return;
    live.current.startAudioCapture(captureStream);
    return () => {
      try {
        live.current.stopAudioCapture();
      } catch {
        // Unmounting: the hook already stopped capture and let go of its controls.
      }
    };
  }, [status, captureStream]);

  return null;
}
