import { labelsSection } from "@/lib/crm/label-rules";
import { listLabels } from "@/lib/crm/labels";
import { after } from "next/server";
import { convertToModelMessages, isStepCount, streamText, validateUIMessages, type UIMessage } from "ai";
import { z } from "zod";
import { appConfig } from "@/app.config";
import type { AgentMessage } from "@/db/schema";
import { assistantActor } from "@/lib/agent/actor";
import { aiGateway } from "@/lib/agent/gateway";
import { agentError, agentRequest, readJson } from "@/lib/agent/http";
import { withAttachments } from "@/lib/agent/attachments";
import { historyForModel, MAX_STORED_CHARS, mergeIncoming } from "@/lib/agent/messages";
import { agentInstructions } from "@/lib/agent/prompt";
import { activeSkills } from "@/lib/agent/skills";
import { featureInstructions } from "@/lib/api/features";
import { aiFeatures, aiOffMessage } from "@/lib/agent/config";
import { appendMessage, autoTitle, ensureThread, saveMessages } from "@/lib/agent/threads";
import { confirmReason } from "@/lib/agent/policy";
import { agentTools, needsConfirmation } from "@/lib/agent/tools";
import { can } from "@/lib/crm/actor";
import { siteOrigin } from "@/lib/origin";
import { getWorkspace } from "@/lib/workspace";

export const maxDuration = 300;

const body = z.object({
  threadId: z.uuid(),
  /** The one new message: the teammate's (new or edited), or the agent's last one carrying their confirmation answers. */
  message: z.unknown(),
  page: z.string().max(300).optional(),
});

/**
 * The agent's text chat (useChat with DefaultChatTransport). Loads the
 * thread from the database, merges in the message the browser sent, answers
 * with the teammate's tools, and saves the result.
 */
export async function POST(request: Request) {
  const gate = await agentRequest(request);
  if (!gate.ok) return gate.response;
  if (!aiFeatures().chat) return agentError(503, aiOffMessage("chat"));

  let input: z.infer<typeof body>;
  try {
    // Room for the text of attached files (src/lib/agent/attachments.ts), which JSON escaping can double.
    input = body.parse(await readJson(request, 400_000));
  } catch {
    return agentError(400, "That message couldn't be read. Try sending it again.");
  }

  const user = gate.user;
  const thread = await ensureThread(user.id, input.threadId).catch(() => null);
  if (!thread) return agentError(404, "That conversation isn't yours. Start a new chat.");
  const merged = mergeIncoming(thread.messages, input.message);
  if (!merged.ok) return agentError(400, merged.error);

  // Everything the turn needs that doesn't depend on each other, at once.
  const [actor, workspace, origin, skills, labels] = await Promise.all([assistantActor(user), getWorkspace(), siteOrigin(), activeSkills(user.id), listLabels()]);
  const tools = agentTools(actor, { origin, agent: true, threadId: thread.id });

  let messages: UIMessage[];
  try {
    messages = await validateUIMessages({ messages: merged.messages as UIMessage[], tools });
  } catch (err) {
    // A tool renamed since this thread was saved: keep the conversation, drop what no longer fits.
    console.warn("[agent] stored messages don't validate; answering from text only", err);
    messages = (merged.messages as UIMessage[]).map((m) => ({ ...m, parts: m.parts.filter((p) => p.type === "text") })).filter((m) => m.parts.length);
  }
  // The teammate's message is stored before the answer streams, so it's kept if the answer never finishes.
  // A new message is appended on its own; an edit to an earlier one rewrites the thread.
  if (merged.submitted) {
    const added = merged.messages.length === thread.messages.length + 1 && merged.messages.at(-2) === thread.messages.at(-1);
    // Only while the thread stays under the storage cap; past it, the rewrite trims the oldest turns.
    const fits = added && JSON.stringify(messages).length <= MAX_STORED_CHARS;
    if (fits) await appendMessage(user.id, thread.id, messages.at(-1) as AgentMessage, { isFirst: !thread.messages.some((m) => m.role === "user") });
    else await saveMessages(user.id, thread.id, messages as AgentMessage[], { touched: true });
  }

  const result = streamText({
    model: aiGateway(appConfig.agent.chatModel),
    reasoning: appConfig.agent.chatReasoning,
    system: agentInstructions({
      user,
      canWrite: can(actor, "records:write"),
      workspace: { name: workspace.name, timezone: workspace.timezone, currency: workspace.currency },
      now: new Date(),
      page: input.page,
      knowledge: featureInstructions(),
      labels: labelsSection(labels),
      skills,
      background: aiFeatures().background && can(actor, "records:write"),
    }),
    // Attached files reach the model as text after the message they came with.
    // The model gets a lighter copy: older tool results stubbed and the oldest turns left out past a size (historyForModel). Storage keeps everything.
    messages: await convertToModelMessages(historyForModel(withAttachments(messages as AgentMessage[])) as UIMessage[], { tools, ignoreIncompleteToolCalls: true }),
    tools,
    // Archive and delete wait for the teammate's button press.
    toolApproval: ({ toolCall }) => (needsConfirmation(toolCall.toolName) ? { type: "user-approval", reason: confirmReason(toolCall.toolName) } : undefined),
    stopWhen: isStepCount(12),
    // Reasoning tokens count toward this, so it leaves room for thinking as well as the answer.
    maxOutputTokens: 16_000,
    // Prompt caching through AI Gateway (`caching` in @ai-sdk/gateway's GatewayProviderOptions): the instructions and tools
    // are the same every step and every turn (the time and the page come last, src/lib/agent/prompt.ts), so they're read from cache.
    providerOptions: { gateway: { caching: "auto" } },
    onFinish: ({ totalUsage: u }) =>
      console.info("[agent] usage", { input: u.inputTokens, cached: u.inputTokenDetails?.cacheReadTokens, uncached: u.inputTokenDetails?.noCacheTokens, cacheWrite: u.inputTokenDetails?.cacheWriteTokens, output: u.outputTokens }),
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
    // The answer's id is made here and sent with the stream, so the browser's copy and the stored copy carry the
    // same one. Without it the SDK stores "" and the browser makes up its own, and a confirmation (archive, delete,
    // merge) or a thumbs-up sent back for that message matches nothing.
    generateMessageId: () => crypto.randomUUID(),
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
      return "The agent couldn't finish that answer. Try again in a moment.";
    },
  });
}
