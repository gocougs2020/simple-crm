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
import { getCustomer, searchCustomers, stripeAccountLabel, stripeConfigured, StripeError } from "@/lib/stripe";
import { refreshClientBilling, rememberCustomer, syncClient } from "@/lib/stripe/sync";

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

const stripeAccount = z.string().regex(/^[a-z0-9_]+$/).max(60);
const stripeCustomer = z.string().trim().regex(/^cus_[A-Za-z0-9]+$/, "Stripe customer IDs start with cus_.");

async function clientRow(clientId: string) {
  const db = await getDb();
  const [client] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, id.parse(clientId)));
  if (!client) throw new ActionError("This client was deleted.");
  return client;
}

/** Customers in every connected Stripe account that match an email, a name or an ID, for linking one by hand. */
export async function findStripeCustomers(q: string): Promise<Result<{ account: string; accountLabel: string; id: string; name: string | null; email: string | null }[]>> {
  return run(async () => {
    await actionEditor();
    try {
      const list = await searchCustomers(z.string().max(120).parse(q));
      return list.map((c) => ({ account: c.account, accountLabel: stripeAccountLabel(c.account), id: c.id, name: c.name, email: c.email }));
    } catch (err) {
      if (err instanceof StripeError) throw new ActionError(err.message);
      throw err;
    }
  });
}

/** Puts a Stripe customer on this client by hand, for one whose email isn't on any of the client's people. */
export async function linkStripeCustomer(clientId: string, account: string, customerId: string): Promise<Result> {
  return run(async () => {
    const user = await actionEditor();
    const client = await clientRow(clientId);
    const acct = stripeAccount.parse(account);
    const cus = stripeCustomer.parse(customerId);
    let customer;
    try {
      customer = await getCustomer(acct, cus);
    } catch (err) {
      if (err instanceof StripeError) throw new ActionError(err.message);
      throw err;
    }
    const db = await getDb();
    await rememberCustomer(acct, customer);
    await db
      .insert(schema.clientStripeLinks)
      .values({ clientId: client.id, account: acct, customerId: cus, kind: "linked", createdBy: user.id })
      .onConflictDoUpdate({ target: [schema.clientStripeLinks.clientId, schema.clientStripeLinks.account, schema.clientStripeLinks.customerId], set: { kind: "linked", createdBy: user.id } });
    await syncClient(client.id);
    await recordEvent({ entityType: "client", entityId: client.id, action: "stripe_linked", data: { customer: cus, name: customer.name ?? customer.email ?? cus, account: stripeAccountLabel(acct) }, userId: user.id });
    refresh();
  });
}

/** Takes a Stripe customer off this client: one linked by hand, or an email match that isn't theirs. It stays off until someone links it again. */
export async function removeStripeCustomer(clientId: string, account: string, customerId: string): Promise<Result> {
  return run(async () => {
    const user = await actionEditor();
    const client = await clientRow(clientId);
    const acct = stripeAccount.parse(account);
    const cus = stripeCustomer.parse(customerId);
    const db = await getDb();
    await db
      .insert(schema.clientStripeLinks)
      .values({ clientId: client.id, account: acct, customerId: cus, kind: "hidden", createdBy: user.id })
      .onConflictDoUpdate({ target: [schema.clientStripeLinks.clientId, schema.clientStripeLinks.account, schema.clientStripeLinks.customerId], set: { kind: "hidden", createdBy: user.id } });
    await refreshClientBilling(client.id);
    await recordEvent({ entityType: "client", entityId: client.id, action: "stripe_unlinked", data: { customer: cus }, userId: user.id });
    refresh();
  });
}

/** Asks Stripe about this client now, instead of waiting for the daily sync. */
export async function refreshStripe(clientId: string): Promise<Result> {
  return run(async () => {
    await actionUser();
    const client = await clientRow(clientId);
    if (!stripeConfigured()) throw new ActionError("Stripe isn't connected.");
    await syncClient(client.id);
    refresh();
  });
}
