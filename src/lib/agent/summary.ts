import "server-only";
import { and, desc, eq, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { generateText } from "ai";
import { appConfig } from "@/app.config";
import { getDb, schema } from "@/db";
import { getAppData } from "@/lib/crm/context";
import { organizationsOfClient } from "@/lib/crm/client-organizations";
import { clientPeople, clientsOfOrganization, getClient, getOrganization, getPerson, metricsOf, otherOrganizationsOfClient, peopleOf } from "@/lib/crm/records";
import { productDescriber } from "@/lib/product-rules";
import { formatMoney, personName } from "@/lib/format";
import { htmlToText } from "@/lib/safe-html";
import { stripeAccounts, stripeConfigured } from "@/lib/stripe";
import { billingStatusLabels, type BillingStatus } from "@/lib/stripe/rules";
import { customersOfClient } from "@/lib/stripe/sync";
import { getWorkspace } from "@/lib/workspace";
import { aiGateway } from "./gateway";
import { activityLine, cleanSummary, SUMMARY_LOCK_MS, summaryDue, summaryInstructions, type SummaryEntity } from "./summary-prompt";

/**
 * The AI snapshot at the top of client, person and organization pages. It's
 * written from everything the CRM knows about the record (for a client or an
 * organization, the whole account: its people's notes, calls, emails, texts,
 * meetings and tasks, the Stripe products it pays for and what each delivers,
 * and its Stripe billing; for a person, just
 * their own record), stored on the record, and shared by everyone who opens
 * it. After 24 hours it's still shown, and the next visit rewrites it.
 */

const tables = { client: schema.clients, person: schema.people, organization: schema.organizations } as const;
const { activities: a } = schema;

/** History lines sent to the model: newest first, and every open task or meeting. */
const MAX_HISTORY = 60;
/** Older notes, meetings and calls beyond those: where the account's story often is (why they left, what they struggled with). */
const MAX_EARLIER = 25;
const MAX_PLANNED = 25;
const MAX_PEOPLE = 25;

/** `refreshing` is true only when another visitor's rewrite is still running after the wait. */
export type Summary = { summary: string | null; summaryAt: string | null; refreshing: boolean };

const plannedColumn = { client: "client_id", person: "person_id", organization: "organization_id" } as const;

async function readSummary(entity: SummaryEntity, id: string) {
  const db = await getDb();
  const t = tables[entity];
  const [row] = await db
    .select({
      summary: t.summary,
      summaryAt: t.summaryAt,
      summaryStartedAt: t.summaryStartedAt,
      updatedAt: t.updatedAt,
      lastActivityAt: t.lastActivityAt,
      // Planned work on it that came due since the snapshot was written: "upcoming" became "overdue".
      cameDue: sql<boolean>`exists (select 1 from activities a where a.${sql.raw(plannedColumn[entity])} = ${t.id} and a.completed_at is null and a.due_at is not null and a.due_at > ${t.summaryAt} and a.due_at <= now())`,
      // Anything logged on it added or changed since: a task planned or moved, a meeting booked, a note edited.
      workChanged: sql<boolean>`exists (select 1 from activities a where a.${sql.raw(plannedColumn[entity])} = ${t.id} and a.updated_at > ${t.summaryAt})`,
    })
    .from(t)
    .where(eq(t.id, id));
  return row ?? null;
}

/**
 * The record's snapshot, rewritten first when it's missing, or more than a
 * day old with something new on the record, or a week old (`summaryDue`),
 * or whenever a teammate asks for a fresh one (`refresh`).
 * If someone else is already rewriting it, waits for theirs.
 */
export async function ensureSummary(entity: SummaryEntity, id: string, opts: { refresh?: boolean } = {}): Promise<Summary> {
  const current = await readSummary(entity, id);
  if (!current) return { summary: null, summaryAt: null, refreshing: false };
  const shown = { summary: current.summary, summaryAt: current.summaryAt?.toISOString() ?? null };
  if (!opts.refresh && !summaryDue(current)) return { ...shown, refreshing: false };

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
  const since = new Intl.DateTimeFormat("en-US", { timeZone: ws.timezone, month: "long", day: "numeric" }).format(new Date(Date.now() - 30 * 24 * 3600_000));
  const record = await recordContext(entity, id);
  const { text } = await generateText({
    model: aiGateway(appConfig.agent.summaryModel),
    reasoning: appConfig.agent.summaryReasoning,
    system: summaryInstructions(entity, today, since),
    prompt: record,
    // Reasoning counts toward this; the answer itself is a few sentences.
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
  /** Labels with what the team means by each, so the summary can use the meaning and not just the word. */
  const labeled = (names: string[]) =>
    names
      .map((n) => {
        const meaning = app.labels.find((l) => l.name === n)?.description?.replace(/\s+/g, " ").trim();
        return meaning ? `${n} (${meaning})` : n;
      })
      .join("; ");
  const line = (label: string, value: unknown) => (value === null || value === undefined || value === "" ? null : `${label}: ${value}`);
  const sections: string[] = [];
  let scope: SQL | undefined;
  /** Who matters to the account, marked on their activity so the summary can lead with them. */
  const roles = new Map<string, string>();
  const markRoles = (list: { id: string; decisionMaker: boolean }[], contactId?: string | null) => {
    for (const p of list) if (p.decisionMaker) roles.set(p.id, "decision maker");
    if (contactId) roles.set(contactId, roles.has(contactId) ? "main contact, decision maker" : "main contact");
  };
  const roleOf = (p: { id: string }) => (roles.get(p.id) ? ` (${roles.get(p.id)})` : "");

  if (entity === "client") {
    const row = await getClient(id);
    if (!row) throw new Error("Client not found.");
    const { client, person, organization } = row;
    const stage = app.pipelines.flatMap((p) => p.stages.map((s) => ({ ...s, pipeline: p.name }))).find((s) => s.id === client.stageId);
    // Its people: the contact, the people added to it and everyone at the organizations it's tied to (its main one and any kept from a merge).
    const [metrics, accountPeople, otherOrgs] = await Promise.all([metricsOf(id), clientPeople(client).then((rows) => rows.map((r) => r.person)), otherOrganizationsOfClient(id)]);
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
        line("Labels", labeled(client.tags)),
        line("Labels carried from the organization", labeled((organization?.tags ?? []).filter((t) => !client.tags.includes(t)))),
        line("Other fields", custom(client.custom)),
        line("Main contact", person ? `${personName(person)}${person.title ? `, ${person.title}` : ""}${person.email ? ` <${person.email}>` : ""}` : null),
        line("Organization", organization?.name),
        line("Also tied to", otherOrgs.map((o) => o.name).join(", ")),
      ]
        .filter(Boolean)
        .join("\n"),
    );
    // What they're subscribed to in Stripe, with what the team says each product delivers (Settings → Services).
    if (client.stripeProducts.length) {
      const describe = productDescriber(app.products);
      sections.push(["## Services (their Stripe products)", ...client.stripeProducts.map((name) => `${name}${describe(name) ? `: ${describe(name)!.replace(/\s+/g, " ").slice(0, 500)}` : ""}`)].join("\n"));
    }
    if (metrics.length) {
      // How each number has gone over time, not just where it is now: the last six readings, oldest first.
      const byLabel = new Map<string, (typeof metrics)[number][]>();
      for (const m of metrics) byLabel.set(m.label, [...(byLabel.get(m.label) ?? []), m]);
      sections.push(["## Performance over time", ...[...byLabel].map(([label, list]) => `${label}: ${list.slice(-6).map((m) => `${m.value} (${d(m.period)})`).join(", ")}`)].join("\n"));
    }
    sections.push(await billingSection(await customersOfClient(id), d, client));
    const peopleIds = [...new Set([client.personId, ...accountPeople.map((p) => p.id)].filter((x): x is string => !!x))].slice(0, MAX_PEOPLE);
    markRoles([...(person ? [person] : []), ...accountPeople], client.personId);
    if (accountPeople.length) sections.push(["## People at the account", ...accountPeople.slice(0, MAX_PEOPLE).map((p) => `${personName(p)}${p.title ? `, ${p.title}` : ""}${roleOf(p)}`)].join("\n"));
    scope = or(eq(a.clientId, id), peopleIds.length ? inArray(a.personId, peopleIds) : undefined, sql`${a.organizationId} in ${organizationsOfClient(id)}`);
  } else if (entity === "organization") {
    const org = await getOrganization(id);
    if (!org) throw new Error("Organization not found.");
    const [people, clients] = await Promise.all([peopleOf(id), clientsOfOrganization(id)]);
    const stripeIds = stripeConfigured() ? (await Promise.all(clients.slice(0, 3).map((c) => customersOfClient(c.id)))).flat() : [];
    sections.push(
      ["## Organization", line("Name", org.name), line("Website", org.domain), line("Industry", org.industry), line("Labels", labeled(org.tags)), line("Owner", member(org.ownerId)), line("Other fields", custom(org.custom))].filter(Boolean).join("\n"),
    );
    if (clients.length) sections.push(["## Clients", ...clients.map((c) => `${c.name}: ${c.category}, ${c.stageName}${c.mrr ? `, ${money(Number(c.mrr))}/mo` : c.value && c.category === "prospective" ? `, potential ${money(c.value)}` : ""}`)].join("\n"));
    markRoles(people);
    if (people.length) sections.push(["## People", ...people.slice(0, MAX_PEOPLE).map((p) => `${personName(p)}${p.title ? `, ${p.title}` : ""}${roleOf(p)}`)].join("\n"));
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
        line("Labels", labeled(p.tags)),
        line("Labels carried from the organization", labeled((org?.tags ?? []).filter((t) => !p.tags.includes(t)))),
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

  sections.push(await activitySection(scope, d, member, roles));
  return sections.filter(Boolean).join("\n\n");
}

/** Notes, calls, emails, texts, meetings and tasks: what's planned, then what happened, newest first. Campaign emails are left out. */
async function activitySection(scope: SQL | undefined, d: (x: Date | null) => string | null, member: (id: string | null) => string | null, roles: Map<string, string>) {
  const db = await getDb();
  const notCampaign = sql`not exists (select 1 from outbound_emails oe where oe.id = ${a.emailId} and oe.campaign_id is not null)`;
  const cols = {
    type: a.type,
    subject: a.subject,
    body: a.body,
    /** Replies under a note, oldest first: teammates' answers and the agent's. */
    replies: sql<{ body: string; userId: string | null }[]>`(select coalesce(json_agg(json_build_object('body', r.body, 'userId', r.user_id) order by r.created_at, r.id), '[]'::json) from note_replies r where r.activity_id = ${a.id})`,
    direction: a.direction,
    outcome: a.outcome,
    occurredAt: a.occurredAt,
    dueAt: a.dueAt,
    completedAt: a.completedAt,
    createdAt: a.createdAt,
    userId: a.userId,
    assigneeId: a.assigneeId,
    clientName: schema.clients.name,
    personId: a.personId,
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
  // A long history is cut at the newest 60: what came before still counts, so the notes, meetings and calls before them go in briefly.
  const when = sql`coalesce(${a.occurredAt}, ${a.completedAt}, ${a.createdAt})`;
  const oldest = history.length === MAX_HISTORY ? history[history.length - 1] : null;
  const earlier = oldest
    ? await base()
        .where(and(scope, inArray(a.type, ["note", "meeting", "call"]), or(sql`${a.completedAt} is not null`, sql`${a.dueAt} is null`), lt(when, oldest.occurredAt ?? oldest.completedAt ?? oldest.createdAt)))
        .orderBy(desc(when))
        .limit(MAX_EARLIER)
    : [];
  // The client it's on, or the person; with the person's part in the account (main contact, decision maker) when they have one.
  const about = (r: (typeof planned)[number]) => {
    const role = r.personId ? roles.get(r.personId) : undefined;
    const who = r.firstName ? `${personName({ firstName: r.firstName, lastName: r.lastName })}${role ? `, ${role}` : ""}` : null;
    return r.clientName ? (role && who ? `${r.clientName} · ${who}` : r.clientName) : who;
  };
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
      text: [htmlToText(r.body), ...(r.replies ?? []).map((y) => `Reply from ${member(y.userId) ?? "someone"}: ${htmlToText(y.body)}`)].filter(Boolean).join(" "),
      about: about(r),
    }),
  );
  const earlierLines = earlier.map((r) =>
    activityLine(
      {
        when: d(r.occurredAt ?? r.completedAt ?? r.createdAt) ?? "",
        type: r.type,
        status: "",
        direction: r.direction,
        outcome: r.outcome,
        by: member(r.userId) ?? (r.direction === "inbound" ? "them" : null),
        subject: r.subject,
        text: htmlToText(r.body),
        about: about(r),
      },
      300,
    ),
  );
  return [
    "## Planned (open tasks, calls and meetings)",
    ...(plannedLines.length ? plannedLines : ["Nothing planned."]),
    "",
    `## History (newest first${history.length === MAX_HISTORY ? `, latest ${MAX_HISTORY}` : ""})`,
    ...(historyLines.length ? historyLines : ["No activity logged yet."]),
    ...(earlierLines.length ? ["", "## Earlier notes, meetings and calls (before the history above, newest first)", ...earlierLines] : []),
  ].join("\n");
}

