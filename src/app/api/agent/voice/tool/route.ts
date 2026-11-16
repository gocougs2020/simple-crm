import { z } from "zod";
import { assistantActor } from "@/lib/agent/actor";
import { aiFeatures, aiOffMessage } from "@/lib/agent/config";
import { agentError, agentRequest, readJson } from "@/lib/agent/http";
import { runTool } from "@/lib/agent/tools";
import { siteOrigin } from "@/lib/origin";

const body = z.object({ toolName: z.string().min(1).max(64), input: z.record(z.string(), z.unknown()).default({}) });

/**
 * A tool call from voice chat. The voice model runs in the browser, so its
 * tool calls come here and run as the signed-in teammate, with their role,
 * through the same operations as MCP. Archive and delete aren't offered in
 * voice: they need a button press in text chat.
 */
export async function POST(request: Request) {
  if (!aiFeatures().voice) return agentError(503, aiOffMessage("voice"));
  const gate = await agentRequest(request);
  if (!gate.ok) return gate.response;
  let input: z.infer<typeof body>;
  try {
    input = body.parse(await readJson(request, 64_000));
  } catch {
    return agentError(400, "That tool call couldn't be read.");
  }
  const actor = await assistantActor(gate.user);
  const result = await runTool(actor, input.toolName, input.input, { origin: await siteOrigin() }, { voice: true });
  return Response.json({ result }, { headers: { "Cache-Control": "no-store" } });
}
