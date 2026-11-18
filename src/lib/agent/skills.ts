import "server-only";
import { and, asc, eq, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import type { User } from "@/lib/auth";
import type { AgentScope } from "@/lib/constants";
import { assertCan, can, type Actor } from "@/lib/crm/actor";
import { ActionError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { alwaysRefusal, canEditSkill, canSeeSkill, MAX_SKILLS, skillInput, skillPatch, type SkillBrief, type SkillInput, type SkillPatch } from "./skill-rules";

/**
 * The agent's skills: instructions teammates and admins save for it
 * (docs/AGENT.md). The settings page, the REST API, MCP and the agent itself
 * all come through here, so the same rules hold everywhere:
 * - a personal skill belongs to one teammate and only their agent uses it;
 * - a shared (workspace) skill is used by everyone's agent, and only an admin
 *   in Settings creates, changes or shares one: never an agent or a key;
 * - the agent's background runs can read skills but never write them, so
 *   nothing a run reads on the web or in a record can leave instructions
 *   behind for later.
 */

const skills = schema.agentSkills;
export type Skill = typeof skills.$inferSelect;
export type SkillRow = Skill & { ownerName: string };

function teammate(a: Actor): User {
  if (a.kind !== "user") throw new ForbiddenError("Skills belong to a teammate or are shared by an admin. Use a personal key or a connected app, not a workspace key.");
  return a.user;
}

/**
 * Whether this is an admin acting in person: signed in, in the browser. An
 * admin's key, connected app or agent counts as the teammate only, so it sees
 * and changes its own teammate's skills and nobody else's.
 */
const inPerson = (a: Actor) => a.kind === "user" && !a.keyId && can(a, "workspace:admin");
const who = (a: Actor & { kind: "user" }) => ({ id: a.user.id, admin: inPerson(a) });

/**
 * A shared skill is part of every teammate's agent, and another teammate's
 * skill is part of theirs, so both are only created, changed or deleted by an
 * admin acting in person, in Settings: never by an agent, a key or a
 * connected app, whoever they act for.
 */
function assertInPerson(a: Actor) {
  if (a.kind !== "user" || a.keyId) throw new ForbiddenError("Skills shared with the whole team, and other teammates' skills, are managed in Settings › Agent, by an admin. An agent can save and change the teammate's own skills.");
  assertCan(a, "workspace:admin");
}

function assertNotRun(a: Actor) {
  if (a.kind === "user" && a.runId) throw new ForbiddenError("Background work can read skills but not change them. Ask in chat, or change it in Settings.");
}

async function rows(where: SQL | undefined) {
  const db = await getDb();
  const found = await db.select({ skill: skills, ownerName: schema.users.name }).from(skills).innerJoin(schema.users, eq(schema.users.id, skills.userId)).where(where).orderBy(asc(sql`lower(${skills.name})`));
  return found.map((r): SkillRow => ({ ...r.skill, ownerName: r.ownerName }));
}

/**
 * The skills this teammate can see: their own and the shared ones.
 * `all` adds other teammates' personal skills, for admins.
 */
export async function listSkills(a: Actor, opts: { scope?: "mine" | "shared" | "all" } = {}) {
  assertCan(a, "records:read");
  const user = teammate(a);
  const mine = and(eq(skills.scope, "personal"), eq(skills.userId, user.id));
  const shared = eq(skills.scope, "workspace");
  if (opts.scope === "mine") return rows(mine);
  if (opts.scope === "shared") return rows(shared);
  if (opts.scope === "all" && inPerson(a)) return rows(undefined);
  return rows(or(mine, shared));
}

async function find(a: Actor, id: string) {
  teammate(a);
  const [row] = await rows(eq(skills.id, z.uuid().parse(id)));
  if (!row || !canSeeSkill(who(a as Actor & { kind: "user" }), row)) throw new NotFoundError("That skill doesn't exist.");
  return row;
}

export async function getSkill(a: Actor, id: string) {
  assertCan(a, "records:read");
  return find(a, id);
}

/** Names are unique among a teammate's own skills, and among the shared ones, so the agent can tell them apart. */
async function assertRoom(scope: AgentScope, userId: string, input: { name: string; mode?: Skill["mode"]; instructions: string }, exceptId?: string) {
  const db = await getDb();
  const set = and(eq(skills.scope, scope), scope === "personal" ? eq(skills.userId, userId) : undefined, exceptId ? ne(skills.id, exceptId) : undefined);
  const others = await db.select({ name: skills.name, mode: skills.mode, enabled: skills.enabled }).from(skills).where(set);
  if (!exceptId && others.length >= MAX_SKILLS) throw new ActionError(`That's ${MAX_SKILLS} skills, the most ${scope === "personal" ? "one teammate" : "a workspace"} can have. Delete one first.`);
  if (others.some((o) => o.name.toLowerCase() === input.name.toLowerCase())) throw new ActionError(`There's already a ${scope === "workspace" ? "shared " : ""}skill called ${input.name}.`);
  const refusal = alwaysRefusal(input, others.filter((o) => o.mode === "always" && o.enabled).length);
  if (refusal) throw new ActionError(refusal);
}

export async function createSkill(a: Actor, input: SkillInput) {
  assertCan(a, "records:write");
  assertNotRun(a);
  const user = teammate(a);
  const data = skillInput.parse(input);
  const scope = data.scope ?? "personal";
  if (scope === "workspace") assertInPerson(a);
  await assertRoom(scope, user.id, data);
  const db = await getDb();
  const [row] = await db
    .insert(skills)
    .values({ scope, userId: user.id, name: data.name, description: data.description, instructions: data.instructions, mode: data.mode ?? "on_demand", enabled: data.enabled ?? true })
    .returning();
  return { ...row, ownerName: user.name } satisfies SkillRow;
}

/**
 * Changes a skill. Sharing one (scope: workspace) or taking it back
 * (scope: personal, which returns it to whoever wrote it) takes an admin.
 */
export async function updateSkill(a: Actor, id: string, patch: SkillPatch) {
  assertCan(a, "records:write");
  assertNotRun(a);
  const current = await find(a, id);
  const data = skillPatch.parse(patch);
  const me = who(a as Actor & { kind: "user" });
  if (!canEditSkill(me, current)) throw new ForbiddenError(current.scope === "workspace" ? "Shared skills are managed by admins. Ask one to change it, or save your own version." : "That skill belongs to another teammate.");
  const scope = data.scope ?? current.scope;
  if (scope !== current.scope || scope === "workspace" || current.userId !== me.id) assertInPerson(a);
  const next = { name: data.name ?? current.name, mode: data.mode ?? current.mode, instructions: data.instructions ?? current.instructions };
  await assertRoom(scope, current.userId, (data.enabled ?? current.enabled) ? next : { ...next, mode: "on_demand" }, current.id);
  const db = await getDb();
  const [row] = await db
    .update(skills)
    .set({ ...next, scope, description: data.description ?? current.description, enabled: data.enabled ?? current.enabled })
    .where(eq(skills.id, current.id))
    .returning();
  return { ...row, ownerName: current.ownerName } satisfies SkillRow;
}

export async function deleteSkill(a: Actor, id: string) {
  assertCan(a, "records:write");
  assertNotRun(a);
  const current = await find(a, id);
  if (!canEditSkill(who(a as Actor & { kind: "user" }), current)) throw new ForbiddenError(current.scope === "workspace" ? "Shared skills are managed by admins." : "That skill belongs to another teammate.");
  if (current.scope === "workspace" || current.userId !== teammate(a).id) assertInPerson(a);
  const db = await getDb();
  await db.delete(skills).where(eq(skills.id, current.id));
  return current;
}

/** The skills a teammate's agent works with: the shared ones and their own, when switched on. */
export async function activeSkills(userId: string): Promise<SkillBrief[]> {
  const db = await getDb();
  return db
    .select({ id: skills.id, name: skills.name, description: skills.description, mode: skills.mode, instructions: skills.instructions, scope: skills.scope })
    .from(skills)
    .where(and(eq(skills.enabled, true), or(eq(skills.scope, "workspace"), and(eq(skills.scope, "personal"), eq(skills.userId, userId)))))
    .orderBy(asc(sql`lower(${skills.name})`));
}
