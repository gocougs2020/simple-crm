"use server";

import { refresh } from "next/cache";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { run, type Result } from "@/lib/action";
import { ActionError, actionUser } from "@/lib/auth";
import { billingIntervals, clientCategories, clientCategoryLabels, clientHealths, type ClientCategory } from "@/lib/constants";
import { cleanCustomValues } from "@/lib/crm/custom-fields";
import { diff, labelRelations, recordEvent } from "@/lib/crm/events";
import { id, insertOrganization, insertPersonByName, name, optionalDate, optionalId, optionalText, tagList, withCustomChanges, workspaceToday } from "@/lib/crm/inputs";
import { rankBetween } from "@/lib/rank";
import { searchCustomers, getCustomer, StripeError } from "@/lib/stripe";

const { clients, stages, pipelines, people, services, clientServices, clientMetrics } = schema;

const clientLabels = {
  name: "Name",
  value: "Potential value",
  expectedCloseDate: "Expected close",
  startedOn: "Client since",
  endedOn: "Left on",
  churnReason: "Reason for leaving",
  openToReturn: "Open to coming back",
  health: "Health",
  tags: "Tags",
  personId: "Contact",
  organizationId: "Organization",
  ownerId: "Owner",
} as const;

const clientInput = z.object({
  name: name("a name", 160),
  value: z.number().int().min(0).max(1e15).optional(),
  personId: optionalId,
  organizationId: optionalId,
  ownerId: optionalId,
  expectedCloseDate: optionalDate,
  startedOn: optionalDate,
  endedOn: optionalDate,
  churnReason: optionalText(300),
  openToReturn: z.boolean().optional(),
  health: z.enum(clientHealths).nullable().optional(),
  tags: tagList.optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
});

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
  if (!row) throw new ActionError("That stage no longer exists. Reload and pick another.");
  return row;
}

/** New clients go to the top of their column. */
async function topRank(stageId: string) {
  const db = await getDb();
  const [top] = await db.select({ rank: clients.rank }).from(clients).where(and(eq(clients.stageId, stageId), isNull(clients.archivedAt))).orderBy(asc(clients.rank)).limit(1);
  return rankBetween(null, top?.rank);
}

export async function createClient(
  input: z.input<typeof clientInput> & { category: ClientCategory; stageId?: string | null; serviceIds?: string[]; newOrganizationName?: string; newPersonName?: string },
): Promise<Result<{ id: string }>> {
  return run(async () => {
    const user = await actionUser();
    const data = clientInput.parse(input);
    const category = z.enum(clientCategories).parse(input.category);
    const db = await getDb();
    const target = input.stageId ? await stageWithCategory(input.stageId) : { stage: await defaultStage(category), category };
    if (target.category !== category) throw new ActionError("That stage belongs to another category. Pick one of its own stages.");
    const stage = target.stage;

    let organizationId = data.organizationId ?? null;
    if (!organizationId && input.newOrganizationName?.trim()) organizationId = (await insertOrganization({ name: input.newOrganizationName.trim() }, user.id)).id;
    let personId = data.personId ?? null;
    if (!personId && input.newPersonName?.trim()) personId = (await insertPersonByName(input.newPersonName, organizationId, user.id)).id;
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
        ownerId: data.ownerId === undefined ? user.id : data.ownerId,
        expectedCloseDate: category === "prospective" ? data.expectedCloseDate : null,
        startedOn: category === "prospective" ? null : (data.startedOn ?? (category === "current" ? today : null)),
        endedOn: category === "past" ? (data.endedOn ?? null) : null,
        churnReason: category === "past" ? data.churnReason : null,
        openToReturn: data.openToReturn ?? true,
        tags: data.tags ?? [],
        rank: await topRank(stage.id),
        custom: data.custom ? await cleanCustomValues("client", data.custom) : {},
        createdBy: user.id,
      })
      .returning({ id: clients.id });
    await recordEvent({ entityType: "client", entityId: row.id, action: "created", data: { stage: stage.name, category }, userId: user.id });

    const serviceIds = z.array(id).max(50).parse(input.serviceIds ?? []);
    if (serviceIds.length && category !== "prospective") {
      const list = await db.select().from(services).where(inArray(services.id, serviceIds));
      if (list.length)
        await db.insert(clientServices).values(
          list.map((s) => ({ clientId: row.id, serviceId: s.id, price: s.price, interval: s.interval, startedOn: category === "current" ? today : null, endedOn: category === "past" ? (data.endedOn ?? today) : null })),
        );
    }
    refresh();
    return row;
  });
}

