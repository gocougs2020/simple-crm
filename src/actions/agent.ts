"use server";

import { liveVersions } from "@/lib/live";
import { noVersions, type LiveVersions } from "@/lib/live-rules";
import { z } from "zod";
import type { AgentMessage } from "@/db/schema";
import { run, type Result } from "@/lib/action";
import { withoutAttachmentText } from "@/lib/agent/attachments";
import { cleanTranscript } from "@/lib/agent/messages";
import { deleteThread, ensureThread, getThread, listThreads, renameThread, saveMessages } from "@/lib/agent/threads";
import { ActionError, actionCan, actionUser } from "@/lib/auth";
import { aiFeatures, aiOffMessage } from "@/lib/agent/config";
import { startEnrichment } from "@/lib/agent/enrich";
import { enrichEntities } from "@/lib/agent/enrich-rules";
import { cancelBatch, cancelRun, clearPanelRuns, listPanelRuns, type Run } from "@/lib/agent/runs";
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
  /** When it leaves the panel's list: set once the open panel has listed it finished. */
  hideAt: string | null;
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
  hideAt: r.hideAt?.toISOString() ?? null,
});

/**
 * The signed-in teammate's background tasks, newest first: what the agent is working on for them and
 * what it finished lately. `seen` says the panel is open, which starts the hour a finished task stays listed.
 */
/**
 * The panel's tasks, with the live versions read alongside (src/lib/live.ts),
 * so following a task's progress doesn't need its own /api/live request.
 */
export async function listAgentTasks(seen = false): Promise<Result<{ tasks: AgentTask[]; versions: LiveVersions }>> {
  return run(async () => {
    const user = await actionUser();
    if (!aiFeatures().background) return { tasks: [], versions: noVersions };
    const [runs, versions] = await Promise.all([listPanelRuns(sessionActor(user), { seen: seen === true }), liveVersions()]);
    return { tasks: runs.map(toTask), versions };
  });
}

/**
 * Takes tasks off the panel's list: one task, one bulk request, or (with nothing named) every
 * finished one. A task still going is stopped first. Nothing it changed is undone.
 */
export async function clearAgentTasks(which: { id?: string; batchId?: string } = {}): Promise<Result<{ cleared: number }>> {
  return run(async () => {
    const user = await actionUser();
    const { id, batchId } = z.object({ id: z.uuid("That task doesn't exist.").optional(), batchId: z.uuid("That request doesn't exist.").optional() }).parse(which ?? {});
    return clearPanelRuns(sessionActor(user), { ids: id ? [id] : undefined, batchId });
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
 * Enrich on a person's or organization's page: the agent researches it on
 * the web in the background, fills in what it's sure of and leaves a note
 * with everything it found (src/lib/agent/enrich.ts).
 */
export async function enrichRecord(entity: string, id: string): Promise<Result<{ taskId: string; error: string | null }>> {
  return run(async () => {
    const user = await actionUser();
    const which = z.enum(enrichEntities).parse(entity);
    const recordId = z.uuid("That record doesn't exist.").parse(id);
    const started = await startEnrichment(sessionActor(user), which, recordId);
    // The worker can refuse it on the spot; the note saying so is already on the record.
    return { taskId: started.id, error: started.status === "failed" ? (started.error ?? "The agent couldn't start.") : null };
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
