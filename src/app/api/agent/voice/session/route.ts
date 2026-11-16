import { experimental_getRealtimeToolDefinitions as realtimeTools, gateway } from "ai";
import { appConfig } from "@/app.config";
import { assistantActor } from "@/lib/agent/actor";
import { agentError, agentRequest } from "@/lib/agent/http";
import { aiFeatures, aiOffMessage } from "@/lib/agent/config";
import { agentTools } from "@/lib/agent/tools";
import { siteOrigin } from "@/lib/origin";

/** One voice chat is capped at 5 minutes in the browser; the token outlives it a little. */
const TOKEN_SECONDS = 6 * 60;

/**
 * Starts a voice chat (experimental_useRealtime's `api.token`): a short-lived
 * AI Gateway client secret for the voice model, and the tools this teammate
 * may use. The Gateway credential never leaves the server. Tools run back on
 * this server (/api/agent/voice/tool) with the teammate's session.
 */
export async function POST(request: Request) {
  const gate = await agentRequest(request, { cost: 5 });
  if (!gate.ok) return gate.response;
  if (!aiFeatures().voice) return agentError(503, aiOffMessage("voice"));
  try {
    const actor = await assistantActor(gate.user);
    const [token, tools] = await Promise.all([
      gateway.experimental_realtime.getToken({ model: appConfig.agent.voiceModel, expiresAfterSeconds: TOKEN_SECONDS }),
      realtimeTools({ tools: agentTools(actor, { origin: await siteOrigin() }, { voice: true }) }),
    ]);
    return Response.json({ ...token, tools }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[agent] voice session", err);
    return agentError(502, "Voice chat couldn't start. Try again in a moment.");
  }
}
