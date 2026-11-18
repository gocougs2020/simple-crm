"use server";

import { z } from "zod";
import type { AgentMessage } from "@/db/schema";
import { run, type Result } from "@/lib/action";
import { withoutAttachmentText } from "@/lib/agent/attachments";
import { cleanTranscript } from "@/lib/agent/messages";
import { deleteThread, ensureThread, getThread, listThreads, renameThread, saveMessages } from "@/lib/agent/threads";
import { ActionError, actionCan, actionUser } from "@/lib/auth";
import { aiFeatures, aiOffMessage } from "@/lib/agent/config";
import { cancelBatch, cancelRun, listRuns, type Run } from "@/lib/agent/runs";
import { ensureSummary, type Summary } from "@/lib/agent/summary";
import { sessionActor } from "@/lib/crm/actor";
import type { AgentRunSource, AgentRunStatus } from "@/lib/constants";
import { rateLimit } from "@/lib/rate-limit";

/**
 * The agent's threads. Each teammate sees only their own: every query is
 * scoped to the signed-in user. Chatting itself streams through
 * /api/agent/chat.
 */

export type ThreadSummary = { id: string; title: string; lastMessageAt: string | null };

const threadId = z.uuid("That conversation doesn't exist.");

export async function listAgentThreads(): Promise<Result<ThreadSummary[]>> {
  return run(async () => {
    const user = await actionUser();
    const rows = await listThreads(user.id);
    return rows.map((r) => ({ id: r.id, title: r.title, lastMessageAt: r.lastMessageAt?.toISOString() ?? null }));
  });
}

/** A thread's messages, to show when it's opened. A thread that isn't saved yet is empty. */
export async function loadAgentThread(id: string): Promise<Result<{ id: string; title: string; messages: AgentMessage[] }>> {
  return run(async () => {
    const user = await actionUser();
    const row = await getThread(user.id, threadId.parse(id));
    // Attached files show as names: their text stays on the server.
    // Answers saved before ids were sent with the stream have none: give each one of its own, so the panel can tell them apart.
    const messages = row ? withoutAttachmentText(row.messages).map((m, i) => (m.id ? m : { ...m, id: `saved-${i}` })) : [];
    return { id: row?.id ?? id, title: row?.title ?? "", messages };
  });
}

export async function renameAgentThread(id: string, title: string): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    await renameThread(user.id, threadId.parse(id), z.string().trim().min(1, "Give the chat a name.").max(120).parse(title));
  });
}

export async function deleteAgentThread(id: string): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    await deleteThread(user.id, threadId.parse(id));
  });
}

/** Keeps what was said in a voice chat in the thread, as text, so it can be read back or continued by typing. */
export async function saveVoiceTranscript(id: string, transcript: unknown): Promise<Result<{ saved: number }>> {
  return run(async () => {
    const user = await actionUser();
    const messages = cleanTranscript(transcript);
    if (!messages.length) return { saved: 0 };
    const thread = await ensureThread(user.id, threadId.parse(id));
    await saveMessages(user.id, thread.id, [...thread.messages, ...messages], { touched: messages.some((m) => m.role === "user") });
    return { saved: messages.length };
  });
}

/** Thumbs up or down on one of the agent's answers, kept on the stored message. */
export async function rateAgentMessage(id: string, messageId: string, feedback: "up" | "down" | null): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const thread = await getThread(user.id, threadId.parse(id));
    if (!thread) return;
    const value = z.enum(["up", "down"]).nullable().parse(feedback);
    const messages = thread.messages.map((m) => (m.id === messageId && m.role === "assistant" ? { ...m, metadata: { ...m.metadata, feedback: value } } : m));
    await saveMessages(user.id, thread.id, messages);
  });
}

/** A background task as the panel lists it. */
export type AgentTask = {
  id: string;
  title: string;
  status: AgentRunStatus;
  source: AgentRunSource;
  result: string | null;
  error: string | null;
  threadId: string | null;
  /** Shared by the tasks of one bulk request. */
  batchId: string | null;
  /** The record it's about, to link to. */
  url: string | null;
  createdAt: string;
  finishedAt: string | null;
};

const toTask = (r: Run): AgentTask => ({
  id: r.id,
  title: r.title,
  status: r.status,
  source: r.source,
  result: r.result,
  error: r.error,
  threadId: r.threadId,
  batchId: r.batchId,
  url: r.clientId ? `/clients/${r.clientId}` : r.personId ? `/people/${r.personId}` : r.organizationId ? `/organizations/${r.organizationId}` : null,
  createdAt: r.createdAt.toISOString(),
  finishedAt: r.finishedAt?.toISOString() ?? null,
});

/** The signed-in teammate's background tasks, newest first: what the agent is working on for them and what it finished. */
export async function listAgentTasks(): Promise<Result<AgentTask[]>> {
  return run(async () => {
    const user = await actionUser();
    if (!aiFeatures().background) return [];
    return (await listRuns(sessionActor(user), { limit: 100 })).map(toTask);
  });
}

/** Stops one of the teammate's background tasks. What it already changed stays. */
export async function cancelAgentTask(id: string): Promise<Result<AgentTask>> {
  return run(async () => {
    const user = await actionUser();
    return toTask(await cancelRun(sessionActor(user), z.uuid("That task doesn't exist.").parse(id)));
  });
}

/** Stops every task of a bulk request that hasn't finished. */
export async function cancelAgentBatch(batchId: string): Promise<Result<{ stopped: number }>> {
  return run(async () => {
    const user = await actionUser();
    return cancelBatch(sessionActor(user), z.uuid("That request doesn't exist.").parse(batchId));
  });
}

/**
 * The AI snapshot at the top of a client, person or organization page,
 * rewritten first when it's missing or more than a day old. Anyone who can
 * read the record can ask; the snapshot is shared, so it's written once a day
 * however many people open the record.
 */
export async function recordSummary(entity: string, id: string): Promise<Result<Summary>> {
  return run(async () => {
    const user = await actionCan("records:read");
    const which = z.enum(["client", "person", "organization"]).parse(entity);
    const recordId = z.uuid("That record doesn't exist.").parse(id);
    if (!aiFeatures().summaries) throw new ActionError(aiOffMessage("summaries"));
    if ((await rateLimit("summary", user.id, { limit: 120, windowMs: 3600_000 })).limited) throw new ActionError("That's a lot of summaries this hour. Try again later.");
    try {
      return await ensureSummary(which, recordId);
    } catch (err) {
      console.error("[summary]", err);
      throw new ActionError("The summary couldn't be written just now. It tries again the next time someone opens this page.");
    }
  });
}