export async function updateClient(clientId: string, patch: Partial<z.input<typeof clientInput>>): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const data = clientInput.partial().parse(patch);
    const db = await getDb();
    const [before] = await db.select().from(clients).where(eq(clients.id, id.parse(clientId)));
    if (!before) throw new ActionError("This client was deleted.");
    const custom = data.custom ? { ...before.custom, ...(await cleanCustomValues("client", data.custom)) } : undefined;
    await db
      .update(clients)
      .set({ ...data, custom, updatedAt: new Date() })
      .where(eq(clients.id, before.id));
    const changes = [...(await labelRelations(diff(before, { ...data, custom: undefined }, clientLabels))), ...(await withCustomChanges("client", before.custom, custom))];
    if (changes.length) await recordEvent({ entityType: "client", entityId: before.id, action: "updated", data: { changes }, userId: user.id });
    refresh();
  });
}

/**
 * Moves a client to a stage of its own category (and a spot in its column).
 * `beforeId`/`afterId` are the cards it lands between; only this client is
 * written. Moving to another category goes through changeClientCategory.
 */
export async function moveClient(clientId: string, stageId: string, place?: { beforeId?: string | null; afterId?: string | null }): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const db = await getDb();
    const [client] = await db.select().from(clients).where(eq(clients.id, id.parse(clientId)));
    if (!client) throw new ActionError("This client no longer exists. Reload the board.");
    const { stage, category } = await stageWithCategory(stageId);
    if (category !== client.category) throw new ActionError(`That stage is for ${clientCategoryLabels[category].one.toLowerCase()} clients. Change the category instead.`);
    const ids = [place?.beforeId, place?.afterId].filter((x): x is string => !!x);
    const neighbours = ids.length ? await db.select({ id: clients.id, rank: clients.rank }).from(clients).where(inArray(clients.id, ids)) : [];
    const rankOf = (x?: string | null) => neighbours.find((n) => n.id === x)?.rank ?? null;
    // Moved from a menu or the stage bar: top of the new column.
    const rank = place ? rankBetween(rankOf(place.beforeId), rankOf(place.afterId)) : await topRank(stage.id);
    const changedStage = stage.id !== client.stageId;
    await db
      .update(clients)
      .set({ stageId: stage.id, pipelineId: stage.pipelineId, rank, updatedAt: new Date(), ...(changedStage ? { stageChangedAt: new Date() } : {}) })
      .where(eq(clients.id, client.id));
    if (changedStage) {
      const [from] = await db.select({ name: stages.name }).from(stages).where(eq(stages.id, client.stageId));
      await recordEvent({ entityType: "client", entityId: client.id, action: "stage_changed", data: { from: from?.name ?? null, to: stage.name }, userId: user.id });
    }
    refresh();
  });
}

const categoryInput = z.object({
  category: z.enum(clientCategories),
  stageId: z.uuid().nullable().optional(),
  /** Becoming current: client since. Becoming past: left on. Defaults to today. */
  on: optionalDate,
  /** Becoming past. */
  churnReason: optionalText(300),
  openToReturn: z.boolean().optional(),
  /** Becoming past: end the services they still have, on the same day. Defaults to yes. */
  endServices: z.boolean().optional(),
  /** Becoming current: start these services today. */
  serviceIds: z.array(z.uuid()).max(50).optional(),
});

/**
 * Signing a prospect, a client leaving, or a past client coming back. Moves
 * the client into the new category's pipeline, records the dates and reason,
 * and keeps services in step (leaving ends them; signing can start some).
 */
export async function changeClientCategory(clientId: string, input: z.input<typeof categoryInput>): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const data = categoryInput.parse(input);
    const db = await getDb();
    const [client] = await db.select().from(clients).where(eq(clients.id, id.parse(clientId)));
    if (!client) throw new ActionError("This client was deleted.");
    if (client.category === data.category) return;
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
      userId: user.id,
    });
    refresh();
  });
}

// ─── Services on a client ────────────────────────────────────────────────

const subscriptionInput = z.object({
  price: z.number().int().min(0).max(1e13).optional(),
  interval: z.enum(billingIntervals).optional(),
  startedOn: optionalDate,
  endedOn: optionalDate,
  note: optionalText(300),
});

export async function addClientService(clientId: string, serviceId: string, input: z.input<typeof subscriptionInput> = {}): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const data = subscriptionInput.parse(input);
    const db = await getDb();
    const [client] = await db.select().from(clients).where(eq(clients.id, id.parse(clientId)));
    const [service] = await db.select().from(services).where(eq(services.id, id.parse(serviceId)));
    if (!client) throw new ActionError("This client was deleted.");
    if (!service || service.archivedAt) throw new ActionError("That service isn't offered anymore. Pick another one.");
    const today = await workspaceToday();
    await db.insert(clientServices).values({
      clientId: client.id,
      serviceId: service.id,
      price: data.price ?? service.price,
      interval: data.interval ?? service.interval,
      startedOn: data.startedOn ?? (client.category === "current" ? today : null),
      endedOn: data.endedOn ?? (client.category === "past" ? (client.endedOn ?? today) : null),
      note: data.note,
    });
    await recordEvent({ entityType: "client", entityId: client.id, action: "service_added", data: { name: service.name }, userId: user.id });
    refresh();
  });
}

