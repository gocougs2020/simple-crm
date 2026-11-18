"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { run, type Result } from "@/lib/action";
import { actionEditor, actionUser } from "@/lib/auth";
import type { AgentDraftKind } from "@/lib/constants";
import { sessionActor } from "@/lib/crm/actor";
import * as svc from "@/lib/crm/service/drafts";

/**
 * Drafts the agent wrote for the signed-in teammate (docs/AGENT.md). They
 * review one in the person's composer and send it the usual way; these
 * actions only list drafts and mark them sent or discarded.
 */

export type PersonDraft = { id: string; kind: AgentDraftKind; subject: string | null; body: string; clientId: string | null; createdAt: string };

const uuid = z.uuid("That draft doesn't exist.");

/** The teammate's own drafts to this person that are still waiting. */
export async function listPersonDrafts(personId: string): Promise<Result<PersonDraft[]>> {
  return run(async () => {
    const user = await actionUser();
    const rows = await svc.listDrafts(sessionActor(user), { personId: z.uuid().parse(personId) });
    return rows.map((d) => ({ id: d.id, kind: d.kind, subject: d.subject, body: d.body, clientId: d.clientId, createdAt: d.createdAt.toISOString() }));
  });
}

/** After the teammate sends a draft from the composer, or decides not to. */
export async function resolveDraft(draftId: string, outcome: "sent" | "discarded"): Promise<Result> {
  return run(async () => {
    const user = await actionEditor();
    await svc.resolveDraft(sessionActor(user), uuid.parse(draftId), z.enum(["sent", "discarded"]).parse(outcome));
    refresh();
  });
}
