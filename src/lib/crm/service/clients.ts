import "server-only";
import { clientStageChanged, recordAssigned } from "@/lib/push/triggers";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { clientCategoryLabels, type ClientCategory } from "@/lib/constants";
import { actorUserId, assertCan, stamp, type Actor } from "@/lib/crm/actor";
import { cleanCustomValues } from "@/lib/crm/custom-fields";
import { diff, eventRow, labelRelations, recordEvent } from "@/lib/crm/events";
import { writeBatch } from "@/db/batch";
import { withCustomChanges, workspaceToday } from "@/lib/crm/inputs";
import { ensureLabels } from "@/lib/crm/labels";
import { categoryInput, clientCreateInput, clientInput, id, metricInput } from "@/lib/crm/schemas";
import { assertOrganization, assertPerson, assertUser, insertOrganization, insertPersonByName } from "@/lib/crm/service/records";
import { ActionError, NotFoundError } from "@/lib/errors";
import { rankBetween } from "@/lib/rank";

/** Clients: creating, editing, moving through stages and categories, their people and performance numbers. Shared by the browser, the API and MCP. */

const { clients, stages, pipelines, people, clientMetrics, clientPeople } = schema;

const clientLabels = {
  name: "Name",
  value: "Potential value",
  expectedCloseDate: "Expected close",
  startedOn: "Client since",
  endedOn: "Left on",
  churnReason: "Reason for leaving",
  openToReturn: "Open to coming back",
  health: "Health",
  tags: "Labels",
  personId: "Contact",
  organizationId: "Organization",
  ownerId: "Owner",
} as const;

/** The first stage of the first pipeline for a category: where a client lands when nothing else is said. */
async function defaultStage(category: ClientCategory) {
  const db = await getDb();
  const [s] = await db
    .select({ stage: stages })
    .from(stages)
    .innerJoin(pipelines, eq(pipelines.id, stages.pipelineId))
    .where(eq(pipelines.category, category))
    .orderBy(asc(pipelines.position), asc(pipelines.createdAt), asc(stages.position))
    .limit(1);
  if (!s) throw new ActionError(`There's no pipeline for ${clientCategoryLabels[category].one.toLowerCase()} clients. Add one in Settings → Pipelines.`);
  return s.stage;
}

async function stageWithCategory(stageId: string) {
  const db = await getDb();
  const [row] = await db.select({ stage: stages, category: pipelines.category }).from(stages).innerJoin(pipelines, eq(pipelines.id, stages.pipelineId)).where(eq(stages.id, id.parse(stageId)));
  if (!row) throw new NotFoundError("That stage no longer exists. Reload and pick another.");
  return row;
}

/** New clients go to the top of their column. */
async function topRank(stageId: string) {
  const db = await getDb();
  const [top] = await db.select({ rank: clients.rank }).from(clients).where(and(eq(clients.stageId, stageId), isNull(clients.archivedAt))).orderBy(asc(clients.rank)).limit(1);
  return rankBetween(null, top?.rank);
}

async function getClientRow(clientId: string) {
  const db = await getDb();
  const [client] = await db.select().from(clients).where(eq(clients.id, id.parse(clientId)));
  if (!client) throw new NotFoundError("This client was deleted.");
  return client;
}

export async function createClient(a: Actor, input: z.input<typeof clientCreateInput> & { newOrganizationName?: string; newPersonName?: string }) {
  assertCan(a, "records:write");
  const data = clientCreateInput.parse(input);
  const category = data.category;
  await Promise.all([assertUser(data.ownerId, "owner"), assertPerson(data.personId), assertOrganization(data.organizationId)]);
  const db = await getDb();
  const target = data.stageId ? await stageWithCategory(data.stageId) : { stage: await defaultStage(category), category };
  if (target.category !== category) throw new ActionError("That stage belongs to another category. Pick one of its own stages.");
  const stage = target.stage;

  let organizationId = data.organizationId ?? null;
  if (!organizationId && input.newOrganizationName?.trim()) organizationId = (await insertOrganization(a, { name: input.newOrganizationName.trim() })).id;
  let personId = data.personId ?? null;
  if (!personId && input.newPersonName?.trim()) personId = (await insertPersonByName(a, input.newPersonName, organizationId)).id;
  // A client whose contact works somewhere is that organization's client too.
  if (personId && !organizationId) {
    const [p] = await db.select({ organizationId: people.organizationId }).from(people).where(eq(people.id, personId));
    organizationId = p?.organizationId ?? null;
  }
  const today = await workspaceToday();
  const [ws] = await db.select({ currency: schema.workspace.currency }).from(schema.workspace).limit(1);
  const [row] = await db
    .insert(clients)
    .values({
      name: data.name,
      category,
      value: data.value ?? 0,
      currency: ws?.currency ?? "USD",
      pipelineId: stage.pipelineId,
      stageId: stage.id,
      personId,
      organizationId,
      ownerId: data.ownerId === undefined ? actorUserId(a) : data.ownerId,
      expectedCloseDate: category === "prospective" ? data.expectedCloseDate : null,
      startedOn: category === "prospective" ? null : (data.startedOn ?? (category === "current" ? today : null)),
      endedOn: category === "past" ? (data.endedOn ?? null) : null,
      churnReason: category === "past" ? data.churnReason : null,
      openToReturn: data.openToReturn ?? true,
      health: category === "current" ? (data.health ?? null) : null,
      tags: data.tags ?? [],
      rank: await topRank(stage.id),
      custom: data.custom ? await cleanCustomValues("client", data.custom) : {},
      createdBy: actorUserId(a),
    })
    .returning({ id: clients.id });
  await ensureLabels(data.tags);
  await recordEvent({ entityType: "client", entityId: row.id, action: "created", data: { stage: stage.name, category }, ...stamp(a) });
  recordAssigned(a, { entity: "client", id: row.id, name: data.name, ownerId: data.ownerId === undefined ? actorUserId(a) : data.ownerId });
  return row;
}

