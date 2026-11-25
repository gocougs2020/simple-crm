import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { and, asc, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { EntityType } from "@/lib/constants";
import { conditionProblem, renameLabelInFilter, type CustomFieldDef, type FilterCondition } from "./filter-fields";
import { filterSql } from "./filter-sql";

const { clients, organizations, people } = schema;

const custom: CustomFieldDef[] = [
  { entityType: "organization", key: "pd_time_zone", label: "Time Zone", type: "select", options: ["Eastern", "Central", "Mountain", "Pacific"] },
  { entityType: "organization", key: "pd_agent_count", label: "Agent Count", type: "number", options: [] },
  { entityType: "person", key: "regions", label: "Regions", type: "multiselect", options: ["North", "South"] },
];

/**
 * Saved filters against a real database. Acme is in the Eastern time zone
 * with 40 agents and the "vip" label; Beta is Pacific with 5. Jane (a
 * decision maker) and Dan are at Acme, Bob at Beta, Cara at no organization.
 * Acme's client is current with Jane as its contact; Beta's is a prospect.
 */
describe("saved filters", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  before(async () => {
    client = new PGlite({ extensions: { vector, pg_trgm } });
    db = drizzle({ client, schema });
    await migrate(db, { migrationsFolder: "drizzle" });
    const [pipe] = await db.insert(schema.pipelines).values({ name: "Sales" }).returning();
    const [stage] = await db.insert(schema.stages).values({ pipelineId: pipe.id, name: "New" }).returning();
    const [acme] = await db.insert(organizations).values({ name: "Acme", tags: ["vip"], custom: { pd_time_zone: "Eastern", pd_agent_count: 40 } }).returning();
    const [beta] = await db.insert(organizations).values({ name: "Beta", custom: { pd_time_zone: "Pacific", pd_agent_count: "5" } }).returning();
    const [jane] = await db
      .insert(people)
      .values({ firstName: "Jane", title: "Broker", organizationId: acme.id, decisionMaker: true, custom: { regions: ["North"] }, lastActivityAt: new Date() })
      .returning();
    await db.insert(people).values({ firstName: "Dan", organizationId: acme.id, lastActivityAt: new Date(Date.now() - 40 * 86_400_000) });
    const [bob] = await db.insert(people).values({ firstName: "Bob", title: "Agent", organizationId: beta.id }).returning();
    await db.insert(people).values({ firstName: "Cara" });
    await db.insert(clients).values([
      { name: "Acme deal", category: "current", pipelineId: pipe.id, stageId: stage.id, organizationId: acme.id, personId: jane.id, value: 500_000 },
      { name: "Beta deal", category: "prospective", pipelineId: pipe.id, stageId: stage.id, organizationId: beta.id, personId: bob.id, value: 100_000 },
    ]);
  });
  after(() => client.close());

  const tableOf = { person: people, organization: organizations, client: clients } as const;
  async function names(entity: EntityType, all: FilterCondition[], any: FilterCondition[] = []) {
    const t = tableOf[entity];
    const label = entity === "person" ? people.firstName : entity === "organization" ? organizations.name : clients.name;
    const rows = await db
      .select({ n: label })
      .from(t)
      .where(and(isNull(t.archivedAt), filterSql(entity, { all, any }, custom)))
      .orderBy(asc(label));
    return rows.map((r) => r.n);
  }
  const tz = (op: FilterCondition["op"], value?: FilterCondition["value"]): FilterCondition => ({ field: "organization.custom.pd_time_zone", op, value });

  it("finds people whose organization is in a time zone", async () => {
    assert.deepEqual(await names("person", [tz("any_of", ["Eastern"])]), ["Dan", "Jane"]);
  });

  it("finds clients whose organization is in a time zone", async () => {
    assert.deepEqual(await names("client", [tz("any_of", ["Eastern"])]), ["Acme deal"]);
  });

  it("counts someone with no organization as not in the time zone and as having none", async () => {
    assert.deepEqual(await names("person", [tz("none_of", ["Eastern"])]), ["Bob", "Cara"]);
    assert.deepEqual(await names("person", [tz("empty")]), ["Cara"]);
    assert.deepEqual(await names("person", [tz("not_empty")]), ["Bob", "Dan", "Jane"]);
  });

  it("reads a negation on related records as none of them", async () => {
    const dm = (op: FilterCondition["op"]): FilterCondition => ({ field: "person.decisionMaker", op });
    assert.deepEqual(await names("organization", [dm("is_true")]), ["Acme"]);
    assert.deepEqual(await names("organization", [dm("is_false")]), ["Beta"]);
  });

  it("combines every condition in all with at least one in any", async () => {
    const atAcme: FilterCondition = { field: "organization.name", op: "is", value: "acme" };
    assert.deepEqual(await names("person", [atAcme], [{ field: "person.title", op: "is", value: "broker" }, { field: "person.name", op: "contains", value: "da" }]), ["Dan", "Jane"]);
    assert.deepEqual(await names("person", [atAcme, { field: "person.title", op: "contains", value: "brok" }]), ["Jane"]);
    assert.deepEqual(await names("person", [], [{ field: "person.title", op: "is", value: "agent" }, { field: "person.name", op: "is", value: "cara" }]), ["Bob", "Cara"]);
  });

  it("ties people to the clients they're the contact on and to their organization's", async () => {
    const current: FilterCondition = { field: "client.category", op: "any_of", value: ["current"] };
    assert.deepEqual(await names("person", [current]), ["Dan", "Jane"]);
    assert.deepEqual(await names("organization", [current]), ["Acme"]);
  });

  it("compares numbers stored as numbers or as text, and money in cents", async () => {
    assert.deepEqual(await names("organization", [{ field: "organization.custom.pd_agent_count", op: "gt", value: 10 }]), ["Acme"]);
    assert.deepEqual(await names("organization", [{ field: "organization.custom.pd_agent_count", op: "lte", value: 5 }]), ["Beta"]);
    assert.deepEqual(await names("client", [{ field: "client.value", op: "gte", value: 250_000 }]), ["Acme deal"]);
  });

  it("matches labels people carry from their organization, and custom multi-selects", async () => {
    assert.deepEqual(await names("person", [{ field: "person.labels", op: "has_any", value: ["vip"] }]), ["Dan", "Jane"]);
    assert.deepEqual(await names("person", [{ field: "person.custom.regions", op: "has_none", value: ["North"] }]), ["Bob", "Cara", "Dan"]);
  });

  it("filters on how recent a date is, counting never as not recent", async () => {
    assert.deepEqual(await names("person", [{ field: "person.lastActivity", op: "within_days", value: 30 }]), ["Jane"]);
    assert.deepEqual(await names("person", [{ field: "person.lastActivity", op: "not_within_days", value: 30 }]), ["Bob", "Cara", "Dan"]);
  });

  it("matches nothing for a field that no longer exists, so a broken filter never widens a list", async () => {
    assert.deepEqual(await names("person", [{ field: "organization.custom.gone", op: "not_empty" }]), []);
    assert.deepEqual(await names("person", []), ["Bob", "Cara", "Dan", "Jane"]);
  });

  it("says what's missing before a condition is saved", () => {
    assert.equal(conditionProblem(tz("any_of", ["Eastern"]), custom), null);
    assert.match(conditionProblem(tz("any_of", []), custom)!, /Pick at least one value/);
    assert.match(conditionProblem(tz("contains", "East"), custom)!, /doesn't work on Time Zone/);
    assert.match(conditionProblem({ field: "person.lastActivity", op: "within_days" }, custom)!, /number of days/);
    assert.match(conditionProblem({ field: "client.nope", op: "empty" }, custom)!, /no longer exists/);
  });

  it("follows a renamed label in label conditions, and leaves everything else alone", async () => {
    const before = {
      all: [{ field: "person.labels", op: "has_none" as const, value: ["vip", "cold"] }, { field: "person.title", op: "is" as const, value: "vip" }],
      any: [{ field: "client.labels", op: "has_any" as const, value: ["vip"] }],
    };
    const after = renameLabelInFilter(before, "vip", "key account")!;
    assert.deepEqual(after.all[0].value, ["key account", "cold"]);
    assert.equal(after.all[1].value, "vip");
    assert.deepEqual(after.any[0].value, ["key account"]);
    assert.equal(renameLabelInFilter(before, "unused", "x"), null);
    // Renaming onto a label the condition already names keeps it once.
    assert.deepEqual(renameLabelInFilter({ all: [{ field: "organization.labels", op: "has_any", value: ["a", "b"] }], any: [] }, "a", "b")!.all[0].value, ["b"]);
  });
});
