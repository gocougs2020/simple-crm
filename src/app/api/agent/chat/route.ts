import { after } from "next/server";
import { convertToModelMessages, isStepCount, streamText, validateUIMessages, type UIMessage } from "ai";
import { z } from "zod";
import { appConfig } from "@/app.config";
import type { AgentMessage } from "@/db/schema";
import { assistantActor } from "@/lib/agent/actor";
import { agentError, agentRequest, readJson } from "@/lib/agent/http";
import { mergeIncoming } from "@/lib/agent/messages";
import { agentInstructions } from "@/lib/agent/prompt";
import { aiFeatures, aiOffMessage } from "@/lib/agent/config";
import { autoTitle, ensureThread, saveMessages } from "@/lib/agent/threads";
import { agentTools, needsConfirmation } from "@/lib/agent/tools";
import { can } from "@/lib/crm/actor";
import { siteOrigin } from "@/lib/origin";
import { getWorkspace } from "@/lib/workspace";

export const maxDuration = 300;

const body = z.object({
  threadId: z.uuid(),
  /** The one new message: the teammate's (new or edited), or the assistant's last one carrying their confirmation answers. */
  message: z.unknown(),
  page: z.string().max(300).optional(),
});

/**
 * The assistant's text chat (useChat with DefaultChatTransport). Loads the
 * thread from the database, merges in the message the browser sent, answers
 * with the teammate's tools, and saves the result.
 */
export async function POST(request: Request) {
  const gate = await agentRequest(request);
  if (!gate.ok) return gate.response;
  if (!aiFeatures().chat) return agentError(503, aiOffMessage("chat"));

  let input: z.infer<typeof body>;
  try {
    input = body.parse(await readJson(request));
  } catch {
    return agentError(400, "That message couldn't be read. Try sending it again.");
  }

  const user = gate.user;
  const thread = await ensureThread(user.id, input.threadId).catch(() => null);
  if (!thread) return agentError(404, "That conversation isn't yours. Start a new chat.");
  const merged = mergeIncoming(thread.messages, input.message);
  if (!merged.ok) return agentError(400, merged.error);

  const [actor, workspace, origin] = await Promise.all([assistantActor(user), getWorkspace(), siteOrigin()]);
  const tools = agentTools(actor, { origin });

  let messages: UIMessage[];
  try {
    messages = await validateUIMessages({ messages: merged.messages as UIMessage[], tools });
  } catch (err) {
    // A tool renamed since this thread was saved: keep the conversation, drop what no longer fits.
    console.warn("[agent] stored messages don't validate; answering from text only", err);
    messages = (merged.messages as UIMessage[]).map((m) => ({ ...m, parts: m.parts.filter((p) => p.type === "text") })).filter((m) => m.parts.length);
  }
  if (merged.submitted) await saveMessages(user.id, thread.id, messages as AgentMessage[], { touched: true });

  const result = streamText({
    model: appConfig.agent.chatModel,
    reasoning: appConfig.agent.chatReasoning,
    system: agentInstructions({
      user,
      canWrite: can(actor, "records:write"),
      workspace: { name: workspace.name, timezone: workspace.timezone, currency: workspace.currency },
      now: new Date(),
      page: input.page,
    }),
    messages: await convertToModelMessages(messages, { tools, ignoreIncompleteToolCalls: true }),
    tools,
    // Archive and delete wait for the teammate's button press.
    toolApproval: ({ toolCall }) => (needsConfirmation(toolCall.toolName) ? { type: "user-approval", reason: "This archives or deletes something." } : undefined),
    stopWhen: isStepCount(12),
    // Reasoning tokens count toward this, so it leaves room for thinking as well as the answer.
    maxOutputTokens: 16_000,
    onError: ({ error }) => console.error("[agent] chat", error),
  });

  // Named after the response has finished streaming, so the title model never slows an answer down.
  let ended: (final: AgentMessage[] | null) => void = () => {};
  const endedWith = new Promise<AgentMessage[] | null>((resolve) => (ended = resolve));
  if (merged.submitted) {
    after(async () => {
      const final = await Promise.race([endedWith, new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000))]);
      if (final) await autoTitle(user.id, thread.id, final);
    });
  }

  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    // The model's reasoning stays on the server: it isn't shown, and threads don't store it.
    sendReasoning: false,
    headers: { "Cache-Control": "no-store" },
    onEnd: async ({ messages: final }) => {
      try {
        await saveMessages(user.id, thread.id, final as AgentMessage[]);
      } finally {
        ended(final as AgentMessage[]);
      }
    },
    onError: (error) => {
      console.error("[agent] stream", error);
      return "The assistant couldn't finish that answer. Try again in a moment.";
    },
  });
}
