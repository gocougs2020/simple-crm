import "server-only";
import { appConfig } from "@/app.config";

/**
 * Whether this deployment can reach AI Gateway: an API key
 * (`AI_GATEWAY_API_KEY`, for local development or hosting outside Vercel), or
 * the OIDC token Vercel gives every deployment.
 */
export const aiGatewayAvailable = () => !!(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL);

/**
 * Which AI features run on this deployment: switched on in app.config.ts
 * (`agent.*`, or `NEXT_PUBLIC_APP_CONFIG`) and able to reach AI Gateway.
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
    : `${name} isn't set up on this deployment yet. An admin can add AI Gateway access (see docs/AGENT.md).`;
}
