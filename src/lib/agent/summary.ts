import "server-only";
import { and, desc, eq, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { generateText } from "ai";
import { appConfig } from "@/app.config";
import { getDb, schema } from "@/db";
import { getAppData } from "@/lib/crm/context";
import { clientsOfOrganization, getClient, getOrganization, getPerson, metricsOf, peopleOf, servicesOf } from "@/lib/crm/records";
import { formatMoney, personName } from "@/lib/format";
import { htmlToText } from "@/lib/safe-html";
import { billingFor, stripeConfigured } from "@/lib/stripe";
import { getWorkspace } from "@/lib/workspace";
import { activityLine, cleanSummary, isFresh, SUMMARY_LOCK_MS, summaryInstructions, type SummaryEntity } from "./summary-prompt";

/**
 * The AI snapshot at the top of client, person and organization pages. It's
 * written from everything the CRM knows about the record (for a client or an
 * organization, the whole account: its people's notes, calls, emails, texts,
 * meetings and tasks, its services and its Stripe billing; for a person, just
 * their own record), stored on the record, and shared by everyone who opens
 * it. After 24 hours it's still shown, and the next visit rewrites it.
 */

const tables = { client: schema.clients, person: schema.people, organization: schema.organizations } as const;
const { activities: a } = schema;

/** History lines sent to the model: newest first, and every open task or meeting. */
const MAX_HISTORY = 60;
const MAX_PLANNED = 25;
const MAX_PEOPLE = 25;

/** `refreshing` is true only when another visitor's rewrite is still running after the wait. */
export type Summary = { summary: string | null; summaryAt: string | null; refreshing: boolean };

async function readSummary(entity: SummaryEntity, id: string) {
  const db = await getDb();
  const t = tables[entity];
  const [row] = await db.select({ summary: t.summary, summaryAt: t.summaryAt, summaryStartedAt: t.summaryStartedAt }).from(t).where(eq(t.id, id));
  return row ?? null;
}

/**
 * The record's snapshot, rewritten first if it's missing or more than a day
 * old. If someone else is already rewriting it, waits for theirs.
 */
export async function ensureSummary(entity: SummaryEntity, id: string): Promise<Summary> {
  const current = await readSummary(entity, id);
  if (!current) return { summary: null, summaryAt: null, refreshing: false };
  const shown = { summary: current.summary, summaryAt: current.summaryAt?.toISOString() ?? null };
  if (current.summary && isFresh(current.summaryAt)) return { ...shown, refreshing: false };

  // Claim the rewrite: only one visitor at a time pays for it. A claim older than SUMMARY_LOCK_MS was abandoned.
  const db = await getDb();
  const t = tables[entity];
  const [claimed] = await db
    .update(t)
    .set({ summaryStartedAt: new Date() })
    .where(and(eq(t.id, id), or(isNull(t.summaryStartedAt), lt(t.summaryStartedAt, new Date(Date.now() - SUMMARY_LOCK_MS)))))
    .returning({ id: t.id });
  if (!claimed) return waitForSummary(entity, id, shown);

  try {
    const summary = await writeSummary(entity, id);
    const at = new Date();
    await db.update(t).set({ summary, summaryAt: at, summaryStartedAt: null }).where(eq(t.id, id));
    return { summary, summaryAt: at.toISOString(), refreshing: false };
  } catch (err) {
    await db.update(t).set({ summaryStartedAt: null }).where(eq(t.id, id));
    throw err;
  }
}

/** Someone else is writing it: wait for theirs (checking every 2 seconds, up to 40) instead of having the browser poll. */
async function waitForSummary(entity: SummaryEntity, id: string, shown: Omit<Summary, "refreshing">): Promise<Summary> {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 2_000));
    const row = await readSummary(entity, id);
    if (!row?.summaryStartedAt) return { summary: row?.summary ?? shown.summary, summaryAt: row?.summaryAt?.toISOString() ?? shown.summaryAt, refreshing: false };
  }
  return { ...shown, refreshing: true };
}

