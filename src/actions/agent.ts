"use server";

import { z } from "zod";
import type { AgentMessage } from "@/db/schema";
import { run, type Result } from "@/lib/action";
import { assistantActor } from "@/lib/agent/actor";
import { cleanTranscript } from "@/lib/agent/messages";
import { agentInstructions } from "@/lib/agent/prompt";
import { deleteThread, ensureThread, getThread, listThreads, renameThread, saveMessages } from "@/lib/agent/threads";
import { ActionError, actionCan, actionUser } from "@/lib/auth";
import { agentConfigured } from "@/lib/agent/config";
import { ensureSummary, type Summary } from "@/lib/agent/summary";
import { rateLimit } from "@/lib/rate-limit";
import { can } from "@/lib/crm/actor";
import { getWorkspace } from "@/lib/workspace";

/**
 * The assistant's threads. Each teammate sees only their own: every query is
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
    return row ? { id: row.id, title: row.title, messages: row.messages } : { id, title: "", messages: [] };
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

/** Instructions for a voice chat: the same as text chat, tuned for speaking. */
export async function prepareVoiceChat(page?: string): Promise<Result<{ instructions: string }>> {
  return run(async () => {
    const user = await actionUser();
    const [actor, ws] = await Promise.all([assistantActor(user), getWorkspace()]);
    const instructions = agentInstructions({
      user,
      canWrite: can(actor, "records:write"),
      workspace: { name: ws.name, timezone: ws.timezone, currency: ws.currency },
      now: new Date(),
      page: z.string().max(300).optional().parse(page),
      voice: true,
    });
    return { instructions };
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

/** Thumbs up or down on one of the assistant's answers, kept on the stored message. */
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
    if (!agentConfigured()) throw new ActionError("Summaries need AI Gateway access on this deployment.");
    if ((await rateLimit("summary", user.id, { limit: 120, windowMs: 3600_000 })).limited) throw new ActionError("That's a lot of summaries this hour. Try again later.");
    try {
      return await ensureSummary(which, recordId);
    } catch (err) {
      console.error("[summary]", err);
      throw new ActionError("The summary couldn't be written just now. It tries again the next time someone opens this page.");
    }
  });
}
