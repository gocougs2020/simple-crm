import { experimental_transcribe as transcribe, gateway } from "ai";
import { appConfig } from "@/app.config";
import { agentError, agentRequest } from "@/lib/agent/http";
import { agentConfigured } from "@/lib/agent/config";

export const maxDuration = 60;

/** Under Vercel's 4.5 MB request limit; a couple of minutes of speech. */
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

/** The composer's microphone: a recording in, its text out (`{ text }`), through AI Gateway's speech-to-text model. */
export async function POST(request: Request) {
  const gate = await agentRequest(request);
  if (!gate.ok) return gate.response;
  if (!agentConfigured()) return agentError(503, "Voice input isn't set up on this deployment yet. An admin can add AI Gateway access (see docs/AGENT.md).");
  if (Number(request.headers.get("content-length") || 0) > MAX_AUDIO_BYTES + 64_000) return agentError(413, "That recording is too long. Try a shorter one.");

  let file: File | null = null;
  try {
    const form = await request.formData();
    const value = form.get("file");
    file = value instanceof File ? value : null;
  } catch {
    return agentError(400, "That recording couldn't be read. Try again.");
  }
  if (!file || !file.size) return agentError(400, "Nothing was recorded. Check your microphone and try again.");
  if (file.size > MAX_AUDIO_BYTES) return agentError(413, "That recording is too long. Try a shorter one.");
  if (!/^audio\//.test(file.type || "audio/webm")) return agentError(415, "Only audio recordings can be transcribed.");

  try {
    const result = await transcribe({
      model: gateway.transcription(appConfig.agent.transcriptionModel),
      audio: new Uint8Array(await file.arrayBuffer()),
      abortSignal: request.signal,
    });
    return Response.json({ text: result.text.trim() }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[agent] transcribe", err);
    return agentError(502, "Your recording couldn't be transcribed. Try again, or type instead.");
  }
}
