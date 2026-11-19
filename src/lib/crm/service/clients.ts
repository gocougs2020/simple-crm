import "server-only";
import { recordAssigned } from "@/lib/push/triggers";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { clientCategoryLabels, type ClientCategory } from "@/lib/constants";
import { actorUserId, assertCan, stamp, type Actor } from "@/lib/crm/actor";
import { cleanCustomValues } from "@/lib/crm/custom-fields";
import { diff, labelRelations, recordEvent } from "@/lib/crm/events";
import { withCustomChanges, workspaceToday } from "@/lib/crm/inputs";
import { ensureLabels } from "@/lib/crm/labels";
import { categoryInput, clientCreateInput, clientInput, id, metricInput, subscriptionInput } from "@/lib/crm/schemas";
import { assertOrganization, assertPerson, assertUser, insertOrganization, insertPersonByName } from "@/lib/crm/service/records";
import { ActionError, NotFoundError } from "@/lib/errors";
import { rankBetween } from "@/lib/rank";

/** Clients: creating, editing, moving through stages and categories, services and performance numbers. Shared by the browser, the API and MCP. */

const { clients, stages, pipelines, people, services, servicePlans, clientServices, clientMetrics } = schema;

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

  const serviceIds = data.serviceIds ?? [];
  if (serviceIds.length && category !== "prospective") {
    const list = await db.select().from(services).where(inArray(services.id, serviceIds));
    if (list.length)
      await db.insert(clientServices).values(
        list.map((s) => ({ clientId: row.id, serviceId: s.id, price: s.price, interval: s.interval, startedOn: category === "current" ? today : null, endedOn: category === "past" ? (data.endedOn ?? today) : null })),
      );
  }
  return row;
}

export async function updateClient(a: Actor, clientId: string, patch: Partial<z.input<typeof clientInput>>) {
  assertCan(a, "records:write");
  const data = clientInput.partial().parse(patch);
  await Promise.all([assertUser(data.ownerId, "owner"), assertPerson(data.personId), assertOrganization(data.organizationId)]);
  const db = await getDb();
  const before = await getClientRow(clientId);
  const custom = data.custom ? { ...before.custom, ...(await cleanCustomValues("client", data.custom)) } : undefined;
  await db
    .update(clients)
    .set({ ...data, custom, updatedAt: new Date() })
    .where(eq(clients.id, before.id));
  await ensureLabels(data.tags);
  const changes = [...(await labelRelations(diff(before, { ...data, custom: undefined }, clientLabels))), ...(await withCustomChanges("client", before.custom, custom))];
  if (changes.length) await recordEvent({ entityType: "client", entityId: before.id, action: "updated", data: { changes }, ...stamp(a) });
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
  }
  return { id: client.id };
}

