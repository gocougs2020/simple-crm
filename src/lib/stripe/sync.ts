import "server-only";
import { and, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { recordEvent } from "@/lib/crm/events";
import { allCustomers, allSubscriptions, chargesSince, customersByEmail, invoicesSince, openInvoices, productNames, stripeAccounts, stripeConfigured, subscriptionsOf, type StripeCharge, type StripeCustomer, type StripeInvoice, type StripeSubscription } from "@/lib/stripe";
import { chargeActivity, invoiceActivity, type ActivityRecord } from "./activity";
import { collected, discountShare, liveStatuses, monthlyAmount, netMonthly } from "./rules";

/**
 * Stripe is the source of truth for billing; this keeps a copy the CRM can
 * join against.
 *
 * - `syncStripe` (the daily cron) lists every customer, subscription and
 *   product in each connected account: a few dozen requests however many
 *   clients there are, instead of a lookup per email.
 * - It also copies invoices and payments into `stripe_activity` for the
 *   Billing page: the last year each run, all of history the first time.
 * - A client's customers are found by email: any customer whose email is one
 *   of the client's people's (its contact, people added to it, everyone at
 *   its organization), plus customers linked by hand, minus matches someone
 *   marked as not theirs. Nothing is stored per match, so adding a person or
 *   an email to a client changes its billing with nothing to re-link.
 * - `refreshClientBilling` rolls the matched subscriptions up onto the
 *   client (`stripe_status`, `stripe_mrr`, `stripe_products`) so lists can
 *   filter and sort on them, and writes history when the status changes.
 * - `syncClient` does the same for one client straight from Stripe, for a
 *   page opened before the next daily run.
 */

const { stripeActivity, stripeCustomers, stripeSubscriptions } = schema;

const rowsOf = <T>(r: unknown) => ((r as { rows?: T[] }).rows ?? (r as T[])) as T[];
const at = (unix: number | null | undefined) => (unix ? new Date(unix * 1000) : null);

/** What a customer paid and still owes, added up from their payments and open invoices. */
type Money = { collectedMonth: number; collectedYear: number; lastPaidAt: Date | null; owed: number; overdue: number };

const DAY = 86_400;

/** Adds up a year of payments and the open invoices, per customer. */
function moneyByCustomer(charges: StripeCharge[], invoices: StripeInvoice[], now: Date) {
  const out = new Map<string, Money>();
  const of = (id: string) => out.get(id) ?? out.set(id, { collectedMonth: 0, collectedYear: 0, lastPaidAt: null, owed: 0, overdue: 0 }).get(id)!;
  const t = Math.floor(now.getTime() / 1000);
  for (const c of charges) {
    const got = collected(c);
    if (!c.customer || !got || c.created < t - 365 * DAY) continue;
    const m = of(c.customer);
    m.collectedYear += got;
    if (c.created >= t - 30 * DAY) m.collectedMonth += got;
    if (!m.lastPaidAt || c.created * 1000 > m.lastPaidAt.getTime()) m.lastPaidAt = new Date(c.created * 1000);
  }
  for (const i of invoices) {
    if (!i.customer || i.status !== "open") continue;
    const m = of(i.customer);
    m.owed += i.amount_remaining;
    if (i.due_date && i.due_date < t) m.overdue += 1;
  }
  return out;
}

const noMoney: Money = { collectedMonth: 0, collectedYear: 0, lastPaidAt: null, owed: 0, overdue: 0 };

/** Saves customers. With `money`, what each paid and owes is saved too (a customer missing from it paid and owes nothing); without, those stay as they were. */
async function saveCustomers(account: string, list: StripeCustomer[], now: Date, money?: Map<string, Money>) {
  const db = await getDb();
  for (let i = 0; i < list.length; i += 500) {
    const values = list.slice(i, i + 500).map((c) => ({
      account,
      customerId: c.id,
      email: c.email?.trim().toLowerCase() || null,
      name: c.name,
      balance: c.balance ?? 0,
      currency: c.currency,
      delinquent: !!c.delinquent,
      customerSince: at(c.created),
      syncedAt: now,
      ...(money ? (money.get(c.id) ?? noMoney) : {}),
    }));
    await db
      .insert(stripeCustomers)
      .values(values)
      .onConflictDoUpdate({
        target: [stripeCustomers.account, stripeCustomers.customerId],
        set: {
          email: sql`excluded.email`,
          name: sql`excluded.name`,
          balance: sql`excluded.balance`,
          currency: sql`excluded.currency`,
          delinquent: sql`excluded.delinquent`,
          customerSince: sql`excluded.customer_since`,
          syncedAt: sql`excluded.synced_at`,
          ...(money ? { collectedMonth: sql`excluded.collected_month`, collectedYear: sql`excluded.collected_year`, lastPaidAt: sql`excluded.last_paid_at`, owed: sql`excluded.owed`, overdue: sql`excluded.overdue` } : {}),
        },
      });
  }
}

/** Keeps one customer just read from Stripe, so a link made by hand shows before the next sync. */
export const rememberCustomer = (account: string, customer: StripeCustomer) => saveCustomers(account, [customer], new Date());

async function saveSubscriptions(account: string, list: StripeSubscription[], names: Map<string, string>, now: Date) {
  const db = await getDb();
  for (let i = 0; i < list.length; i += 500) {
    const values = list.slice(i, i + 500).map((s) => ({
      account,
      subscriptionId: s.id,
      customerId: s.customer,
      status: s.status,
      currency: s.currency,
      monthly: monthlyAmount(s.items.data),
      net: netMonthly(monthlyAmount(s.items.data), discountShare(typeof s.latest_invoice === "object" ? s.latest_invoice : null)),
      items: s.items.data.map((it) => ({
        product: it.price.product,
        name: names.get(it.price.product) ?? it.price.nickname ?? "Subscription",
        amount: it.price.unit_amount,
        quantity: it.quantity ?? 1,
        interval: it.price.recurring?.interval ?? null,
        intervalCount: it.price.recurring?.interval_count ?? null,
      })),
      cancelAtPeriodEnd: s.cancel_at_period_end,
      startedAt: at(s.start_date ?? s.created),
      periodEnd: at(s.current_period_end ?? s.items.data.map((it) => it.current_period_end).find(Boolean)),
      endedAt: at(s.ended_at),
      syncedAt: now,
    }));
    await db
      .insert(stripeSubscriptions)
      .values(values)
      .onConflictDoUpdate({
        target: [stripeSubscriptions.account, stripeSubscriptions.subscriptionId],
        set: {
          customerId: sql`excluded.customer_id`,
          status: sql`excluded.status`,
          currency: sql`excluded.currency`,
          monthly: sql`excluded.monthly`,
          net: sql`excluded.net`,
          items: sql`excluded.items`,
          cancelAtPeriodEnd: sql`excluded.cancel_at_period_end`,
          startedAt: sql`excluded.started_at`,
          periodEnd: sql`excluded.period_end`,
          endedAt: sql`excluded.ended_at`,
          syncedAt: sql`excluded.synced_at`,
        },
      });
  }
}

/** Saves invoices and payments for the Billing page. Each id once, so a payment listed twice can't break the batch. */
async function saveActivity(account: string, invoices: StripeInvoice[], charges: StripeCharge[], now: Date) {
  const rows = new Map<string, ActivityRecord>();
  for (const i of invoices) {
    const r = invoiceActivity(account, i);
    if (r) rows.set(r.id, r);
  }
  for (const c of charges) rows.set(c.id, chargeActivity(account, c));
  const list = [...rows.values()];
  if (!list.length) return;
  const db = await getDb();
  for (let i = 0; i < list.length; i += 500) {
    await db
      .insert(stripeActivity)
      .values(list.slice(i, i + 500).map((r) => ({ ...r, syncedAt: now })))
      .onConflictDoUpdate({
        target: [stripeActivity.account, stripeActivity.id],
        set: {
          customerId: sql`excluded.customer_id`,
          status: sql`excluded.status`,
          amount: sql`excluded.amount`,
          refunded: sql`excluded.refunded`,
          remaining: sql`excluded.remaining`,
          currency: sql`excluded.currency`,
          dueAt: sql`excluded.due_at`,
          number: sql`excluded.number`,
          description: sql`excluded.description`,
          method: sql`excluded.method`,
          failure: sql`excluded.failure`,
          url: sql`excluded.url`,
          pdf: sql`excluded.pdf`,
          invoiceId: sql`excluded.invoice_id`,
          syncedAt: sql`excluded.synced_at`,
        },
      });
  }
}

/** Whether an account's invoices and payments were ever copied: the first run copies all of history, later ones the last year. */
async function hasActivity(account: string) {
  const db = await getDb();
  const [row] = await db.select({ id: stripeActivity.id }).from(stripeActivity).where(eq(stripeActivity.account, account)).limit(1);
  return !!row;
}

/** Copies every connected account, then rolls the result up onto clients. An account that fails keeps its last copy and is reported. */
export async function syncStripe() {
  const db = await getDb();
  const report: { account: string; customers?: number; subscriptions?: number; activity?: number; error?: string }[] = [];
  for (const { id: account } of stripeAccounts()) {
    const started = new Date();
    try {
      const since = Math.floor(started.getTime() / 1000) - 365 * DAY;
      // Invoices and payments: a year back each day, which covers anything paid, refunded or voided lately; everything the first time.
      const from = (await hasActivity(account)) ? since : undefined;
      const [names, customers, subscriptions, charges, unpaid, invoices] = await Promise.all([
        productNames(account),
        allCustomers(account),
        allSubscriptions(account),
        chargesSince(account, from ?? 0),
        openInvoices(account),
        invoicesSince(account, from),
      ]);
      await saveCustomers(account, customers, started, moneyByCustomer(charges, unpaid, started));
      await saveSubscriptions(account, subscriptions, names, started);
      await saveActivity(account, [...invoices, ...unpaid], charges, started);
      // Whatever this run didn't see was deleted in Stripe. Activity older than what was asked for is kept: it's history.
      await db.delete(stripeCustomers).where(and(eq(stripeCustomers.account, account), lt(stripeCustomers.syncedAt, started)));
      await db.delete(stripeSubscriptions).where(and(eq(stripeSubscriptions.account, account), lt(stripeSubscriptions.syncedAt, started)));
      await db.delete(stripeActivity).where(and(eq(stripeActivity.account, account), lt(stripeActivity.syncedAt, started), ...(from ? [gte(stripeActivity.createdAt, new Date(from * 1000))] : [])));
      report.push({ account, customers: customers.length, subscriptions: subscriptions.length, activity: invoices.length + charges.length });
    } catch (err) {
      console.error("[stripe] sync", account, (err as Error).message);
      report.push({ account, error: (err as Error).message });
    }
  }
  const changed = await refreshClientBilling(undefined, { fresh: report.every((r) => !r.error) });
  return { accounts: report, clientsChanged: changed };
}

/**
 * Every email a client can be matched on, lowercased: its contact's, the
 * people added to it and everyone at its organizations (its main one and any
 * kept from a merge), other emails included.
 * `only` narrows it to one client.
 */
function clientEmails(only?: string): SQL {
  const one = only ? sql`and c.id = ${only}` : sql``;
  const emails = sql`cross join lateral (select p.email as email union all select jsonb_array_elements_text(p.other_emails)) e`;
  const ok = sql`p.archived_at is null and coalesce(e.email, '') <> ''`;
  return sql`(
    select c.id as client_id, lower(e.email) as email from clients c join people p on p.id = c.person_id ${emails} where ${ok} ${one}
    union
    select c.id, lower(e.email) from clients c join client_people cp on cp.client_id = c.id join people p on p.id = cp.person_id ${emails} where ${ok} ${one}
    union
    select c.id, lower(e.email) from clients c join people p on p.organization_id = c.organization_id ${emails} where ${ok} ${one}
    union
    select c.id, lower(e.email) from clients c join person_organizations po on po.organization_id = c.organization_id join people p on p.id = po.person_id ${emails} where ${ok} ${one}
    union
    select c.id, lower(e.email) from clients c join client_organizations co on co.client_id = c.id join people p on p.organization_id = co.organization_id ${emails} where ${ok} ${one}
    union
    select c.id, lower(e.email) from clients c join client_organizations co on co.client_id = c.id join person_organizations po on po.organization_id = co.organization_id join people p on p.id = po.person_id ${emails} where ${ok} ${one}
  )`;
}

/** The Stripe customers that belong to each client: matched by email or linked by hand, minus the ones marked as not theirs. */
export function clientCustomers(only?: string): SQL {
  const one = only ? sql`and l.client_id = ${only}` : sql``;
  // Only accounts that are connected now: one whose key was removed keeps its copy, but stops counting.
  const ids = stripeAccounts().map((a) => a.id);
  const connected = (col: SQL) => (ids.length ? sql`${col} in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})` : sql`false`);
  return sql`(
    select ce.client_id, sc.account, sc.customer_id, min(ce.email) as matched_email, false as by_hand
    from ${clientEmails(only)} ce join stripe_customers sc on sc.email = ce.email
    where ${connected(sql`sc.account`)}
      and not exists (select 1 from client_stripe_links h where h.client_id = ce.client_id and h.account = sc.account and h.customer_id = sc.customer_id)
    group by ce.client_id, sc.account, sc.customer_id
    union all
    select l.client_id, l.account, l.customer_id, null, true from client_stripe_links l where l.kind = 'linked' and ${connected(sql`l.account`)} ${one}
  )`;
}

export type ClientCustomer = { account: string; customerId: string; matchedEmail: string | null; byHand: boolean; name: string | null; email: string | null; collectedMonth: number; collectedYear: number };

/** One client's Stripe customers, in connected accounts only. */
export async function customersOfClient(clientId: string): Promise<ClientCustomer[]> {
  if (!stripeConfigured()) return [];
  const db = await getDb();
  const rows = rowsOf<{ account: string; customer_id: string; matched_email: string | null; by_hand: boolean; name: string | null; email: string | null; collected_month: string | number | null; collected_year: string | number | null }>(
    await db.execute(sql`
      select m.account, m.customer_id, m.matched_email, m.by_hand, sc.name, sc.email, sc.collected_month, sc.collected_year
      from ${clientCustomers(clientId)} m left join stripe_customers sc on sc.account = m.account and sc.customer_id = m.customer_id
      order by m.account, sc.name nulls last, m.customer_id
    `),
  );
  return rows.map((r) => ({ account: r.account, customerId: r.customer_id, matchedEmail: r.matched_email, byHand: r.by_hand, name: r.name, email: r.email, collectedMonth: Number(r.collected_month ?? 0), collectedYear: Number(r.collected_year ?? 0) }));
}

/**
 * Rolls each client's matched subscriptions up onto the client, for one
 * client or all of them, and stamps when (unless told the data isn't fresh). A status
 * change is recorded in the client's history, except the first time a client
 * is seen, so connecting Stripe doesn't fill every timeline.
 */
export async function refreshClientBilling(only?: string, opts: { fresh?: boolean } = {}) {
  // `fresh: false` (Stripe didn't answer for an account) rolls up what's there without stamping it as up to date, so the next page view asks again.
  const stamp = opts.fresh === false ? sql`c.stripe_synced_at` : sql`now()`;
  const db = await getDb();
  const live = sql.join(liveStatuses.map((s) => sql`${s}`), sql`, `);
  const one = only ? sql`and c.id = ${only}` : sql`and c.archived_at is null`;
  const rows = rowsOf<{ id: string; before: string | null; after: string | null; seen: Date | null; changed: boolean }>(
    await db.execute(sql`
      with m as ${clientCustomers(only)},
      x as (
        select c.id as client_id,
          case
            when count(m.customer_id) = 0 then null
            when bool_or(s.status in ('past_due', 'unpaid')) then 'past_due'
            when bool_or(s.status = 'active') then 'active'
            when bool_or(s.status = 'trialing') then 'trialing'
            when bool_or(s.status = 'paused') then 'paused'
            when count(s.subscription_id) > 0 then 'canceled'
            else 'customer'
          end as status,
          coalesce(sum(s.net) filter (where s.status in (${live}) and s.status <> 'paused'), 0)::bigint as mrr,
          coalesce(sum(s.monthly - s.net) filter (where s.status in (${live}) and s.status <> 'paused'), 0)::bigint as discount,
          coalesce((select sum(sc.collected_year) from m m3 join stripe_customers sc on sc.account = m3.account and sc.customer_id = m3.customer_id where m3.client_id = c.id), 0)::bigint as collected,
          coalesce((select sum(sc.owed) from m m3 join stripe_customers sc on sc.account = m3.account and sc.customer_id = m3.customer_id where m3.client_id = c.id), 0)::bigint as owed,
          coalesce((select sum(greatest(-sc.balance, 0)) from m m3 join stripe_customers sc on sc.account = m3.account and sc.customer_id = m3.customer_id where m3.client_id = c.id), 0)::bigint as credit,
          coalesce((
            select jsonb_agg(distinct i ->> 'name' order by i ->> 'name')
            from m m2 join stripe_subscriptions s2 on s2.account = m2.account and s2.customer_id = m2.customer_id cross join lateral jsonb_array_elements(s2.items) i
            where m2.client_id = c.id and s2.status in (${live})
          ), '[]'::jsonb) as products
        from clients c
        left join m on m.client_id = c.id
        left join stripe_subscriptions s on s.account = m.account and s.customer_id = m.customer_id
        where true ${one}
        group by c.id
      )
      update clients c
      set stripe_status = x.status, stripe_mrr = x.mrr, stripe_discount = x.discount, stripe_collected = x.collected, stripe_owed = x.owed, stripe_credit = x.credit, stripe_products = x.products, stripe_synced_at = ${stamp}
      from x join clients o on o.id = x.client_id
      where c.id = x.client_id
      returning c.id, o.stripe_status as before, c.stripe_status as after, o.stripe_synced_at as seen,
        (o.stripe_status is distinct from x.status or o.stripe_mrr <> x.mrr or o.stripe_collected <> x.collected or o.stripe_owed <> x.owed or o.stripe_products <> x.products) as changed
    `),
  );
  for (const r of rows) {
    if (!r.seen || r.before === r.after) continue;
    await recordEvent({ entityType: "client", entityId: r.id, action: "billing_changed", data: { from: r.before, to: r.after }, userId: null });
  }
  return rows.filter((r) => r.changed).length;
}

/** At most this many of a client's emails are looked up when its page asks Stripe directly. */
const MAX_EMAILS = 60;

/**
 * One client, straight from Stripe: looks its people's emails up in every
 * account, refreshes those customers and their subscriptions, and rolls them
 * up. An account that fails is skipped, and the client isn't marked as up to
 * date, so its next page view tries again.
 */
export async function syncClient(clientId: string) {
  const db = await getDb();
  const emails = rowsOf<{ email: string }>(await db.execute(sql`select distinct email from ${clientEmails(clientId)} e limit ${MAX_EMAILS}`)).map((r) => r.email);
  const now = new Date();
  let fresh = true;
  await Promise.all(
    stripeAccounts().map(async ({ id: account }) => {
      try {
        const found = emails.length ? await customersByEmail(account, emails) : [];
        // Customers linked by hand, or matched by an earlier run, are refreshed too.
        const known = (await customersOfClient(clientId)).filter((c) => c.account === account).map((c) => c.customerId);
        const ids = [...new Set([...found.map((c) => c.id), ...known])].slice(0, 25);
        const since = Math.floor(now.getTime() / 1000) - 365 * DAY;
        const [subs, charges, unpaid] = await Promise.all([
          Promise.all(ids.map((id) => subscriptionsOf(account, id))).then((x) => x.flat()),
          Promise.all(ids.map((id) => chargesSince(account, since, id))).then((x) => x.flat()),
          Promise.all(ids.map((id) => openInvoices(account, id))).then((x) => x.flat()),
        ]);
        const money = moneyByCustomer(charges, unpaid, now);
        if (found.length) await saveCustomers(account, found, now, money);
        // Customers this run didn't read (linked by hand, or matched earlier) still get what they paid and owe.
        for (const id of known.filter((k) => !found.some((c) => c.id === k))) await db.update(stripeCustomers).set(money.get(id) ?? noMoney).where(and(eq(stripeCustomers.account, account), eq(stripeCustomers.customerId, id)));
        // The payments and open invoices just read show on the Billing page now, not after the next daily run.
        await saveActivity(account, unpaid, charges, now);
        if (subs.length) await saveSubscriptions(account, subs, await productNames(account, [...new Set(subs.flatMap((s) => s.items.data.map((i) => i.price.product)))]), now);
      } catch (err) {
        fresh = false;
        console.warn("[stripe] client sync", account, (err as Error).message);
      }
    }),
  );
  await refreshClientBilling(clientId, { fresh });
}
