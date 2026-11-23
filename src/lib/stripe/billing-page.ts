import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { stripeAccounts } from "@/lib/stripe";
import { clientCustomers } from "@/lib/stripe/sync";
import type { ActivityFilter, ActivityRow, ActivitySort, ActivityState, ActivityTotals, MappedClient, MappingFilter, MappingRow, MappingSort } from "./activity";

/**
 * What the Billing page reads: every invoice and payment the sync copied
 * (`stripe_activity`), each with the clients its customer belongs to, and
 * the customers themselves for mapping. A customer belongs to a client the
 * same way everywhere (`clientCustomers`): matched by email or linked by
 * hand, minus matches marked as not theirs. Archived clients don't count, so
 * a customer only they had shows as not mapped.
 */

export const billingPageSize = 100;

const rowsOf = <T>(r: unknown) => ((r as { rows?: T[] }).rows ?? (r as T[])) as T[];
const n = (v: string | number | null | undefined) => Number(v ?? 0);
const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);

/** Only accounts that are connected now: one whose key was removed keeps its copy, but isn't shown. */
function connected(col: SQL) {
  const ids = stripeAccounts().map((a) => a.id);
  return ids.length ? sql`${col} in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})` : sql`false`;
}

/** Each customer's clients, as JSON: `[{ id, name, byHand, email }]`, by name. */
const mappedClients = () => sql`(
  select m.account, m.customer_id,
    jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'byHand', m.by_hand, 'email', m.matched_email) order by c.name, c.id) as clients
  from ${clientCustomers()} m join clients c on c.id = m.client_id and c.archived_at is null
  group by m.account, m.customer_id
)`;

/** Mirrors `activityState` in src/lib/stripe/activity.ts, so the table can filter and sort on it. */
const stateSql = sql`case
  when a.kind = 'invoice' then
    case when a.status = 'open' then (case when a.due_at < now() then 'overdue' else 'unpaid' end)
         when a.status in ('void', 'uncollectible') then a.status
         else 'paid' end
  else
    case when a.status in ('failed', 'pending') then a.status
         when a.status = 'uncaptured' then 'pending'
         when a.refunded > 0 and a.refunded >= a.amount then 'refunded'
         when a.refunded > 0 then 'partly_refunded'
         else 'succeeded' end
end`;

/** Every row with its customer, clients and state, before the filters. */
const activityBase = () => sql`(
  select a.account, a.id, a.kind, a.status, a.customer_id, a.amount, a.refunded, a.remaining, a.currency, a.created_at, a.due_at,
    a.number, a.description, a.method, a.failure, a.url, a.pdf,
    sc.name as customer_name, sc.email as customer_email,
    coalesce(mc.clients, '[]'::jsonb) as clients,
    ${stateSql} as state
  from stripe_activity a
  left join stripe_customers sc on sc.account = a.account and sc.customer_id = a.customer_id
  left join ${mappedClients()} mc on mc.account = a.account and mc.customer_id = a.customer_id
  where ${connected(sql`a.account`)}
)`;

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const clientNamed = (q: string) => sql`exists (select 1 from jsonb_array_elements(x.clients) j where j ->> 'name' ilike ${like(q)})`;

function activityWhere(f: ActivityFilter): SQL {
  const parts: SQL[] = [sql`true`];
  const q = f.q?.trim();
  if (q)
    parts.push(
      sql`(x.customer_name ilike ${like(q)} or x.customer_email ilike ${like(q)} or x.number ilike ${like(q)} or x.description ilike ${like(q)} or x.id = ${q} or x.customer_id = ${q} or ${clientNamed(q)})`,
    );
  if (f.kind) parts.push(sql`x.kind = ${f.kind}`);
  if (f.state) parts.push(sql`x.state = ${f.state}`);
  // A payment taken without a customer can't be mapped, so it's neither.
  if (f.mapped === "unmapped") parts.push(sql`x.clients = '[]'::jsonb and x.customer_id is not null`);
  if (f.mapped === "mapped") parts.push(sql`x.clients <> '[]'::jsonb`);
  if (f.account) parts.push(sql`x.account = ${f.account}`);
  if (f.from) parts.push(sql`x.created_at >= ${f.from}::date`);
  if (f.to) parts.push(sql`x.created_at < (${f.to}::date + 1)`);
  return sql.join(parts, sql` and `);
}