export async function updateClient(a: Actor, clientId: string, patch: Partial<z.input<typeof clientInput>>) {
  assertCan(a, "records:write");
  const data = clientInput.partial().parse(patch);
  await Promise.all([assertUser(data.ownerId, "owner"), assertPerson(data.personId), assertOrganization(data.organizationId)]);
  const before = await getClientRow(clientId);
  const custom = data.custom ? { ...before.custom, ...(await cleanCustomValues("client", data.custom)) } : undefined;
  // What changed is worked out first (it only reads), so the update, the People card and the history entry go together: one round trip, one transaction.
  const [related, customChanges] = await Promise.all([labelRelations(diff(before, { ...data, custom: undefined }, clientLabels)), withCustomChanges("client", before.custom, custom)]);
  const changes = [...related, ...customChanges];
  const newContact = data.personId !== undefined && data.personId !== before.personId;
  await writeBatch((d) => [
    d
      .update(clients)
      .set({ ...data, custom, updatedAt: new Date() })
      .where(eq(clients.id, before.id)),
    // A new contact doesn't take the old one off the client: they stay on its People card. The new one no longer needs a row of their own.
    ...(newContact && before.personId ? [d.insert(clientPeople).values({ clientId: before.id, personId: before.personId }).onConflictDoNothing()] : []),
    ...(newContact && data.personId ? [d.delete(clientPeople).where(and(eq(clientPeople.clientId, before.id), eq(clientPeople.personId, data.personId)))] : []),
    ...(changes.length ? [d.insert(schema.events).values(eventRow({ entityType: "client", entityId: before.id, action: "updated", data: { changes }, ...stamp(a) }))] : []),
  ]);
  await ensureLabels(data.tags);
  if (data.ownerId !== undefined) recordAssigned(a, { entity: "client", id: before.id, name: data.name ?? before.name, ownerId: data.ownerId, previousOwnerId: before.ownerId });
  return { id: before.id };
}

/**
 * Moves a client to a stage of its own category (and a spot in its column).
 * `beforeId`/`afterId` are the cards it lands between; only this client is
 * written. Moving to another category goes through changeClientCategory.
 */
export async function moveClient(a: Actor, clientId: string, stageId: string, place?: { beforeId?: string | null; afterId?: string | null }) {
  assertCan(a, "records:write");
  const db = await getDb();
  const client = await getClientRow(clientId);
  const { stage, category } = await stageWithCategory(stageId);
  if (category !== client.category) throw new ActionError(`That stage is for ${clientCategoryLabels[category].one.toLowerCase()} clients. Change the category instead.`);
  const ids = [place?.beforeId, place?.afterId].filter((x): x is string => !!x);
  const neighbours = ids.length ? await db.select({ id: clients.id, rank: clients.rank }).from(clients).where(inArray(clients.id, ids)) : [];
  const rankOf = (x?: string | null) => neighbours.find((n) => n.id === x)?.rank ?? null;
  // Moved from a menu, the stage bar or the API: top of the new column.
  const rank = place ? rankBetween(rankOf(place.beforeId), rankOf(place.afterId)) : await topRank(stage.id);
  const changedStage = stage.id !== client.stageId;
  await db
    .update(clients)
    .set({ stageId: stage.id, pipelineId: stage.pipelineId, rank, updatedAt: new Date(), ...(changedStage ? { stageChangedAt: new Date() } : {}) })
    .where(eq(clients.id, client.id));
  if (changedStage) {
    const [from] = await db.select({ name: stages.name }).from(stages).where(eq(stages.id, client.stageId));
    await recordEvent({ entityType: "client", entityId: client.id, action: "stage_changed", data: { from: from?.name ?? null, to: stage.name }, ...stamp(a) });
    clientStageChanged(a, { id: client.id, name: client.name, ownerId: client.ownerId, stage: stage.name });
  }
  return { id: client.id };
}

/**
 * Signing a prospect, a client leaving, or a past client coming back. Moves
 * the client into the new category's pipeline, records the dates and reason,
 * What they pay is Stripe's to say, so no billing changes here.
 */