/**
 * Signing a prospect, a client leaving, or a past client coming back. Moves
 * the client into the new category's pipeline, records the dates and reason,
 * and keeps services in step (leaving ends them; signing can start some).
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

  if (data.category === "past" && data.endServices !== false)
    await db.update(clientServices).set({ endedOn: on }).where(and(eq(clientServices.clientId, client.id), isNull(clientServices.endedOn)));
  if (data.category === "current" && data.serviceIds?.length) {
    const list = await db.select().from(services).where(inArray(services.id, data.serviceIds));
    if (list.length) await db.insert(clientServices).values(list.map((s) => ({ clientId: client.id, serviceId: s.id, price: s.price, interval: s.interval, startedOn: on })));
  }
  await recordEvent({
    entityType: "client",
    entityId: client.id,
    action: "category_changed",
    data: { from: client.category, to: data.category, on, reason: data.category === "past" ? data.churnReason : undefined, stage: target.stage.name },
    ...stamp(a),
  });
  return { id: client.id };
}

// ─── Services on a client ────────────────────────────────────────────────

export async function addClientService(a: Actor, clientId: string, serviceId: string, input: z.input<typeof subscriptionInput> = {}) {
  assertCan(a, "records:write");
  const data = subscriptionInput.parse(input);
  const db = await getDb();
  const client = await getClientRow(clientId);
  const [service] = await db.select().from(services).where(eq(services.id, id.parse(serviceId)));
  if (!service || service.archivedAt) throw new NotFoundError("That service isn't offered anymore. Pick another one.");
  const plan = data.planId ? await planOf(service.id, data.planId) : null;
  if (plan?.archivedAt) throw new NotFoundError("That plan isn't offered anymore. Pick another one.");
  const today = await workspaceToday();
  const [row] = await db
    .insert(clientServices)
    .values({
      clientId: client.id,
      serviceId: service.id,
      planId: plan?.id ?? null,
      // The plan's price, billing and description are the starting point; what this client pays can differ.
      price: data.price ?? (plan ?? service).price,
      interval: data.interval ?? (plan ?? service).interval,
      startedOn: data.startedOn ?? (client.category === "current" ? today : null),
      endedOn: data.endedOn ?? (client.category === "past" ? (client.endedOn ?? today) : null),
      note: data.note ?? plan?.description?.slice(0, 300) ?? null,
    })
    .returning({ id: clientServices.id });
  await recordEvent({ entityType: "client", entityId: client.id, action: "service_added", data: { name: plan ? `${service.name} · ${plan.name}` : service.name }, ...stamp(a) });
  return row;
}

/** A plan, checked to belong to the service it's being used with. */
async function planOf(serviceId: string, planId: string) {
  const db = await getDb();
  const [plan] = await db.select().from(servicePlans).where(and(eq(servicePlans.id, planId), eq(servicePlans.serviceId, serviceId)));
  if (!plan) throw new NotFoundError("That plan isn't one of this service's plans. Pick one from the service's list.");
  return plan;
}

async function getSubscription(rowId: string, clientId?: string) {
  const db = await getDb();
  const [row] = await db.select({ cs: clientServices, name: services.name }).from(clientServices).innerJoin(services, eq(services.id, clientServices.serviceId)).where(eq(clientServices.id, id.parse(rowId)));
  if (!row || (clientId && row.cs.clientId !== clientId)) throw new NotFoundError("That service was removed from this client.");
  return row;
}

export async function updateClientService(a: Actor, rowId: string, patch: z.input<typeof subscriptionInput>, clientId?: string) {
  assertCan(a, "records:write");
  // Partial, so fields left out stay as they are (otherwise they'd parse to null and clear the start date and note).
  const data = subscriptionInput.partial().parse(patch);
  const db = await getDb();
  const row = await getSubscription(rowId, clientId);
  const planChanged = data.planId !== undefined && data.planId !== row.cs.planId;
  const plan = planChanged && data.planId ? await planOf(row.cs.serviceId, data.planId) : null;
  await db.update(clientServices).set(data).where(eq(clientServices.id, row.cs.id));
  const ended = data.endedOn && !row.cs.endedOn;
  const changes = diff(row.cs, data, { price: `${row.name} price`, interval: `${row.name} billing`, startedOn: `${row.name} start`, endedOn: `${row.name} end` });
  if (planChanged) {
    const [before] = row.cs.planId ? await db.select({ name: servicePlans.name }).from(servicePlans).where(eq(servicePlans.id, row.cs.planId)) : [];
    changes.push({ field: "planId", label: `${row.name} plan`, from: before?.name ?? null, to: plan?.name ?? null });
  }
  if (ended) await recordEvent({ entityType: "client", entityId: row.cs.clientId, action: "service_ended", data: { name: row.name, on: data.endedOn }, ...stamp(a) });
  else if (changes.length) await recordEvent({ entityType: "client", entityId: row.cs.clientId, action: "updated", data: { changes }, ...stamp(a) });
  return { id: row.cs.id };
}

export async function removeClientService(a: Actor, rowId: string, clientId?: string) {
  assertCan(a, "records:write");
  const db = await getDb();
  const row = await getSubscription(rowId, clientId).catch(() => null);
  if (!row) return;
  await db.delete(clientServices).where(eq(clientServices.id, row.cs.id));
  await recordEvent({ entityType: "client", entityId: row.cs.clientId, action: "service_removed", data: { name: row.name }, ...stamp(a) });
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
