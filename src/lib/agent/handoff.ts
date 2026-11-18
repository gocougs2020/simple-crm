import "server-only";
import { eq } from "drizzle-orm";
import { appConfig } from "@/app.config";
import { getDb, schema } from "@/db";
import type { Actor } from "@/lib/crm/actor";
import { escapeHtml } from "@/lib/email/merge-tags";
import { ActionError } from "@/lib/errors";
import { htmlToText } from "@/lib/safe-html";
import { assistantActor } from "./actor";
import { assertCanStart, startRun, supersedeRuns } from "./runs";

/**
 * Handing work to the agent from a record: a task given to it, or a note
 * that mentions it. Called from the activity service, so it works the same
 * from the browser, the API and MCP. The run acts as whoever handed it over.
 */

type Handed = Pick<typeof schema.activities.$inferSelect, "id" | "type" | "subject" | "body" | "personId" | "organizationId" | "clientId">;

/** Refuses up front, with a sentence, when the agent can't take work right now (turned off, budget spent, read-only access). */
export async function assertCanHandOff(actor: Actor, activityId?: string) {
  await assertCanStart(actor);
  // Handing over a task someone else's run is working on is refused before anything is saved.
  if (activityId) await supersedeRuns(actor, activityId, { check: true });
}

/** Starts a run for a task or note and links it, so the timeline can show how it's going. */
export async function handOff(actor: Actor, activity: Handed, source: "task" | "mention", thread?: string) {
  const text = thread ?? [activity.subject, htmlToText(activity.body)].filter(Boolean).join("\n\n").trim();
  await assertCanStart(actor);
  await supersedeRuns(actor, activity.id);
  const run = await startRun(
    actor,
    { prompt: text, title: activity.subject || htmlToText(activity.body) || text, source, activityId: activity.id, personId: activity.personId, organizationId: activity.organizationId, clientId: activity.clientId },
  );
  const db = await getDb();
  await db.update(schema.activities).set({ agentRunId: run.id }).where(eq(schema.activities.id, activity.id));
  return run;
}

/**
 * A note, or a reply under one, mentioned the agent. It's already saved, so a
 * refusal (the budget is spent, say) becomes a short reply under the note
 * instead of an error. `thread` is the note with its replies, when the
 * mention came in a reply.
 */
export async function handOffMention(actor: Actor, note: Handed, thread?: string) {
  try {
    await handOff(actor, note, "mention", thread);
  } catch (err) {
    if (!(err instanceof ActionError) || actor.kind !== "user") {
      console.error("[agent] mention", err);
      return;
    }
    const { replyToNote } = await import("@/lib/crm/service/activities");
    await replyToNote(await assistantActor(actor.user), note.id, { body: `<p><strong>${appConfig.agent.name} couldn't start.</strong> ${escapeHtml(err.message)}</p>` }, { handOff: false }).catch((e) =>
      console.error("[agent] mention reply", e),
    );
  }
}