/** Numbers and dates start biggest and newest first; names start at A. */
const descFirst: ActivitySort[] = ["date", "amount"];

function activityOrder(f: ActivityFilter): SQL {
  const sort = f.sort ?? "date";
  const dir = f.dir ?? (descFirst.includes(sort) ? "desc" : "asc");
  const d = dir === "asc" ? sql`asc` : sql`desc`;
  const key: Record<ActivitySort, SQL> = {
    date: sql`x.created_at`,
    amount: sql`x.amount`,
    customer: sql`lower(coalesce(x.customer_name, x.customer_email, x.customer_id))`,
    client: sql`lower(x.clients -> 0 ->> 'name')`,
    state: sql`x.state`,
    kind: sql`x.kind`,
    account: sql`x.account`,
  };
  return sql`${key[sort]} ${d} nulls last, x.created_at desc, x.id`;
}

type ActivitySqlRow = {
  account: string;
  id: string;
  kind: "invoice" | "payment";
  state: ActivityState;
  customer_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  clients: MappedClient[] | string;
  amount: string | number;
  refunded: string | number;
  remaining: string | number;
  currency: string;
  created_at: Date | string;
  due_at: Date | string | null;
  number: string | null;
  description: string | null;
  method: string | null;
  failure: string | null;
  url: string | null;
  pdf: string | null;
};

const clientsOf = (v: MappedClient[] | string | null): MappedClient[] => (typeof v === "string" ? JSON.parse(v) : (v ?? []));

/** A page of invoices and payments, with the filters and sort from the URL. */
export async function listBillingActivity(f: ActivityFilter, range: { offset?: number; limit?: number } = {}): Promise<ActivityRow[]> {
  const db = await getDb();
  const rows = rowsOf<ActivitySqlRow>(
    await db.execute(sql`
      select x.* from ${activityBase()} x
      where ${activityWhere(f)}
      order by ${activityOrder(f)}
      limit ${range.limit ?? billingPageSize} offset ${range.offset ?? 0}
    `),
  );
  return rows.map((r) => ({
    account: r.account,
    id: r.id,
    kind: r.kind,
    state: r.state,
    customerId: r.customer_id,
    customerName: r.customer_name,
    customerEmail: r.customer_email,
    clients: clientsOf(r.clients),
    amount: n(r.amount),
    refunded: n(r.refunded),
    remaining: n(r.remaining),
    currency: r.currency,
    createdAt: iso(r.created_at)!,
    dueAt: iso(r.due_at),
    number: r.number,
    description: r.description,
    method: r.method,
    failure: r.failure,
    url: r.url,
    pdf: r.pdf,
  }));
}

/** How many rows the filters show, what they add up to, and how much of it no client has. */
export async function billingActivityTotals(f: ActivityFilter): Promise<ActivityTotals> {
  const db = await getDb();
  const [overall, byCurrency] = await Promise.all([
    db.execute(sql`
      select count(*) as rows,
        count(*) filter (where x.clients = '[]'::jsonb and x.customer_id is not null) as unmapped_rows,
        count(distinct x.account || ':' || x.customer_id) filter (where x.clients = '[]'::jsonb and x.customer_id is not null) as unmapped_customers
      from ${activityBase()} x where ${activityWhere(f)}
    `),
    db.execute(sql`
      select x.currency,
        coalesce(sum(x.amount - x.refunded) filter (where x.kind = 'payment' and x.state in ('succeeded', 'partly_refunded')), 0) as collected,
        coalesce(sum(x.amount) filter (where x.kind = 'invoice' and x.state <> 'void'), 0) as invoiced,
        coalesce(sum(x.remaining) filter (where x.kind = 'invoice' and x.state in ('unpaid', 'overdue')), 0) as outstanding
      from ${activityBase()} x where ${activityWhere(f)}
      group by x.currency
    `),
  ]);
  const o = rowsOf<{ rows: string | number; unmapped_rows: string | number; unmapped_customers: string | number }>(overall)[0];
  const out: ActivityTotals = { rows: n(o?.rows), unmappedRows: n(o?.unmapped_rows), unmappedCustomers: n(o?.unmapped_customers), collected: {}, invoiced: {}, outstanding: {} };
  for (const r of rowsOf<{ currency: string; collected: string | number; invoiced: string | number; outstanding: string | number }>(byCurrency)) {
    if (n(r.collected)) out.collected[r.currency] = n(r.collected);
    if (n(r.invoiced)) out.invoiced[r.currency] = n(r.invoiced);
    if (n(r.outstanding)) out.outstanding[r.currency] = n(r.outstanding);
  }
  return out;
}

