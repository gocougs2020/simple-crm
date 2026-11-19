import { labelsSection } from "@/lib/crm/label-rules";
import { listLabels } from "@/lib/crm/labels";
import { experimental_getRealtimeToolDefinitions as realtimeTools } from "ai";
import { z } from "zod";
import { aiGateway } from "@/lib/agent/gateway";
import { appConfig } from "@/app.config";
import { assistantActor } from "@/lib/agent/actor";
import { agentError, agentRequest, readJson } from "@/lib/agent/http";
import { aiFeatures, aiOffMessage } from "@/lib/agent/config";
import { agentInstructions } from "@/lib/agent/prompt";
import { activeSkills } from "@/lib/agent/skills";
import { agentTools } from "@/lib/agent/tools";
import { featureInstructions } from "@/lib/api/features";
import { can } from "@/lib/crm/actor";
import { siteOrigin } from "@/lib/origin";
import { getWorkspace } from "@/lib/workspace";

/**
 * How long the client secret can be used to open the voice socket. The AI
 * Gateway accepts at most 300 seconds (a longer value is refused with a 400).
 * The browser may fetch it a little before the click (on hover), so it keeps
 * one for up to 4 minutes (VOICE_SETUP_FRESH_MS). The call itself is capped at
 * 5 minutes separately (VOICE_MAX_SESSION_MS).
 */
const TOKEN_SECONDS = 5 * 60;

const body = z.object({ page: z.string().max(300).optional() }).catch({});

/**
 * Everything a voice chat needs, in one request, so the browser can open the
 * socket straight after: a short-lived, single-use AI Gateway client secret
 * and its socket URL, the tools this teammate may use, and the instructions
 * (the same as text chat, tuned for speaking, with the page they're on). The
 * Gateway credential never leaves the server. Tools run back on this server
 * (/api/agent/voice/tool) with the teammate's session.
 */
export async function POST(request: Request) {
  const gate = await agentRequest(request, { cost: 5 });
  if (!gate.ok) return gate.response;
  if (!aiFeatures().voice) return agentError(503, aiOffMessage("voice"));
  const { page } = body.parse(await readJson(request, 4_000).catch(() => ({})));
  try {
    const [token, actor, ws, origin, skills] = await Promise.all([
      aiGateway.experimental_realtime.getToken({ model: appConfig.agent.voiceModel, expiresAfterSeconds: TOKEN_SECONDS }),
      assistantActor(gate.user),
      getWorkspace(),
      siteOrigin(),
      activeSkills(gate.user.id),
    ]);
    const tools = await realtimeTools({ tools: agentTools(actor, { origin, agent: true }, { voice: true }) });
    const instructions = agentInstructions({
      user: gate.user,
      canWrite: can(actor, "records:write"),
      workspace: { name: ws.name, timezone: ws.timezone, currency: ws.currency },
      now: new Date(),
      page,
      voice: true,
      knowledge: featureInstructions(),
      labels: labelsSection(await listLabels()),
      skills,
    });
    return Response.json({ ...token, tools, instructions }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[agent] voice session", err);
    return agentError(502, "Voice chat couldn't start. Try again in a moment.");
  }
}
