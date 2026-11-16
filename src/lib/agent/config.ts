import "server-only";
import { appConfig } from "@/app.config";

/**
 * Whether this deployment has an AI Gateway API key (`AI_GATEWAY_API_KEY`).
 * Every AI feature runs on that key, on Vercel too: usage is attributed to
 * the key, so its budget and spend limits in the Vercel dashboard apply.
 * The deployment's own OIDC token is deliberately not used (src/lib/agent/gateway.ts).
 */
export const aiGatewayAvailable = () => !!process.env.AI_GATEWAY_API_KEY?.trim();

/**
 * Which AI features run on this deployment: switched on in app.config.ts
 * (`agent.*`, or `NEXT_PUBLIC_APP_CONFIG`) and with an AI Gateway key.
 * The interface hides what's off, and every route refuses it.
 */
export function aiFeatures() {
  const ok = aiGatewayAvailable();
  const { enabled, voice, dictation, summaries } = appConfig.agent;
  return { chat: ok && enabled, voice: ok && enabled && voice, dictation: ok && dictation, summaries: ok && summaries };
}

export type AiFeatures = ReturnType<typeof aiFeatures>;

/** The sentence for a feature that's off, saying why and where to change it. */
export function aiOffMessage(feature: keyof AiFeatures) {
  const name = { chat: "The assistant", voice: "Voice chat", dictation: "Dictation", summaries: "Summaries" }[feature];
  return aiGatewayAvailable()
    ? `${name} is turned off on this deployment (agent settings in app.config.ts or NEXT_PUBLIC_APP_CONFIG).`
    : `${name} isn't set up on this deployment yet. An admin can add an AI Gateway API key (AI_GATEWAY_API_KEY; see docs/AGENT.md).`;
}
