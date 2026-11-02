import "server-only";
import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { rankBetween } from "./rank";

/**
 * Fills an empty workspace with a small, realistic set of organizations,
 * people, clients in each category, services and activity so the interface
 * can be tried out. Development
 * only (Settings → Workspace shows the button when not on Vercel).
 */
export async function loadSampleData(userId: string) {
  const db = await getDb();
  const pipelineStages = async (category: "prospective" | "current" | "past") => {
    const [pipeline] = await db.select().from(schema.pipelines).where(eq(schema.pipelines.category, category)).orderBy(asc(schema.pipelines.position)).limit(1);
    if (!pipeline) throw new Error(`Create a pipeline for ${category} clients first.`);
    return { pipeline, stages: await db.select().from(schema.stages).where(eq(schema.stages.pipelineId, pipeline.id)).orderBy(asc(schema.stages.position)) };
  };
  const prospective = await pipelineStages("prospective");
  const current = await pipelineStages("current");
  const past = await pipelineStages("past");
  const day = 86400_000;
  const now = Date.now();
  const ymd = (offsetDays: number) => new Date(now + offsetDays * day).toISOString().slice(0, 10);

  const orgs = await db
    .insert(schema.organizations)
    .values([
      { name: "Bitterroot Logistics", domain: "bitterrootlogistics.com", industry: "Freight and logistics", phone: "(208) 555-0142", address: "410 W Main St, Boise, ID 83702", ownerId: userId, createdBy: userId },
      { name: "Sawtooth Health Partners", domain: "sawtoothhealth.org", industry: "Healthcare", phone: "(208) 555-0177", ownerId: userId, createdBy: userId },
      { name: "Owyhee Solar", domain: "owyheesolar.com", industry: "Energy", ownerId: userId, createdBy: userId },
      { name: "Payette Brewing Co.", domain: "payettebrewing.com", industry: "Food and beverage", ownerId: userId, createdBy: userId },
      { name: "Clearwater Software", domain: "clearwater.dev", industry: "Software", ownerId: userId, createdBy: userId },
      { name: "Teton Outfitters", domain: "tetonoutfitters.com", industry: "Retail", ownerId: userId, createdBy: userId },
    ])
    .returning();
  const [bitterroot, sawtooth, owyhee, payette, clearwater, teton] = orgs;

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
      { firstName: "Luis", lastName: "Ortega", email: "luis@tetonoutfitters.com", title: "Owner", organizationId: teton.id, ownerId: userId, createdBy: userId },
    ])
    .returning();
  const [maya, , priya, cole, elena, sam, , luis] = people;

  const services = await db
    .insert(schema.services)
    .values([
      { name: "Retained recruiting", description: "Dedicated recruiter, unlimited roles", price: 450_000, interval: "month", position: 0 },
      { name: "Contract staffing", description: "Hourly contractors, billed monthly", price: 220_000, interval: "month", position: 1 },
      { name: "Executive search", description: "One leadership placement", price: 2_500_000, interval: "once", position: 2 },
      { name: "Employer branding", description: "Careers page, job ads and reporting", price: 1_800_000, interval: "year", position: 3 },
    ])
    .returning();
  const [retained, contract, , branding] = services;

  type Row = { name: string; value?: number; stage: { id: string; pipelineId: string; name: string }; personId: string; organizationId: string; daysIn: number; extra?: Partial<typeof schema.clients.$inferInsert> };
  const at = (list: { stages: { id: string; pipelineId: string; name: string }[] }, i: number) => list.stages[Math.min(i, list.stages.length - 1)];
  const insertClients = async (category: "prospective" | "current" | "past", rows: Row[]) => {
    const out = [];
    let rank: string | null = null;
    for (const d of rows) {
      rank = rankBetween(rank, null);
      const [row] = await db
        .insert(schema.clients)
        .values({
          name: d.name,
          category,
          value: d.value ?? 0,
          pipelineId: d.stage.pipelineId,
          stageId: d.stage.id,
          personId: d.personId,
          organizationId: d.organizationId,
          ownerId: userId,
          rank,
          stageChangedAt: new Date(now - d.daysIn * day),
          expectedCloseDate: category === "prospective" ? ymd(30) : null,
          createdBy: userId,
          ...d.extra,
        })
        .returning();
      out.push(row);
      await db.insert(schema.events).values({ entityType: "client", entityId: row.id, action: "created", data: { stage: d.stage.name, category }, userId, createdAt: new Date(now - (d.daysIn + 3) * day) });
    }
    return out;
  };
  const prospects = await insertClients("prospective", [
    { name: "Sawtooth Health Partners", value: 7_500_000, stage: at(prospective, 3), personId: priya.id, organizationId: sawtooth.id, daysIn: 9 },
    { name: "Owyhee Solar", value: 2_200_000, stage: at(prospective, 1), personId: cole.id, organizationId: owyhee.id, daysIn: 21 },
    { name: "Clearwater Software", value: 6_000_000, stage: at(prospective, 4), personId: sam.id, organizationId: clearwater.id, daysIn: 6 },
  ]);
  const currents = await insertClients("current", [
    { name: "Bitterroot Logistics", stage: at(current, 1), personId: maya.id, organizationId: bitterroot.id, daysIn: 40, extra: { startedOn: ymd(-210), health: "good", tags: ["2026 cohort"] } },
    { name: "Payette Brewing Co.", stage: at(current, 2), personId: elena.id, organizationId: payette.id, daysIn: 5, extra: { startedOn: ymd(-340), health: "watch" } },
  ]);
  const pasts = await insertClients("past", [
    { name: "Teton Outfitters", stage: at(past, 1), personId: luis.id, organizationId: teton.id, daysIn: 60, extra: { startedOn: ymd(-500), endedOn: ymd(-60), churnReason: "Budget cut", openToReturn: true, tags: ["win-back"] } },
  ]);
  const [sawtoothClient, owyheeClient, clearwaterClient] = prospects;
  const [bitterrootClient, payetteClient] = currents;
  const [tetonClient] = pasts;
  const created = [...prospects, ...currents, ...pasts];

  await db.insert(schema.clientServices).values([
    { clientId: bitterrootClient.id, serviceId: retained.id, price: retained.price, interval: "month", startedOn: ymd(-210) },
    { clientId: bitterrootClient.id, serviceId: branding.id, price: branding.price, interval: "year", startedOn: ymd(-120) },
    { clientId: payetteClient.id, serviceId: contract.id, price: 180_000, interval: "month", startedOn: ymd(-340), note: "Seasonal rate" },
    { clientId: tetonClient.id, serviceId: retained.id, price: 400_000, interval: "month", startedOn: ymd(-500), endedOn: ymd(-60) },
  ]);
  const months = [-150, -120, -90, -60, -30, 0];
  await db.insert(schema.clientMetrics).values([
    ...months.map((m, i) => ({ clientId: bitterrootClient.id, label: "Hires placed", value: [1, 2, 2, 3, 4, 4][i], period: ymd(m), userId })),
    ...months.map((m, i) => ({ clientId: bitterrootClient.id, label: "Days to fill", value: [41, 38, 35, 31, 29, 27][i], period: ymd(m), userId })),
    ...months.slice(3).map((m, i) => ({ clientId: payetteClient.id, label: "Shifts covered", value: [120, 96, 88][i], period: ymd(m), userId })),
  ]);

  const a = (v: Partial<typeof schema.activities.$inferInsert> & Pick<typeof schema.activities.$inferInsert, "type">) => ({ userId, assigneeId: userId, ...v });
  await db.insert(schema.activities).values([
    a({ type: "call", direction: "outbound", outcome: "Connected", durationMinutes: 22, subject: null, body: "<p>Maya confirmed budget for six dispatchers. Wants first candidates before the 15th. Night shift is the hard part.</p>", occurredAt: new Date(now - 2 * day), personId: maya.id, organizationId: bitterroot.id, clientId: bitterrootClient.id }),
    a({ type: "email", direction: "inbound", subject: "Re: Dispatcher roles", body: "<p>Thanks for the call. Attaching the job descriptions. Can we talk Thursday about pay bands?</p>", occurredAt: new Date(now - 1 * day), personId: maya.id, organizationId: bitterroot.id, clientId: bitterrootClient.id }),
    a({ type: "task", subject: "Send pay band benchmarks", dueAt: new Date(now + 1 * day), personId: maya.id, organizationId: bitterroot.id, clientId: bitterrootClient.id }),
    a({ type: "meeting", subject: "Intro with Priya", outcome: "Held", durationMinutes: 45, body: "<p>Leadership search for two nurse managers. Decision by end of quarter. Priya is the champion; CFO signs.</p>", occurredAt: new Date(now - 6 * day), personId: priya.id, organizationId: sawtooth.id, clientId: sawtoothClient.id }),
    a({ type: "note", body: "<p>Priya was referred by Hannah Lee. Send Hannah a thank-you if this closes.</p>", occurredAt: new Date(now - 6 * day), personId: priya.id, organizationId: sawtooth.id, pinned: true }),
    a({ type: "call", subject: "Pricing follow-up", dueAt: new Date(now - 1 * day), personId: priya.id, organizationId: sawtooth.id, clientId: sawtoothClient.id }),
    a({ type: "text", direction: "inbound", body: "<p>Running 10 min late, sorry!</p>", occurredAt: new Date(now - 20 * day), personId: cole.id, organizationId: owyhee.id, clientId: owyheeClient.id }),
    a({ type: "call", direction: "outbound", outcome: "Left voicemail", occurredAt: new Date(now - 3 * day), personId: sam.id, organizationId: clearwater.id, clientId: clearwaterClient.id }),
    a({ type: "meeting", subject: "Contract review with Sam", dueAt: new Date(now + 3 * day), personId: sam.id, organizationId: clearwater.id, clientId: clearwaterClient.id }),
    a({ type: "note", body: "<p>Elena prefers texts over email.</p>", occurredAt: new Date(now - 1 * day), personId: elena.id, organizationId: payette.id, clientId: payetteClient.id }),
    a({ type: "call", subject: "Renewal conversation", dueAt: new Date(now + 4 * day), personId: elena.id, organizationId: payette.id, clientId: payetteClient.id }),
    a({ type: "meeting", subject: "Quarterly review", outcome: "Held", durationMinutes: 50, body: "<p>Placements are ahead of plan. Maya wants to add two warehouse leads next quarter.</p>", occurredAt: new Date(now - 12 * day), personId: maya.id, organizationId: bitterroot.id, clientId: bitterrootClient.id }),
    a({ type: "note", body: "<p>Luis said they'd come back once the new store opens in spring.</p>", occurredAt: new Date(now - 58 * day), personId: luis.id, organizationId: teton.id, clientId: tetonClient.id }),
  ]);
  for (const p of [maya, priya, cole, sam, elena]) await db.update(schema.people).set({ lastActivityAt: new Date(now - day) }).where(eq(schema.people.id, p.id));
  for (const d of created) await db.update(schema.clients).set({ lastActivityAt: new Date(now - 2 * day) }).where(eq(schema.clients.id, d.id));

  await db.insert(schema.emailTemplates).values([
    { name: "Intro follow-up", subject: "Great meeting you, {{first_name}}", body: "<p>Hi {{first_name}},</p><p>Thanks for taking the time today. As promised, here's a quick summary of what we covered and the next steps.</p><p>Talk soon,</p>", createdBy: userId },
    { name: "Check-in", subject: "Checking in", body: "<p>Hi {{first_name}},</p><p>Just checking in on how things are going at {{company|your team}}. Anything I can help with this week?</p>", createdBy: userId },
  ]);
  return { organizations: orgs.length, people: people.length, clients: created.length };
}