/**
 * What Stripe says, briefly, from the daily copy (stripe_customers,
 * stripe_subscriptions) and the client's rolled-up billing columns, never a
 * live call: subscriptions, what's owed and overdue, delinquency. A summary is
 * two sentences; the billing card on the page reads Stripe live for detail.
 */
async function billingSection(customers: { account: string; customerId: string }[], d: (x: Date | null) => string | null, client?: { stripeStatus: BillingStatus | null; stripeMrr: number | null; stripeOwed: number | null; stripeCollected: number | null; currency?: string | null }) {
  if (!stripeConfigured()) return "";
  const lines: string[] = [];
  const cur = (n: number, c: string | null | undefined) => formatMoney(n, (c ?? client?.currency ?? "usd").toUpperCase());
  if (client?.stripeStatus) {
    const parts = [`Billing: ${billingStatusLabels[client.stripeStatus].toLowerCase()}`];
    if (client.stripeMrr) parts.push(`${cur(client.stripeMrr, null)}/mo`);
    if (client.stripeOwed) parts.push(`${cur(client.stripeOwed, null)} owed`);
    if (client.stripeCollected) parts.push(`${cur(client.stripeCollected, null)} collected in the last year`);
    lines.push(parts.join(", "));
  }
  const picked = customers.slice(0, 4);
  if (picked.length) {
    const db = await getDb();
    const sc = schema.stripeCustomers;
    const ss = schema.stripeSubscriptions;
    const pairs = sql.join(picked.map((c) => sql`(${c.account}, ${c.customerId})`), sql`, `);
    const [rows, subs] = await Promise.all([
      db.select().from(sc).where(sql`(${sc.account}, ${sc.customerId}) in (${pairs})`),
      db.select().from(ss).where(and(sql`(${ss.account}, ${ss.customerId}) in (${pairs})`, isNull(ss.endedAt))),
    ]);
    const several = stripeAccounts().length > 1 || rows.length > 1;
    for (const c of rows) {
      if (several) lines.push(`Customer ${c.name ?? c.email ?? c.customerId}${stripeAccounts().length > 1 ? ` (${c.account})` : ""}:`);
      if (c.delinquent) lines.push("Stripe marks this customer as delinquent (a payment failed).");
      if (c.balance) lines.push(`Account balance: ${cur(c.balance, c.currency)}`);
      for (const s of subs.filter((x) => x.account === c.account && x.customerId === c.customerId && x.status !== "incomplete_expired").slice(0, 5)) {
        const items = s.items.map((i) => i.name).join(", ");
        const end = s.periodEnd ? d(s.periodEnd) : null;
        lines.push(`Subscription ${s.status}: ${items}${s.net ? `, ${cur(s.net, s.currency)}/mo` : ""}${s.cancelAtPeriodEnd && end ? `, cancels ${end}` : end && s.status === "active" ? `, renews ${end}` : ""}`);
      }
      if (c.owed) lines.push(`Unpaid invoices: ${cur(c.owed, c.currency)}${c.overdue ? `, ${c.overdue} overdue` : ""}`);
      if (c.lastPaidAt) lines.push(`Last paid ${d(c.lastPaidAt)}`);
    }
  }
  return lines.length ? ["## Billing (Stripe)", ...lines].join("\n") : "";
}
