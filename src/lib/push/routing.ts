import type { ActivityType, ClientCategory } from "@/lib/constants";
import type { Notice } from "./notify";

/**
 * Who hears about what, without the database: the triggers look people up,
 * these decide which alerts each of them is offered and in what order.
 * Each of a teammate's devices gets the first of their notices it wants.
 */

export type Owner = { userId: string; name: string; url: string };
export type Target = { userId: string; notices: Notice[] };

/**
 * A note or a reply: mentioned teammates first, then (for a reply) whoever is
 * already in the thread, then the owners of the records it's on.
 */
export function noteTargets(n: { who: string; body: string; url: string; dedupeKey: string; reply: boolean; mentioned: string[]; thread: (string | null)[]; owners: Owner[] }): Target[] {
  const thread = n.thread.filter((id): id is string => !!id);
  const everyone = [...new Set([...n.mentioned, ...thread, ...n.owners.map((o) => o.userId)])];
  return everyone.map((userId) => {
    const notices: Notice[] = [];
    const base = { body: n.body, url: n.url, dedupeKey: n.dedupeKey };
    if (n.mentioned.includes(userId)) notices.push({ kind: "note_mention", title: `${n.who} mentioned you in a note`, ...base });
    if (n.reply && thread.includes(userId)) notices.push({ kind: "note_reply", title: `${n.who} replied to a note`, ...base });
    const owned = n.owners.find((o) => o.userId === userId);
    if (owned) notices.push({ kind: "owned_activity", title: `${n.who} ${n.reply ? "replied to a note" : "added a note"} on ${owned.name}`, ...base, url: owned.url });
    return { userId, notices };
  });
}

/**
 * A logged or planned activity: an open one's assignee hears "gave you a
 * task" first, falling back to the activity if they own the record; the
 * other owners hear about the activity.
 */
export function activityTargets(n: { assigneeId: string | null; task: Notice | null; owners: Owner[]; owned: (o: Owner, dedupeKey?: string) => Notice }): Target[] {
  const targets: Target[] = [];
  if (n.task && n.assigneeId) {
    const own = n.owners.find((o) => o.userId === n.assigneeId);
    targets.push({ userId: n.assigneeId, notices: [n.task, ...(own ? [n.owned(own, n.task.dedupeKey)] : [])] });
  }
  for (const o of n.owners) if (!targets.some((t) => t.userId === o.userId)) targets.push({ userId: o.userId, notices: [n.owned(o)] });
  return targets;
}

const withArticle = (type: ActivityType) => `${/^[aeiou]/.test(type) ? "an" : "a"} ${type}`;

/** "logged a call", "planned a meeting", "added a task". */
export const activityVerb = (type: ActivityType, done: boolean) => (done ? `logged ${withArticle(type)}` : type === "task" ? "added a task" : `planned ${withArticle(type)}`);

const categoryMoves: Record<ClientCategory, (name: string) => string> = {
  prospective: (name) => `moved ${name} back to prospective`,
  current: (name) => `signed ${name}`,
  past: (name) => `moved ${name} to past clients`,
};

/** The title of a stage change: a move within the pipeline, or into another category. */
export const stageTitle = (who: string, name: string, stage: string, category?: ClientCategory) => `${who} ${category ? categoryMoves[category](name) : `moved ${name} to ${stage}`}`;

/** A new team chat message: mentioned teammates hear "mentioned you" first; those who want every message hear the rest. */
export function chatTargets(mentioned: string[], listeners: string[], notices: { mention: Notice; message: Notice }): Target[] {
  return [...mentioned.map((userId) => ({ userId, notices: [notices.mention, notices.message] })), ...listeners.filter((id) => !mentioned.includes(id)).map((userId) => ({ userId, notices: [notices.message] }))];
}