export async function changeClientCategory(a: Actor, clientId: string, input: z.input<typeof categoryInput>) {
  assertCan(a, "records:write");
  const data = categoryInput.parse(input);
  const db = await getDb();
  const client = await getClientRow(clientId);
  if (client.category === data.category) return { id: client.id };
  const target = data.stageId ? await stageWithCategory(data.stageId) : { stage: await defaultStage(data.category), category: data.category };
  if (target.category !== data.category) throw new ActionError("That stage belongs to another category. Pick one of its own stages.");
  const on = data.on ?? (await workspaceToday());
  const now = new Date();

  const set: Partial<typeof clients.$inferInsert> = {
    category: data.category,
    pipelineId: target.stage.pipelineId,
    stageId: target.stage.id,
    rank: await topRank(target.stage.id),
    stageChangedAt: now,
    categoryChangedAt: now,
    updatedAt: now,
  };
  if (data.category === "current") Object.assign(set, { startedOn: on, endedOn: null, churnReason: null, openToReturn: true });
  if (data.category === "past") Object.assign(set, { endedOn: on, churnReason: data.churnReason, openToReturn: data.openToReturn ?? true, health: null });
  await db.update(clients).set(set).where(eq(clients.id, client.id));

  await recordEvent({
    entityType: "client",
    entityId: client.id,
    action: "category_changed",
    data: { from: client.category, to: data.category, on, reason: data.category === "past" ? data.churnReason : undefined, stage: target.stage.name },
    ...stamp(a),
  });
  clientStageChanged(a, { id: client.id, name: client.name, ownerId: client.ownerId, stage: target.stage.name, category: data.category });
  return { id: client.id };
}

// ─── People on a client ──────────────────────────────────────────────────

const nameOf = (p: { firstName: string; lastName: string | null }) => [p.firstName, p.lastName].filter(Boolean).join(" ");

/**
 * Adds a person to a client, besides its contact. They show on the client's
 * People card and can be called, emailed, texted or put on a meeting from it.
 * A client with no contact yet takes them as its contact.
 */
export async function addClientPerson(a: Actor, clientId: string, personId: string) {
  assertCan(a, "records:write");
  const db = await getDb();
  const client = await getClientRow(clientId);
  const [person] = await db.select().from(people).where(eq(people.id, id.parse(personId)));
  if (!person) throw new NotFoundError("That person doesn't exist.");
  if (client.personId === person.id) return { id: person.id };
  if (!client.personId) {
    await updateClient(a, client.id, { personId: person.id });
    return { id: person.id };
  }
  const added = await db.insert(clientPeople).values({ clientId: client.id, personId: person.id }).onConflictDoNothing().returning({ personId: clientPeople.personId });
  if (added.length) await recordEvent({ entityType: "client", entityId: client.id, action: "person_added", data: { personId: person.id, name: nameOf(person) }, ...stamp(a) });
  return { id: person.id };
}

/** Takes a person added by hand off a client. The contact is changed on the client itself, and people at its organization show for as long as they're there. */
export async function removeClientPerson(a: Actor, clientId: string, personId: string) {
  assertCan(a, "records:write");
  const db = await getDb();
  const client = await getClientRow(clientId);
  if (client.personId === id.parse(personId)) throw new ActionError("They're this client's contact. Pick another contact first, then remove them.");
  const removed = await db.delete(clientPeople).where(and(eq(clientPeople.clientId, client.id), eq(clientPeople.personId, personId))).returning({ personId: clientPeople.personId });
  if (!removed.length) return;
  const [person] = await db.select().from(people).where(eq(people.id, personId));
  await recordEvent({ entityType: "client", entityId: client.id, action: "person_removed", data: { personId, name: person ? nameOf(person) : null }, ...stamp(a) });
}

// ─── Performance ─────────────────────────────────────────────────────────

export async function logClientMetric(a: Actor, clientId: string, input: z.input<typeof metricInput>) {
  assertCan(a, "records:write");
  const data = metricInput.parse(input);
  const db = await getDb();
  const client = await getClientRow(clientId);
  // Same label (any capitalization) is the same series.
  const [existing] = await db.select({ label: clientMetrics.label }).from(clientMetrics).where(and(eq(clientMetrics.clientId, client.id), sql`lower(${clientMetrics.label}) = lower(${data.label})`)).limit(1);
  const [row] = await db
    .insert(clientMetrics)
    .values({ ...data, label: existing?.label ?? data.label, clientId: client.id, userId: actorUserId(a) })
    .returning({ id: clientMetrics.id });
  return row;
}

export async function deleteClientMetric(a: Actor, metricId: string, clientId?: string) {
  assertCan(a, "records:write");
  const db = await getDb();
  const where = clientId ? and(eq(clientMetrics.id, id.parse(metricId)), eq(clientMetrics.clientId, clientId)) : eq(clientMetrics.id, id.parse(metricId));
  await db.delete(clientMetrics).where(where);
}
