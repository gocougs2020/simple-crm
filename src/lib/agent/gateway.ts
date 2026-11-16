import "server-only";
import { createGateway } from "ai";

/**
 * The one AI Gateway client every AI feature uses: chat, thread titles,
 * record summaries, dictation and voice chat tokens. It authenticates only
 * with `AI_GATEWAY_API_KEY`, never with the deployment's OIDC token (the AI
 * SDK's default gateway falls back to it), so all usage counts against the
 * key and its budget. Without a key, calls fail instead of quietly billing
 * the Vercel team; the routes check aiFeatures() first, so people see a
 * sentence instead of an error.
 */
export const aiGateway = createGateway({
  apiKey: () => {
    const key = process.env.AI_GATEWAY_API_KEY?.trim();
    if (!key) throw new Error("AI_GATEWAY_API_KEY isn't set. AI features run only on an AI Gateway API key.");
    return key;
  },
});
