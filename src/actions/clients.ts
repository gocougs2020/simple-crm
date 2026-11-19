"use server";

import { refresh } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { run, type Result } from "@/lib/action";
import { ActionError, actionEditor, actionUser } from "@/lib/auth";
import type { ClientCategory } from "@/lib/constants";
import { sessionActor } from "@/lib/crm/actor";
import { recordEvent } from "@/lib/crm/events";
import { id, type categoryInput, type clientInput, type metricInput, type subscriptionInput } from "@/lib/crm/schemas";
import * as svc from "@/lib/crm/service/clients";
import { getCustomer, searchCustomers, StripeError } from "@/lib/stripe";

const { clients } = schema;

const actor = async () => sessionActor(await actionUser());

export async function createClient(
  input: z.input<typeof clientInput> & { category: ClientCategory; stageId?: string | null; serviceIds?: string[]; newOrganizationName?: string; newPersonName?: string },
): Promise<Result<{ id: string }>> {
  return run(async () => {
    const row = await svc.createClient(await actor(), input);
    refresh();
    return row;
  });
}

export async function updateClient(clientId: string, patch: Partial<z.input<typeof clientInput>>): Promise<Result> {
  return run(async () => {
    await svc.updateClient(await actor(), clientId, patch);
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
    await svc.moveClient(await actor(), clientId, stageId, place);
    refresh();
  });
}

/** Signing a prospect, a client leaving, or a past client coming back. */
export async function changeClientCategory(clientId: string, input: z.input<typeof categoryInput>): Promise<Result> {
  return run(async () => {
    await svc.changeClientCategory(await actor(), clientId, input);
    refresh();
  });
}

// ─── People on a client ──────────────────────────────────────────────────

export async function addClientPerson(clientId: string, personId: string): Promise<Result> {
  return run(async () => {
    await svc.addClientPerson(await actor(), clientId, personId);
    refresh();
  });
}

export async function removeClientPerson(clientId: string, personId: string): Promise<Result> {
  return run(async () => {
    await svc.removeClientPerson(await actor(), clientId, personId);
    refresh();
  });
}

// ─── Services on a client ────────────────────────────────────────────────

export async function addClientService(clientId: string, serviceId: string, input: z.input<typeof subscriptionInput> = {}): Promise<Result> {
  return run(async () => {
    await svc.addClientService(await actor(), clientId, serviceId, input);
    refresh();
  });
}

export async function updateClientService(rowId: string, patch: z.input<typeof subscriptionInput>): Promise<Result> {
  return run(async () => {
    await svc.updateClientService(await actor(), rowId, patch);
    refresh();
  });
}

export async function removeClientService(rowId: string): Promise<Result> {
  return run(async () => {
    await svc.removeClientService(await actor(), rowId);
    refresh();
  });
}

// ─── Performance ─────────────────────────────────────────────────────────

export async function logClientMetric(clientId: string, input: z.input<typeof metricInput>): Promise<Result> {
  return run(async () => {
    await svc.logClientMetric(await actor(), clientId, input);
    refresh();
  });
}

export async function deleteClientMetric(metricId: string): Promise<Result> {
  return run(async () => {
    await svc.deleteClientMetric(await actor(), metricId);
    refresh();
  });
}

// ─── Stripe ──────────────────────────────────────────────────────────────

export async function findStripeCustomers(q: string): Promise<Result<{ id: string; name: string | null; email: string | null }[]>> {
  return run(async () => {
    await actionEditor();
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
    const user = await actionEditor();
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