export async function updateClientService(rowId: string, patch: z.input<typeof subscriptionInput>): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const data = subscriptionInput.parse(patch);
    const db = await getDb();
    const [row] = await db.select({ cs: clientServices, name: services.name }).from(clientServices).innerJoin(services, eq(services.id, clientServices.serviceId)).where(eq(clientServices.id, id.parse(rowId)));
    if (!row) throw new ActionError("That service was removed from this client.");
    await db.update(clientServices).set(data).where(eq(clientServices.id, row.cs.id));
    const ended = data.endedOn && !row.cs.endedOn;
    const changes = diff(row.cs, data, { price: `${row.name} price`, interval: `${row.name} billing`, startedOn: `${row.name} start`, endedOn: `${row.name} end` });
    if (ended) await recordEvent({ entityType: "client", entityId: row.cs.clientId, action: "service_ended", data: { name: row.name, on: data.endedOn }, userId: user.id });
    else if (changes.length) await recordEvent({ entityType: "client", entityId: row.cs.clientId, action: "updated", data: { changes }, userId: user.id });
    refresh();
  });
}

export async function removeClientService(rowId: string): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const db = await getDb();
    const [row] = await db.select({ cs: clientServices, name: services.name }).from(clientServices).innerJoin(services, eq(services.id, clientServices.serviceId)).where(eq(clientServices.id, id.parse(rowId)));
    if (!row) return;
    await db.delete(clientServices).where(eq(clientServices.id, row.cs.id));
    await recordEvent({ entityType: "client", entityId: row.cs.clientId, action: "service_removed", data: { name: row.name }, userId: user.id });
    refresh();
  });
}

// ─── Performance ─────────────────────────────────────────────────────────

const metricInput = z.object({
  label: z.string().trim().min(1, "Name what you're measuring.").max(60),
  value: z.number({ error: "Enter the number." }).finite().min(-1e12).max(1e12),
  period: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the date this number is for."),
  note: optionalText(300),
});

export async function logClientMetric(clientId: string, input: z.input<typeof metricInput>): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const data = metricInput.parse(input);
    const db = await getDb();
    const [client] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, id.parse(clientId)));
    if (!client) throw new ActionError("This client was deleted.");
    // Same label (any capitalization) is the same series.
    const [existing] = await db.select({ label: clientMetrics.label }).from(clientMetrics).where(and(eq(clientMetrics.clientId, client.id), sql`lower(${clientMetrics.label}) = lower(${data.label})`)).limit(1);
    await db.insert(clientMetrics).values({ ...data, label: existing?.label ?? data.label, clientId: client.id, userId: user.id });
    refresh();
  });
}

export async function deleteClientMetric(metricId: string): Promise<Result> {
  return run(async () => {
    await actionUser();
    const db = await getDb();
    await db.delete(clientMetrics).where(eq(clientMetrics.id, id.parse(metricId)));
    refresh();
  });
}

// ─── Stripe ──────────────────────────────────────────────────────────────

export async function findStripeCustomers(q: string): Promise<Result<{ id: string; name: string | null; email: string | null }[]>> {
  return run(async () => {
    await actionUser();
    try {
      const list = await searchCustomers(z.string().max(120).parse(q));
      return list.map((c) => ({ id: c.id, name: c.name, email: c.email }));
    } catch (err) {
      if (err instanceof StripeError) throw new ActionError(err.message);
      throw err;
    }
  });
}

/** Links (or unlinks, with null) the Stripe customer whose billing shows on this client. */
export async function linkStripeCustomer(clientId: string, customerId: string | null): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const db = await getDb();
    const [client] = await db.select().from(clients).where(eq(clients.id, id.parse(clientId)));
    if (!client) throw new ActionError("This client was deleted.");
    const cus = customerId === null ? null : z.string().regex(/^cus_[A-Za-z0-9]+$/, "Stripe customer IDs start with cus_.").parse(customerId.trim());
    let label: string | null = null;
    if (cus) {
      try {
        const c = await getCustomer(cus);
        label = c.name ?? c.email ?? c.id;
      } catch (err) {
        if (err instanceof StripeError) throw new ActionError(err.message);
        throw err;
      }
    }
    await db.update(clients).set({ stripeCustomerId: cus, updatedAt: new Date() }).where(eq(clients.id, client.id));
    await recordEvent({ entityType: "client", entityId: client.id, action: cus ? "stripe_linked" : "stripe_unlinked", data: { customer: cus ?? client.stripeCustomerId, name: label }, userId: user.id });
    refresh();
  });
}
