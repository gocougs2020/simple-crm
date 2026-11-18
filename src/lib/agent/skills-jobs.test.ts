import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { operationList } from "@/lib/api/operations";
import { allowedOperations, confirmReason, needsConfirmation } from "./policy";
import { agentInstructions } from "./prompt";
import { runMayUse, runMessage } from "./run-rules";
import { cadenceLabel, canEditJob, canSeeJob, cleanCadence, jobInput, nextRun } from "./schedule-rules";
import { alwaysRefusal, canEditSkill, canSeeSkill, MAX_ALWAYS_INSTRUCTIONS, MAX_ALWAYS_SKILLS, skillInput, skillsSection, type SkillBrief } from "./skill-rules";

const sam = { id: "u1", name: "Sam Lee", email: "sam@x.co", role: "member" as const };
const workspace = { name: "Acme", timezone: "America/Denver", currency: "USD" };
const now = new Date("2026-11-18T16:00:00Z");

const skill = (over: Partial<SkillBrief> = {}): SkillBrief => ({ id: "s1", name: "Call write-ups", description: "Use when logging a call.", mode: "on_demand", instructions: "Three bullets.", scope: "personal", ...over });

describe("agent skills", () => {
  it("needs a name, when to use it and what to do", () => {
    assert.ok(skillInput.safeParse({ name: "Call write-ups", description: "Use when logging a call.", instructions: "Three bullets." }).success);
    assert.equal(skillInput.safeParse({ name: " ", description: "x", instructions: "y" }).error?.issues[0].message, "Name the skill.");
    assert.equal(skillInput.safeParse({ name: "x", description: "", instructions: "y" }).error?.issues[0].message, "Say when the agent should use this skill.");
  });

  it("keeps always-on skills short and few", () => {
    assert.equal(alwaysRefusal({ mode: "on_demand", instructions: "x".repeat(MAX_ALWAYS_INSTRUCTIONS + 1) }, 99), null);
    assert.equal(alwaysRefusal({ mode: "always", instructions: "short" }, MAX_ALWAYS_SKILLS - 1), null);
    assert.match(alwaysRefusal({ mode: "always", instructions: "x".repeat(MAX_ALWAYS_INSTRUCTIONS + 1) }, 0)!, /Shorten it/);
    assert.match(alwaysRefusal({ mode: "always", instructions: "short" }, MAX_ALWAYS_SKILLS)!, /can be always on/);
  });

  it("lets a teammate change their own, and only admins the shared ones and other people's", () => {
    const member = { id: "u1", admin: false };
    const admin = { id: "u9", admin: true };
    assert.ok(canSeeSkill(member, { scope: "workspace", userId: "u9" }) && canSeeSkill(member, { scope: "personal", userId: "u1" }));
    assert.ok(!canSeeSkill(member, { scope: "personal", userId: "u2" }));
    assert.ok(canSeeSkill(admin, { scope: "personal", userId: "u2" }));
    assert.ok(canEditSkill(member, { scope: "personal", userId: "u1" }));
    assert.ok(!canEditSkill(member, { scope: "workspace", userId: "u1" }) && !canEditSkill(member, { scope: "personal", userId: "u2" }));
    assert.ok(canEditSkill(admin, { scope: "workspace", userId: "u1" }) && canEditSkill(admin, { scope: "personal", userId: "u2" }));
  });

  it("puts always-on skills in the instructions in full and lists the rest to read when needed", () => {
    assert.equal(skillsSection([], { tool: "get_skill", owner: "Sam" }), "");
    const text = skillsSection([skill(), skill({ id: "s2", name: "House style", mode: "always", instructions: "Write in British English.", scope: "workspace" })], { tool: "get_skill", owner: "Sam Lee" });
    assert.match(text, /### House style\nWrite in British English\./);
    assert.match(text, /read with get_skill/);
    assert.match(text, /- Call write-ups \(id s1\): Use when logging a call\./);
    assert.ok(!text.includes("Three bullets."));
  });

  it("gives the chat agent the teammate's skills, and tells it to save one only when asked", () => {
    const text = agentInstructions({ user: sam, canWrite: true, workspace, now, background: true, skills: [skill()] });
    assert.match(text, /## Skills/);
    assert.match(text, /create_skill/);
    assert.match(text, /create_scheduled_job/);
    const viewer = agentInstructions({ user: { ...sam, role: "viewer" }, canWrite: false, workspace, now, skills: [skill()] });
    assert.match(viewer, /## Skills/);
    assert.ok(!viewer.includes("create_skill"));
    assert.ok(!agentInstructions({ user: sam, canWrite: true, workspace, now, background: false }).includes("create_scheduled_job"));
  });

  it("asks for short, direct answers", () => {
    const text = agentInstructions({ user: sam, canWrite: true, workspace, now });
    assert.match(text, /Answer the question that was asked, first/);
    assert.match(text, /Don't recite a whole timeline/);
    assert.match(text, /Never drop something the teammate needs to act on/);
  });
});

describe("scheduled jobs", () => {
  const tz = "America/Denver";
  // Wednesday 2026-11-18, 09:00 in Denver.
  const wed9 = new Date("2026-11-18T16:00:00Z");
  const iso = (d: Date | null) => d?.toISOString() ?? null;

  it("needs what its cadence uses, and a time on the quarter hour", () => {
    const base = { name: "Review", request: "Do it.", time: "08:00" };
    assert.ok(jobInput.safeParse({ ...base, every: "weekday" }).success);
    assert.equal(jobInput.safeParse({ ...base, every: "week" }).error?.issues[0].message, "Pick the day of the week.");
    assert.equal(jobInput.safeParse({ ...base, every: "month" }).error?.issues[0].message, "Pick the day of the month, 1 to 28.");
    assert.equal(jobInput.safeParse({ ...base, every: "once" }).error?.issues[0].message, "Pick the date.");
    assert.match(jobInput.safeParse({ ...base, every: "day", time: "08:10" }).error!.issues[0].message, /quarter hour/);
    assert.ok(!jobInput.safeParse({ ...base, every: "month", monthDay: 31 }).success);
    assert.deepEqual(cleanCadence({ every: "day", time: "08:00", weekday: 3, monthDay: 4, onDate: "2026-01-01" }), { every: "day", time: "08:00", weekday: null, monthDay: null, onDate: null });
  });

  it("finds the next run in the workspace's time zone", () => {
    assert.equal(iso(nextRun({ every: "day", time: "09:15" }, wed9, tz)), "2026-11-18T16:15:00.000Z");
    // Today's time has passed (or is now): tomorrow.
    assert.equal(iso(nextRun({ every: "day", time: "09:00" }, wed9, tz)), "2026-11-19T16:00:00.000Z");
    // Friday afternoon: the next weekday is Monday.
    assert.equal(iso(nextRun({ every: "weekday", time: "08:00" }, new Date("2026-11-20T22:00:00Z"), tz)), "2026-11-23T15:00:00.000Z");
    assert.equal(iso(nextRun({ every: "week", weekday: 1, time: "08:00" }, wed9, tz)), "2026-11-23T15:00:00.000Z");
    assert.equal(iso(nextRun({ every: "week", weekday: 3, time: "17:30" }, wed9, tz)), "2026-11-19T00:30:00.000Z");
    assert.equal(iso(nextRun({ every: "month", monthDay: 1, time: "07:00" }, wed9, tz)), "2026-12-01T14:00:00.000Z");
  });

  it("keeps the local time across a daylight saving change", () => {
    // Clocks go forward on 2027-03-14 in Denver: 08:00 is 15:00 UTC before, 14:00 UTC after.
    assert.equal(iso(nextRun({ every: "day", time: "08:00" }, new Date("2027-03-13T16:00:00Z"), tz)), "2027-03-14T14:00:00.000Z");
  });

  it("runs a one-time job once", () => {
    assert.equal(iso(nextRun({ every: "once", onDate: "2026-11-19", time: "14:00" }, wed9, tz)), "2026-11-19T21:00:00.000Z");
    assert.equal(nextRun({ every: "once", onDate: "2026-11-17", time: "14:00" }, wed9, tz), null);
  });

  it("says its cadence in words", () => {
    assert.equal(cadenceLabel({ every: "weekday", time: "08:00" }), "Every weekday at 8:00 AM");
    assert.equal(cadenceLabel({ every: "week", weekday: 1, time: "13:30" }), "Every Monday at 1:30 PM");
    assert.equal(cadenceLabel({ every: "month", monthDay: 22, time: "00:15" }), "On the 22nd of each month at 12:15 AM");
    assert.equal(cadenceLabel({ every: "once", onDate: "2026-12-01", time: "12:00" }), "Once, on 2026-12-01 at 12:00 PM");
  });

  it("lets a teammate change their own jobs, and only admins the offers and other people's", () => {
    const member = { id: "u1", admin: false };
    assert.ok(canSeeJob(member, { scope: "workspace", userId: "u9" }) && !canSeeJob(member, { scope: "personal", userId: "u2" }));
    assert.ok(canEditJob(member, { scope: "personal", userId: "u1" }) && !canEditJob(member, { scope: "workspace", userId: "u1" }));
    assert.ok(canEditJob({ id: "u9", admin: true }, { scope: "personal", userId: "u2" }));
  });

  it("tells a scheduled run what it is, and that nobody is waiting", () => {
    const text = runMessage({ user: sam, canWrite: true, workspace, now, source: "schedule", schedule: { name: "Monday review", cadence: "Every Monday at 8:00 AM" }, skills: "## Skills\n- x", prompt: "List stale prospects." });
    assert.match(text, /scheduled job they set up/);
    assert.match(text, /"Monday review" and runs on this schedule: Every Monday at 8:00 AM/);
    assert.match(text, /If there's nothing to report, say so in one line/);
    assert.match(text, /## Skills/);
  });
});

describe("skill and job tools", () => {
  const ops = (tag: string) => operationList.filter((o) => o.tag === tag);

  it("a background run can read skills and jobs but never write them", () => {
    for (const tag of ["Skills", "Scheduled jobs"]) {
      assert.ok(ops(tag).length >= 4);
      for (const o of ops(tag)) assert.equal(runMayUse(o), o.method === "GET", o.tool ?? o.path);
    }
    assert.ok(runMayUse({ method: "POST", tag: "People" }));
  });

  it("viewers get the reading tools only, and deleting asks first", () => {
    const viewer = allowedOperations((p) => p === "records:read", { features: ["background"] }).map((o) => o.tool);
    assert.ok(viewer.includes("list_skills") && viewer.includes("get_skill") && viewer.includes("list_scheduled_jobs"));
    assert.ok(!viewer.includes("create_skill") && !viewer.includes("create_scheduled_job"));
    assert.ok(needsConfirmation("delete_skill") && needsConfirmation("delete_scheduled_job"));
    assert.ok(!needsConfirmation("create_skill"));
    assert.match(confirmReason("delete_skill"), /for good/);
    assert.match(confirmReason("archive_client"), /restored/);
  });

  it("offers scheduled jobs only where background work runs", () => {
    const without = allowedOperations(() => true, { features: [] }).map((o) => o.tool);
    assert.ok(without.includes("create_skill") && !without.includes("create_scheduled_job"));
  });
});
