import "server-only";
import { eq } from "drizzle-orm";
import { appConfig } from "@/app.config";
import { getDb, schema } from "@/db";
import type { Actor } from "@/lib/crm/actor";
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
export async function handOff(actor: Actor, activity: Handed, source: "task" | "mention") {
  const text = [activity.subject, htmlToText(activity.body)].filter(Boolean).join("\n\n").trim();
  await assertCanStart(actor);
  await supersedeRuns(actor, activity.id);
  const run = await startRun(
    actor,
    { prompt: text, title: activity.subject || text, source, activityId: activity.id, personId: activity.personId, organizationId: activity.organizationId, clientId: activity.clientId },
  );
  const db = await getDb();
  await db.update(schema.activities).set({ agentRunId: run.id }).where(eq(schema.activities.id, activity.id));
  return run;
}

/**
 * A note mentioned the agent. The note is already saved, so a refusal
 * (the budget is spent, say) becomes a short reply on the same record instead
 * of an error.
 */
export async function handOffMention(actor: Actor, note: Handed) {
  try {
    await handOff(actor, note, "mention");
  } catch (err) {
    if (!(err instanceof ActionError) || actor.kind !== "user") {
      console.error("[agent] mention", err);
      return;
    }
    const { logActivity } = await import("@/lib/crm/service/activities");
    await logActivity(
      await assistantActor(actor.user),
      { type: "note", subject: `${appConfig.agent.name} couldn't start`, body: err.message, personId: note.personId, organizationId: note.organizationId, clientId: note.clientId },
      { handOff: false },
    ).catch((e) => console.error("[agent] mention reply", e));
  }
}
