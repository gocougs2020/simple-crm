import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { schema, type Database } from "@/db";
import { withTransaction } from "@/db/transaction";
import { assertCan, stamp, type Actor } from "@/lib/crm/actor";
import { groupClients, pickClientSurvivor } from "@/lib/crm/merge";
import { mergeClientsInto, mergeOrganizationsInto, mergePeopleInto, stageProbabilities, type MergeDatabase } from "@/lib/crm/merge-records";
import { id } from "@/lib/crm/schemas";
import { ActionError, NotFoundError } from "@/lib/errors";

/**
 * Merging people or organizations by hand: someone picks the records and
 * which one is kept. The kept record keeps every value it has; its blanks are
 * filled from the others (most recently active first), and everything on the
 * others (people, clients, notes, tasks, meetings, email, calls, texts,
 * files, history) moves to it before they're deleted. When that leaves an
 * organization (or, for clients with no organization, a person) with more
 * than one client, those clients become one: the one furthest along is kept.
 * One transaction, so a failure changes nothing. See docs/DEDUPE.md.
 */

export const mergeInput = z.object({
  keepId: id.describe("The record that's kept. The others merge into it."),
  mergeIds: z
    .array(id)
    .min(1, "Pick at least one other record to merge into it.")
    .max(49, "Merge up to 50 records at a time.")
    .describe("The records merged into it and then deleted."),
});

const { people, organizations, clients, personOrganizations } = schema;

/** Most recently active first, then newest: the order the others fill the kept record's blanks in. */
const donorOrder = <T extends { lastActivityAt: Date | null; createdAt: Date }>(a: T, b: T) => (b.lastActivityAt?.getTime() ?? 0) - (a.lastActivityAt?.getTime() ?? 0) || b.createdAt.getTime() - a.createdAt.getTime();

function parse(input: z.input<typeof mergeInput>) {
  const { keepId, mergeIds } = mergeInput.parse(input);
  const others = [...new Set(mergeIds)].filter((m) => m !== keepId);
  if (!others.length) throw new ActionError("Pick at least one other record to merge into it.");
  return { keepId, others };
}

/**
 * The clients of an organization (or, with `personId`, a person's clients
 * with no organization) become one when there's more than one and the merge
 * brought some of them. Returns how many were merged away.
 */
async function mergeDuplicateClients(t: MergeDatabase, where: { organizationId: string } | { personId: string }, a: Actor) {
  const rows = await t
    .select()
    .from(clients)
    .where("organizationId" in where ? eq(clients.organizationId, where.organizationId) : and(eq(clients.personId, where.personId), isNull(clients.organizationId)));
  let merged = 0;
  for (const group of groupClients(rows)) {
    const probability = await stageProbabilities(
      t,
      group.map((c) => c.id),
    );
    const { survivor, donors } = pickClientSurvivor(group, (c) => probability.get(c.id) ?? 0);
    await mergeClientsInto(t, { keep: survivor, donors, by: stamp(a) });
    merged += donors.length;
  }
  return merged;
}

export async function mergeOrganizations(a: Actor, input: z.input<typeof mergeInput>) {
  assertCan(a, "records:write");
  assertCan(a, "records:archive");
  const { keepId, others } = parse(input);
  return withTransaction(async (db: Database) => {
    const t = db as unknown as MergeDatabase;
    const rows = await t.select().from(organizations).where(inArray(organizations.id, [keepId, ...others])).for("update");
    const keep = rows.find((r) => r.id === keepId);
    if (!keep) throw new NotFoundError("The organization to keep was deleted. Reload the page and pick another.");
    const donors = rows.filter((r) => r.id !== keepId).sort(donorOrder);
    if (donors.length !== others.length) throw new NotFoundError("Some of those organizations were deleted or already merged. Reload the page and try again.");
    const hadClients = (await t.select({ id: clients.id }).from(clients).where(inArray(clients.organizationId, others)).limit(1)).length > 0;
    await mergeOrganizationsInto(t, { keep, donors, by: stamp(a) });
    const clientsMerged = hadClients ? await mergeDuplicateClients(t, { organizationId: keepId }, a) : 0;
    return { id: keepId, merged: donors.length, clientsMerged };
  });
}

export async function mergePeople(a: Actor, input: z.input<typeof mergeInput>) {
  assertCan(a, "records:write");
  assertCan(a, "records:archive");
  const { keepId, others } = parse(input);
  return withTransaction(async (db: Database) => {
    const t = db as unknown as MergeDatabase;
    const all = [keepId, ...others];
    const rows = await t.select().from(people).where(inArray(people.id, all)).for("update");
    const keep = rows.find((r) => r.id === keepId);
    if (!keep) throw new NotFoundError("The person to keep was deleted. Reload the page and pick someone else.");
    const donors = rows.filter((r) => r.id !== keepId).sort(donorOrder);
    if (donors.length !== others.length) throw new NotFoundError("Some of those people were deleted or already merged. Reload the page and try again.");
    const alsoAt = await t.select().from(personOrganizations).where(inArray(personOrganizations.personId, all));
    const at = (ids: string[]) => alsoAt.filter((r) => ids.includes(r.personId)).map((r) => r.organizationId);
    const hadClients = (await t.select({ id: clients.id }).from(clients).where(and(inArray(clients.personId, others), isNull(clients.organizationId))).limit(1)).length > 0;
    await mergePeopleInto(t, { keep, donors, alsoAt: { survivor: at([keepId]), others: at(others) }, by: stamp(a) });
    const clientsMerged = hadClients ? await mergeDuplicateClients(t, { personId: keepId }, a) : 0;
    return { id: keepId, merged: donors.length, clientsMerged };
  });
}