async function writeSummary(entity: SummaryEntity, id: string) {
  const ws = await getWorkspace();
  const today = new Intl.DateTimeFormat("en-US", { timeZone: ws.timezone, weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(new Date());
  const record = await recordContext(entity, id);
  const { text } = await generateText({
    model: appConfig.agent.summaryModel,
    reasoning: appConfig.agent.summaryReasoning,
    system: summaryInstructions(entity, today),
    prompt: record,
    // Reasoning counts toward this; the answer itself is two sentences.
    maxOutputTokens: 3_000,
  });
  const summary = cleanSummary(text);
  if (!summary) throw new Error("The model returned an empty summary.");
  return summary;
}

// ─── What the model reads ────────────────────────────────────────────────

/** Everything the CRM knows about the record, as plain text sections. */
export async function recordContext(entity: SummaryEntity, id: string): Promise<string> {
  const [app, ws] = await Promise.all([getAppData(), getWorkspace()]);
  const tz = ws.timezone;
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const d = (x: Date | string | null | undefined) => (x ? day.format(new Date(x)) : null);
  const member = (uid: string | null | undefined) => app.team.find((m) => m.id === uid)?.name ?? null;
  const money = (cents: number, currency = ws.currency) => formatMoney(cents, currency);
  const fieldLabel = (key: string) => app.customFields.find((f) => f.key === key)?.label ?? key;
  const custom = (values: Record<string, unknown> | null | undefined) =>
    Object.entries(values ?? {})
      .filter(([, v]) => v !== null && v !== "" && !(Array.isArray(v) && !v.length))
      .map(([k, v]) => `${fieldLabel(k)}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
      .join("; ");
  const line = (label: string, value: unknown) => (value === null || value === undefined || value === "" ? null : `${label}: ${value}`);
  const sections: string[] = [];
  let scope: SQL | undefined;

  if (entity === "client") {
    const row = await getClient(id);
    if (!row) throw new Error("Client not found.");
    const { client, person, organization } = row;
    const stage = app.pipelines.flatMap((p) => p.stages.map((s) => ({ ...s, pipeline: p.name }))).find((s) => s.id === client.stageId);
    const [services, metrics, accountPeople] = await Promise.all([servicesOf(id), metricsOf(id), client.organizationId ? peopleOf(client.organizationId) : Promise.resolve([])]);
    sections.push(
      [
        "## Client",
        line("Name", client.name),
        line("Category", client.category),
        line("Stage", stage ? `${stage.name} (${stage.pipeline})` : null),
        line("Potential value", client.category === "prospective" && client.value ? money(client.value, client.currency) : null),
        line("Expected to sign", client.category === "prospective" ? d(client.expectedCloseDate) : null),
        line("Client since", d(client.startedOn)),
        line("Left on", d(client.endedOn)),
        line("Why they left", client.churnReason),
        line("Open to coming back", client.category === "past" ? (client.openToReturn ? "yes" : "no") : null),
        line("Health", client.health),
        line("Owner", member(client.ownerId)),
        line("Tags", client.tags.join(", ")),
        line("Other fields", custom(client.custom)),
        line("Main contact", person ? `${personName(person)}${person.title ? `, ${person.title}` : ""}${person.email ? ` <${person.email}>` : ""}` : null),
        line("Organization", organization?.name),
      ]
        .filter(Boolean)
        .join("\n"),
    );
    if (services.length) sections.push(["## Services", ...services.map((s) => `${s.name}: ${money(s.price, client.currency)} per ${s.interval}, ${s.endedOn ? `ended ${d(s.endedOn)}` : s.startedOn ? `since ${d(s.startedOn)}` : "not started"}${s.note ? ` (${s.note})` : ""}`)].join("\n"));
    if (metrics.length) {
      const latest = new Map<string, (typeof metrics)[number]>();
      for (const m of metrics) latest.set(m.label, m);
      sections.push(["## Performance (latest)", ...[...latest.values()].map((m) => `${m.label}: ${m.value} (${d(m.period)})`)].join("\n"));
    }
    if (client.stripeCustomerId) sections.push(await billingSection([client.stripeCustomerId], d));
    const peopleIds = [...new Set([client.personId, ...accountPeople.map((p) => p.id)].filter((x): x is string => !!x))].slice(0, MAX_PEOPLE);
    if (accountPeople.length) sections.push(["## People at the account", ...accountPeople.slice(0, MAX_PEOPLE).map((p) => `${personName(p)}${p.title ? `, ${p.title}` : ""}`)].join("\n"));
    scope = or(eq(a.clientId, id), peopleIds.length ? inArray(a.personId, peopleIds) : undefined, client.organizationId ? eq(a.organizationId, client.organizationId) : undefined);
  } else if (entity === "organization") {
    const org = await getOrganization(id);
    if (!org) throw new Error("Organization not found.");
    const [people, clients] = await Promise.all([peopleOf(id), clientsOfOrganization(id)]);
    const db = await getDb();
    const stripeIds = clients.length
      ? (await db.select({ id: schema.clients.stripeCustomerId }).from(schema.clients).where(inArray(schema.clients.id, clients.map((c) => c.id)))).map((r) => r.id).filter((x): x is string => !!x)
      : [];
    sections.push(
      ["## Organization", line("Name", org.name), line("Website", org.domain), line("Industry", org.industry), line("Owner", member(org.ownerId)), line("Other fields", custom(org.custom))].filter(Boolean).join("\n"),
    );
    if (clients.length) sections.push(["## Clients", ...clients.map((c) => `${c.name}: ${c.category}, ${c.stageName}${c.mrr ? `, ${money(Number(c.mrr))}/mo` : c.value && c.category === "prospective" ? `, potential ${money(c.value)}` : ""}`)].join("\n"));
    if (people.length) sections.push(["## People", ...people.slice(0, MAX_PEOPLE).map((p) => `${personName(p)}${p.title ? `, ${p.title}` : ""}`)].join("\n"));
    if (stripeIds.length) sections.push(await billingSection(stripeIds.slice(0, 3), d));
    const peopleIds = people.slice(0, MAX_PEOPLE).map((p) => p.id);
    scope = or(eq(a.organizationId, id), peopleIds.length ? inArray(a.personId, peopleIds) : undefined, clients.length ? inArray(a.clientId, clients.map((c) => c.id)) : undefined);
  } else {
    const row = await getPerson(id);
    if (!row) throw new Error("Person not found.");
    const { person: p, organization: org } = row;
    const db = await getDb();
    const theirClients = await db.select({ name: schema.clients.name, category: schema.clients.category }).from(schema.clients).where(and(eq(schema.clients.personId, id), isNull(schema.clients.archivedAt)));
    sections.push(
      [
        "## Person",
        line("Name", personName(p)),
        line("Job title", p.title),
        line("Organization", org?.name),
        line("Email", p.email),
        line("Owner", member(p.ownerId)),
        line("Tags", p.tags.join(", ")),
        line("Other fields", custom(p.custom)),
        line("Main contact for", theirClients.map((c) => `${c.name} (${c.category})`).join(", ")),
        p.unsubscribedAt ? "Unsubscribed from campaigns" : null,
        p.emailBouncedAt ? "Their email address bounced" : null,
        line("Last campaign email", d(p.lastCampaignAt)),
      ]
        .filter(Boolean)
        .join("\n"),
    );
    scope = eq(a.personId, id);
  }

  sections.push(await activitySection(scope, d, member));
  return sections.filter(Boolean).join("\n\n");
}

/** Notes, calls, emails, texts, meetings and tasks: what's planned, then what happened, newest first. Campaign emails are left out. */
async function activitySection(scope: SQL | undefined, d: (x: Date | null) => string | null, member: (id: string | null) => string | null) {
  const db = await getDb();
  const notCampaign = sql`not exists (select 1 from outbound_emails oe where oe.id = ${a.emailId} and oe.campaign_id is not null)`;
  const cols = {
    type: a.type,
    subject: a.subject,
    body: a.body,
    direction: a.direction,
    outcome: a.outcome,
    occurredAt: a.occurredAt,
    dueAt: a.dueAt,
    completedAt: a.completedAt,
    createdAt: a.createdAt,
    userId: a.userId,
    assigneeId: a.assigneeId,
    clientName: schema.clients.name,
    firstName: schema.people.firstName,
    lastName: schema.people.lastName,
  };
  const base = () => db.select(cols).from(a).leftJoin(schema.clients, eq(schema.clients.id, a.clientId)).leftJoin(schema.people, eq(schema.people.id, a.personId)).$dynamic();
  const [planned, history] = await Promise.all([
    base()
      .where(and(scope, isNull(a.completedAt), sql`${a.dueAt} is not null`))
      .orderBy(a.dueAt)
      .limit(MAX_PLANNED),
    base()
      .where(and(scope, notCampaign, or(sql`${a.completedAt} is not null`, sql`${a.dueAt} is null`)))
      .orderBy(desc(sql`coalesce(${a.occurredAt}, ${a.completedAt}, ${a.createdAt})`))
      .limit(MAX_HISTORY),
  ]);
  const about = (r: (typeof planned)[number]) => r.clientName ?? (r.firstName ? personName({ firstName: r.firstName, lastName: r.lastName }) : null);
  const plannedLines = planned.map((r) =>
    activityLine({ when: d(r.dueAt) ?? "", type: r.type, status: `due${r.dueAt && r.dueAt < new Date() ? " (overdue)" : ""}, for ${member(r.assigneeId) ?? "nobody"}`, subject: r.subject, text: htmlToText(r.body), about: about(r) }),
  );
  const historyLines = history.map((r) =>
    activityLine({
      when: d(r.occurredAt ?? r.completedAt ?? r.createdAt) ?? "",
      type: r.type,
      status: r.type === "task" ? "done" : "",
      direction: r.direction,
      outcome: r.outcome,
      by: member(r.userId) ?? (r.direction === "inbound" ? "them" : null),
      subject: r.subject,
      text: htmlToText(r.body),
      about: about(r),
    }),
  );
  return [
    "## Planned (open tasks, calls and meetings)",
    ...(plannedLines.length ? plannedLines : ["Nothing planned."]),
    "",
    `## History (newest first${history.length === MAX_HISTORY ? `, latest ${MAX_HISTORY}` : ""})`,
    ...(historyLines.length ? historyLines : ["No activity logged yet."]),
  ].join("\n");
}

/** What Stripe says, briefly: subscriptions, unpaid invoices, failed payments. A Stripe outage leaves it out rather than failing the summary. */
async function billingSection(customerIds: string[], d: (x: Date | null) => string | null) {
  if (!stripeConfigured()) return "";
  const lines: string[] = [];
  for (const cid of customerIds) {
    try {
      const b = await billingFor(cid);
      const cur = (n: number, c: string) => formatMoney(n, c.toUpperCase());
      if (b.customer.delinquent) lines.push("Stripe marks this customer as delinquent (a payment failed).");
      if (b.customer.balance) lines.push(`Account balance: ${cur(b.customer.balance, b.customer.currency ?? "usd")}`);
      for (const s of b.subscriptions.filter((s) => s.status !== "incomplete_expired").slice(0, 5)) {
        const items = s.items.map((i) => `${i.name}${i.price.unit_amount ? ` ${cur(i.price.unit_amount * (i.quantity ?? 1), i.price.currency)}/${i.price.recurring?.interval ?? "once"}` : ""}`).join(", ");
        const end = s.periodEnd ? d(new Date(s.periodEnd * 1000)) : null;
        lines.push(`Subscription ${s.status}: ${items}${s.cancel_at_period_end && end ? `, cancels ${end}` : end && s.status === "active" ? `, renews ${end}` : ""}`);
      }
      for (const i of b.invoices.filter((i) => i.status === "open").slice(0, 5)) lines.push(`Unpaid invoice ${i.number ?? ""}: ${cur(i.amount_remaining, i.currency)}${i.overdue ? ", overdue" : ""}${i.due_date ? `, due ${d(new Date(i.due_date * 1000))}` : ""}`);
      const failed = b.charges.find((c) => c.status === "failed");
      if (failed) lines.push(`Last failed payment: ${cur(failed.amount, failed.currency)} on ${d(new Date(failed.created * 1000))}${failed.failure_message ? ` (${failed.failure_message})` : ""}`);
    } catch (err) {
      console.warn("[summary] stripe", (err as Error).message);
    }
  }
  return lines.length ? ["## Billing (Stripe)", ...lines].join("\n") : "";
}
