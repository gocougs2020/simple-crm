import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { appConfig } from "@/app.config";
import { getDb, schema } from "@/db";
import type { AgentDraftStatus } from "@/lib/constants";
import { assertCan, type Actor } from "@/lib/crm/actor";
import { draftInput, type DraftInput } from "@/lib/crm/schemas";
import { ActionError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { resolveAttachments } from "@/lib/email/attachments";
import { notify } from "@/lib/push/notify";
import { sanitizeHtml, textToHtml, htmlToText } from "@/lib/safe-html";

/**
 * Drafts: emails and texts written for a teammate to review and send. This is
 * how the agent "sends" a message: it writes one here, and the teammate
 * opens it in the person's composer, edits it if they like, and sends it the
 * usual way. Nothing in this file sends anything.
 */

const drafts = schema.agentDrafts;
export type Draft = typeof drafts.$inferSelect;

const richTag = /<(p|br|strong|b|em|i|u|a|ul|ol|li|blockquote)\b[^>]*>/i;

function owner(a: Actor) {
  if (a.kind !== "user") throw new ForbiddenError("A draft is written for one teammate to send. Use a personal key or a connected app, not a workspace key.");
  return a.user;
}

/** Writes a draft for the actor's teammate. Returns it with the page where they review and send it. */
export async function createDraft(a: Actor, input: DraftInput) {
  assertCan(a, "records:write");
  const user = owner(a);
  const runId = a.kind === "user" ? (a.runId ?? null) : null;
  const data = draftInput.parse(input);
  const db = await getDb();
  const [person] = await db
    .select({ id: schema.people.id, firstName: schema.people.firstName, lastName: schema.people.lastName, email: schema.people.email, phone: schema.people.phone, textOptOutAt: schema.people.textOptOutAt, archivedAt: schema.people.archivedAt })
    .from(schema.people)
    .where(eq(schema.people.id, data.personId));
  if (!person || person.archivedAt) throw new NotFoundError("That person doesn't exist.");
  const name = [person.firstName, person.lastName].filter(Boolean).join(" ");
  if (data.kind === "email") {
    if (!person.email) throw new ActionError(`${name} has no email address. Add one to their record first.`);
    if (!data.subject) throw new ActionError("Give the email a subject.");
  } else {
    if (!person.phone) throw new ActionError(`${name} has no phone number. Add one to their record first.`);
    if (person.textOptOutAt) throw new ActionError(`${name} replied STOP, so texts to them are blocked.`);
    if (htmlToText(data.body).length > 1600) throw new ActionError("Texts can be up to 1,600 characters.");
  }
  if (data.clientId) {
    const [client] = await db.select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.id, data.clientId));
    if (!client) throw new NotFoundError("That client doesn't exist.");
  }
  const body = data.kind === "email" ? sanitizeHtml(richTag.test(data.body) ? data.body : textToHtml(data.body)) : htmlToText(data.body);
  if (!htmlToText(body)) throw new ActionError("Write the message first.");
  if (data.attachmentFileIds?.length && data.kind !== "email") throw new ActionError("Only emails can carry files. Leave out attachmentFileIds for a text, or put the file's public link in it.");
  const attachments = data.attachmentFileIds?.length ? await resolveAttachments(data.attachmentFileIds) : [];
  const [row] = await db
    .insert(drafts)
    .values({ userId: user.id, runId, kind: data.kind, personId: person.id, clientId: data.clientId ?? null, subject: data.kind === "email" ? (data.subject ?? null) : null, body, attachments })
    .returning();
  // From background work the teammate isn't looking: tell them something is waiting.
  if (runId) {
    notify([user.id], {
      kind: "agent_done",
      title: `${appConfig.agent.name} drafted ${data.kind === "email" ? "an email" : "a text"} to ${name}`,
      body: data.kind === "email" ? (row.subject ?? "Review it and send.") : "Review it and send.",
      url: draftUrl(row),
      dedupeKey: `agent_draft:${row.id}`,
    });
  }
  return { ...row, personName: name };
}

/** Where a draft is reviewed and sent: the person's page, with the draft opened in the composer. */
export const draftUrl = (d: Pick<Draft, "id" | "personId">) => `/people/${d.personId}?draft=${d.id}`;

/** The actor's teammate's drafts, newest first. Drafts are private to whoever they were written for. */
export async function listDrafts(a: Actor, opts: { personId?: string; status?: AgentDraftStatus; limit?: number } = {}) {
  assertCan(a, "records:read");
  const user = owner(a);
  const db = await getDb();
  return db
    .select({ draft: drafts, firstName: schema.people.firstName, lastName: schema.people.lastName })
    .from(drafts)
    .innerJoin(schema.people, eq(schema.people.id, drafts.personId))
    .where(and(eq(drafts.userId, user.id), eq(drafts.status, opts.status ?? "pending"), opts.personId ? eq(drafts.personId, opts.personId) : undefined))
    .orderBy(desc(drafts.createdAt))
    .limit(Math.min(opts.limit ?? 50, 100))
    .then((rows) => rows.map((r) => ({ ...r.draft, personName: [r.firstName, r.lastName].filter(Boolean).join(" ") })));
}

/** Marks a pending draft sent (the teammate sent it from the composer) or discarded. Only its owner, in person: never an agent. */
export async function resolveDraft(a: Actor, draftId: string, status: Exclude<AgentDraftStatus, "pending">) {
  assertCan(a, "records:write");
  const user = owner(a);
  if (a.keyId) throw new ForbiddenError("Drafts are sent or discarded by the teammate themselves, from the person's page.");
  const db = await getDb();
  const [row] = await db
    .update(drafts)
    .set({ status, decidedAt: new Date() })
    .where(and(eq(drafts.id, z.uuid().parse(draftId)), eq(drafts.userId, user.id), eq(drafts.status, "pending")))
    .returning({ id: drafts.id });
  if (!row) throw new NotFoundError("That draft was already sent or discarded.");
  return row;
}
