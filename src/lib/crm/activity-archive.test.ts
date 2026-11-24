import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import { activityArchived, activityLive, homedOn, shownOnRecord } from "./activity-archive";

const { activities, clients, organizations, people } = schema;

/**
 * Which activities go with an archived record, against a real database:
 * Acme (organization), Jane and Bob at Acme, and a client for Acme with Jane
 * as its contact. Each activity is logged on one of them, with the links that
 * logging fills in (src/lib/crm/activities.ts, resolveLinks).
 */
describe("activities archived with their record", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let ids: { org: string; jane: string; bob: string; deal: string };

  before(async () => {
    client = new PGlite({ extensions: { vector, pg_trgm } });
    db = drizzle({ client, schema });
    await migrate(db, { migrationsFolder: "drizzle" });
    const [pipe] = await db.insert(schema.pipelines).values({ name: "Sales" }).returning();
    const [stage] = await db.insert(schema.stages).values({ pipelineId: pipe.id, name: "New" }).returning();
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    const [jane] = await db.insert(people).values({ firstName: "Jane", organizationId: org.id }).returning();
    const [bob] = await db.insert(people).values({ firstName: "Bob", organizationId: org.id }).returning();
    const [deal] = await db.insert(clients).values({ name: "Acme deal", category: "prospective", pipelineId: pipe.id, stageId: stage.id, organizationId: org.id, personId: jane.id, rank: "a" }).returning();
    ids = { org: org.id, jane: jane.id, bob: bob.id, deal: deal.id };
    const due = new Date("2026-11-01T09:00:00Z");
    await db.insert(activities).values([
      { type: "task", subject: "client task", dueAt: due, clientId: deal.id, personId: jane.id, organizationId: org.id },
      { type: "meeting", subject: "client meeting", dueAt: due, clientId: deal.id, personId: jane.id, organizationId: org.id },
      { type: "task", subject: "jane task", dueAt: due, personId: jane.id, organizationId: org.id },
      { type: "note", subject: "jane note", personId: jane.id, organizationId: org.id },
      { type: "task", subject: "bob task", dueAt: due, personId: bob.id, organizationId: org.id },
      { type: "task", subject: "org task", dueAt: due, organizationId: org.id },
      { type: "task", subject: "unlinked task", dueAt: due },
    ]);
  });
  after(() => client.close());
  beforeEach(async () => {
    await db.update(organizations).set({ archivedAt: null });
    await db.update(people).set({ archivedAt: null });
    await db.update(clients).set({ archivedAt: null });
  });

  const subjects = async (where: SQL | undefined) => (await db.select({ s: activities.subject }).from(activities).where(where).orderBy(asc(activities.subject))).map((r) => r.s);
  const archive = (t: typeof clients | typeof people | typeof organizations, id: string) => db.update(t).set({ archivedAt: new Date() }).where(eq(t.id, id));
  const archivedNow = () => subjects(sql`not ${activityLive()}`);

  it("leaves everything live while nothing is archived", async () => {
    assert.deepEqual(await archivedNow(), []);
  });

  it("archives a client's own activities, not those set directly on its contact or organization", async () => {
    await archive(clients, ids.deal);
    assert.deepEqual(await archivedNow(), ["client meeting", "client task"]);
  });

  it("archives a person's own activities, not the client's that carry them as its contact", async () => {
    await archive(people, ids.jane);
    assert.deepEqual(await archivedNow(), ["jane note", "jane task"]);
  });

  it("archives an organization's own activities, not its people's or its clients'", async () => {
    await archive(organizations, ids.org);
    assert.deepEqual(await archivedNow(), ["org task"]);
  });

  it("brings them back when the record is restored", async () => {
    await archive(clients, ids.deal);
    await db.update(clients).set({ archivedAt: null }).where(eq(clients.id, ids.deal));
    assert.deepEqual(await archivedNow(), []);
  });

  it("counts on archiving exactly the activities that become archived", async () => {
    for (const [entity, t, id] of [["client", clients, ids.deal], ["person", people, ids.jane], ["organization", organizations, ids.org]] as const) {
      const counted = await subjects(homedOn(entity, [id]));
      await archive(t, id);
      assert.deepEqual(await archivedNow(), counted, entity);
      await db.update(t).set({ archivedAt: null }).where(eq(t.id, id));
    }
  });

  it("reads as archived in a select", async () => {
    await archive(people, ids.jane);
    const rows = await db.select({ s: activities.subject, archived: activityArchived() }).from(activities).where(eq(activities.personId, ids.jane)).orderBy(asc(activities.subject));
    assert.deepEqual(rows, [
      { s: "client meeting", archived: false },
      { s: "client task", archived: false },
      { s: "jane note", archived: true },
      { s: "jane task", archived: true },
    ]);
  });

  it("keeps an archived record's own work on its page, and drops another archived record's from a live one", async () => {
    await archive(clients, ids.deal);
    assert.deepEqual(await subjects(and(eq(activities.clientId, ids.deal), shownOnRecord("client", ids.deal))), ["client meeting", "client task"]);
    assert.deepEqual(await subjects(and(eq(activities.personId, ids.jane), shownOnRecord("person", ids.jane))), ["jane note", "jane task"]);
  });
});