// ─── Customers, for mapping ──────────────────────────────────────────────

const mappingBase = () => sql`(
  select sc.account, sc.customer_id, sc.name, sc.email, sc.collected_year, sc.currency,
    coalesce(mc.clients, '[]'::jsonb) as clients,
    coalesce(act.n, 0) as activity, act.last_at
  from stripe_customers sc
  left join ${mappedClients()} mc on mc.account = sc.account and mc.customer_id = sc.customer_id
  left join (select account, customer_id, count(*) as n, max(created_at) as last_at from stripe_activity group by account, customer_id) act
    on act.account = sc.account and act.customer_id = sc.customer_id
  where ${connected(sql`sc.account`)}
)`;

function mappingWhere(f: MappingFilter): SQL {
  const parts: SQL[] = [sql`true`];
  const q = f.q?.trim();
  if (q) parts.push(sql`(x.name ilike ${like(q)} or x.email ilike ${like(q)} or x.customer_id = ${q} or ${clientNamed(q)})`);
  if (f.mapped === "unmapped") parts.push(sql`x.clients = '[]'::jsonb`);
  if (f.mapped === "mapped") parts.push(sql`x.clients <> '[]'::jsonb`);
  if (f.mapped === "by_hand") parts.push(sql`exists (select 1 from jsonb_array_elements(x.clients) j where (j ->> 'byHand')::boolean)`);
  if (f.account) parts.push(sql`x.account = ${f.account}`);
  return sql.join(parts, sql` and `);
}

function mappingOrder(f: MappingFilter): SQL {
  // Customers with the most going on come first, so the ones worth mapping are at the top.
  const sort: MappingSort = f.sort ?? "last";
  const dir = f.dir ?? (["activity", "collected", "last"].includes(sort) ? "desc" : "asc");
  const d = dir === "asc" ? sql`asc` : sql`desc`;
  const key: Record<MappingSort, SQL> = {
    customer: sql`lower(coalesce(x.name, x.email, x.customer_id))`,
    email: sql`lower(x.email)`,
    client: sql`lower(x.clients -> 0 ->> 'name')`,
    activity: sql`x.activity`,
    collected: sql`x.collected_year`,
    last: sql`x.last_at`,
  };
  return sql`${key[sort]} ${d} nulls last, lower(coalesce(x.name, x.email, x.customer_id)), x.customer_id`;
}

export async function listStripeCustomers(f: MappingFilter, range: { offset?: number; limit?: number } = {}): Promise<MappingRow[]> {
  const db = await getDb();
  const rows = rowsOf<{ account: string; customer_id: string; name: string | null; email: string | null; collected_year: string | number; currency: string | null; clients: MappedClient[] | string; activity: string | number; last_at: Date | string | null }>(
    await db.execute(sql`
      select x.* from ${mappingBase()} x
      where ${mappingWhere(f)}
      order by ${mappingOrder(f)}
      limit ${range.limit ?? billingPageSize} offset ${range.offset ?? 0}
    `),
  );
  return rows.map((r) => ({
    account: r.account,
    customerId: r.customer_id,
    name: r.name,
    email: r.email,
    clients: clientsOf(r.clients),
    activity: n(r.activity),
    collectedYear: n(r.collected_year),
    currency: r.currency,
    lastAt: iso(r.last_at),
  }));
}

export async function countStripeCustomers(f: MappingFilter) {
  const db = await getDb();
  const [r] = rowsOf<{ n: string | number }>(await db.execute(sql`select count(*) as n from ${mappingBase()} x where ${mappingWhere(f)}`));
  return n(r?.n);
}

/**
 * When the daily sync last copied every connected account, for the page to
 * say how fresh it is. A full run removes each customer it didn't see, so the
 * oldest customer's stamp is when it ran; a single client looked up since only
 * moves some of them forward. The least fresh account counts.
 */
export async function lastStripeSync() {
  const db = await getDb();
  const [r] = rowsOf<{ at: Date | string | null }>(await db.execute(sql`select min(at) as at from (select min(synced_at) as at from stripe_customers where ${connected(sql`account`)} group by account) s`));
  return iso(r?.at ?? null);
}
