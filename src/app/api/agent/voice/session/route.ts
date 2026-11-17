import { experimental_getRealtimeToolDefinitions as realtimeTools } from "ai";
import { aiGateway } from "@/lib/agent/gateway";
import { appConfig } from "@/app.config";
import { assistantActor } from "@/lib/agent/actor";
import { agentError, agentRequest } from "@/lib/agent/http";
import { aiFeatures, aiOffMessage } from "@/lib/agent/config";
import { agentTools } from "@/lib/agent/tools";
import { siteOrigin } from "@/lib/origin";

/**
 * How long the client secret can be used to open the voice socket. The AI
 * Gateway accepts at most 300 seconds (a longer value is refused with a 400),
 * and the browser connects right after fetching it, so 5 minutes is plenty.
 * The call itself is capped at 5 minutes separately (VOICE_MAX_SESSION_MS).
 */
const TOKEN_SECONDS = 5 * 60;

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
      aiGateway.experimental_realtime.getToken({ model: appConfig.agent.voiceModel, expiresAfterSeconds: TOKEN_SECONDS }),
      realtimeTools({ tools: agentTools(actor, { origin: await siteOrigin() }, { voice: true }) }),
    ]);
    return Response.json({ ...token, tools }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[agent] voice session", err);
    return agentError(502, "Voice chat couldn't start. Try again in a moment.");
  }
}
