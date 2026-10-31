import "server-only";
import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { rankBetween } from "./rank";

/**
 * Fills an empty workspace with a small, realistic set of organizations,
 * people, deals and activity so the interface can be tried out. Development
 * only (Settings → Workspace shows the button when not on Vercel).
 */
export async function loadSampleData(userId: string) {
  const db = await getDb();
  const [pipeline] = await db.select().from(schema.pipelines).orderBy(asc(schema.pipelines.position)).limit(1);
  if (!pipeline) throw new Error("Create a pipeline first.");
  const stages = await db.select().from(schema.stages).where(eq(schema.stages.pipelineId, pipeline.id)).orderBy(asc(schema.stages.position));
  const day = 86400_000;
  const now = Date.now();

  const orgs = await db
    .insert(schema.organizations)
    .values([
      { name: "Bitterroot Logistics", domain: "bitterrootlogistics.com", industry: "Freight and logistics", phone: "(208) 555-0142", address: "410 W Main St, Boise, ID 83702", ownerId: userId, createdBy: userId },
      { name: "Sawtooth Health Partners", domain: "sawtoothhealth.org", industry: "Healthcare", phone: "(208) 555-0177", ownerId: userId, createdBy: userId },
      { name: "Owyhee Solar", domain: "owyheesolar.com", industry: "Energy", ownerId: userId, createdBy: userId },
      { name: "Payette Brewing Co.", domain: "payettebrewing.com", industry: "Food and beverage", ownerId: userId, createdBy: userId },
      { name: "Clearwater Software", domain: "clearwater.dev", industry: "Software", ownerId: userId, createdBy: userId },
    ])
    .returning();
  const [bitterroot, sawtooth, owyhee, payette, clearwater] = orgs;

  const people = await db
    .insert(schema.people)
    .values([
      { firstName: "Maya", lastName: "Okafor", email: "maya.okafor@bitterrootlogistics.com", phone: "(208) 555-0101", title: "VP of Operations", organizationId: bitterroot.id, ownerId: userId, tags: ["decision-maker"], createdBy: userId },
      { firstName: "Dan", lastName: "Whitfield", email: "dan@bitterrootlogistics.com", title: "Fleet Manager", organizationId: bitterroot.id, ownerId: userId, createdBy: userId },
      { firstName: "Priya", lastName: "Raman", email: "praman@sawtoothhealth.org", phone: "(208) 555-0119", title: "Director of Talent", organizationId: sawtooth.id, ownerId: userId, tags: ["decision-maker", "referral"], createdBy: userId },
      { firstName: "Cole", lastName: "Jensen", email: "cole@owyheesolar.com", title: "Founder", organizationId: owyhee.id, ownerId: userId, createdBy: userId },
      { firstName: "Elena", lastName: "Marsh", email: "elena@payettebrewing.com", title: "Head of People", organizationId: payette.id, ownerId: userId, tags: ["newsletter"], createdBy: userId },
      { firstName: "Sam", lastName: "Torres", email: "sam.torres@clearwater.dev", phone: "(208) 555-0188", title: "CTO", organizationId: clearwater.id, ownerId: userId, createdBy: userId },
      { firstName: "Hannah", lastName: "Lee", email: "hannah.lee@gmail.com", title: "Independent consultant", ownerId: userId, tags: ["referral"], createdBy: userId },
    ])
    .returning();
  const [maya, , priya, cole, elena, sam] = people;

  const s = (i: number) => stages[Math.min(i, stages.length - 1)];
  const dealRows = [
    { title: "Bitterroot — 6 dispatcher hires", value: 4_800_000, stage: s(3), personId: maya.id, organizationId: bitterroot.id, daysIn: 4 },
    { title: "Sawtooth — nursing leadership search", value: 7_500_000, stage: s(2), personId: priya.id, organizationId: sawtooth.id, daysIn: 9 },
    { title: "Owyhee Solar — field technicians", value: 2_200_000, stage: s(1), personId: cole.id, organizationId: owyhee.id, daysIn: 21 },
    { title: "Payette — seasonal staffing", value: 900_000, stage: s(0), personId: elena.id, organizationId: payette.id, daysIn: 2 },
    { title: "Clearwater — senior engineers", value: 6_000_000, stage: s(4), personId: sam.id, organizationId: clearwater.id, daysIn: 6 },
    { title: "Sawtooth — HR coordinator", value: 1_200_000, stage: s(0), personId: priya.id, organizationId: sawtooth.id, daysIn: 1 },
  ];
  const created = [];
  let rank: string | null = null;
  for (const d of dealRows) {
    rank = rankBetween(rank, null);
    const [row] = await db
      .insert(schema.deals)
      .values({
        title: d.title,
        value: d.value,
        pipelineId: pipeline.id,
        stageId: d.stage.id,
        personId: d.personId,
        organizationId: d.organizationId,
        ownerId: userId,
        rank,
        stageChangedAt: new Date(now - d.daysIn * day),
        expectedCloseDate: new Date(now + 30 * day).toISOString().slice(0, 10),
        createdBy: userId,
      })
      .returning();
    created.push(row);
    await db.insert(schema.events).values({ entityType: "deal", entityId: row.id, action: "created", data: { stage: d.stage.name }, userId, createdAt: new Date(now - (d.daysIn + 3) * day) });
  }

  const [bitterrootDeal, sawtoothDeal, owyheeDeal, , clearwaterDeal] = created;
  const a = (v: Partial<typeof schema.activities.$inferInsert> & Pick<typeof schema.activities.$inferInsert, "type">) => ({ userId, assigneeId: userId, ...v });
  await db.insert(schema.activities).values([
    a({ type: "call", direction: "outbound", outcome: "Connected", durationMinutes: 22, subject: null, body: "<p>Maya confirmed budget for six dispatchers. Wants first candidates before the 15th. Night shift is the hard part.</p>", occurredAt: new Date(now - 2 * day), personId: maya.id, organizationId: bitterroot.id, dealId: bitterrootDeal.id }),
    a({ type: "email", direction: "inbound", subject: "Re: Dispatcher roles", body: "<p>Thanks for the call. Attaching the job descriptions. Can we talk Thursday about pay bands?</p>", occurredAt: new Date(now - 1 * day), personId: maya.id, organizationId: bitterroot.id, dealId: bitterrootDeal.id }),
    a({ type: "task", subject: "Send pay band benchmarks", dueAt: new Date(now + 1 * day), personId: maya.id, organizationId: bitterroot.id, dealId: bitterrootDeal.id }),
    a({ type: "meeting", subject: "Intro with Priya", outcome: "Held", durationMinutes: 45, body: "<p>Leadership search for two nurse managers. Decision by end of quarter. Priya is the champion; CFO signs.</p>", occurredAt: new Date(now - 6 * day), personId: priya.id, organizationId: sawtooth.id, dealId: sawtoothDeal.id }),
    a({ type: "note", body: "<p>Priya was referred by Hannah Lee. Send Hannah a thank-you if this closes.</p>", occurredAt: new Date(now - 6 * day), personId: priya.id, organizationId: sawtooth.id, pinned: true }),
    a({ type: "call", subject: "Pricing follow-up", dueAt: new Date(now - 1 * day), personId: priya.id, organizationId: sawtooth.id, dealId: sawtoothDeal.id }),
    a({ type: "text", direction: "inbound", body: "<p>Running 10 min late, sorry!</p>", occurredAt: new Date(now - 20 * day), personId: cole.id, organizationId: owyhee.id, dealId: owyheeDeal.id }),
    a({ type: "call", direction: "outbound", outcome: "Left voicemail", occurredAt: new Date(now - 3 * day), personId: sam.id, organizationId: clearwater.id, dealId: clearwaterDeal.id }),
    a({ type: "meeting", subject: "Contract review with Sam", dueAt: new Date(now + 3 * day), personId: sam.id, organizationId: clearwater.id, dealId: clearwaterDeal.id }),
    a({ type: "note", body: "<p>Elena prefers texts over email.</p>", occurredAt: new Date(now - 1 * day), personId: elena.id, organizationId: payette.id }),
  ]);
  for (const p of [maya, priya, cole, sam, elena]) await db.update(schema.people).set({ lastActivityAt: new Date(now - day) }).where(eq(schema.people.id, p.id));
  for (const d of created) await db.update(schema.deals).set({ lastActivityAt: new Date(now - 2 * day) }).where(eq(schema.deals.id, d.id));

  await db.insert(schema.emailTemplates).values([
    { name: "Intro follow-up", subject: "Great meeting you, {{first_name}}", body: "<p>Hi {{first_name}},</p><p>Thanks for taking the time today. As promised, here's a quick summary of what we covered and the next steps.</p><p>Talk soon,</p>", createdBy: userId },
    { name: "Check-in", subject: "Checking in", body: "<p>Hi {{first_name}},</p><p>Just checking in on how things are going at {{company|your team}}. Anything I can help with this week?</p>", createdBy: userId },
  ]);
  return { organizations: orgs.length, people: people.length, deals: created.length };
}
