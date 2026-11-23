import "server-only";
import { asc, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";

/**
 * What each Stripe product means to the team, set in Settings → Services.
 * Services aren't tracked by hand any more: what a client has is what Stripe
 * bills them for (`clients.stripe_products`), and this says what each
 * product delivers. Keyed by the product's name, matched without regard to
 * case (`productKey`).
 */

const rowsOf = <T>(r: unknown) => ((r as { rows?: T[] }).rows ?? (r as T[])) as T[];

export type ProductDescription = { name: string; description: string };

export async function listProductDescriptions(): Promise<ProductDescription[]> {
  const db = await getDb();
  const t = schema.productDescriptions;
  return db.select({ name: t.name, description: t.description }).from(t).orderBy(asc(sql`lower(${t.name})`));
}

/**
 * Every product name in the connected Stripe accounts' subscriptions,
 * canceled ones included, with how many clients are on it now. These are
 * the names Settings → Services offers to describe.
 */
export async function stripeProductUsage() {
  const db = await getDb();
  const rows = rowsOf<{ name: string; clients: number }>(
    await db.execute(sql`
      with seen as (
        select distinct i ->> 'name' as name from stripe_subscriptions s cross join lateral jsonb_array_elements(s.items) i where coalesce(i ->> 'name', '') <> ''
      ),
      now as (
        select p as name, count(*)::int as clients from clients c cross join lateral jsonb_array_elements_text(c.stripe_products) p where c.archived_at is null group by p
      )
      select coalesce(seen.name, now.name) as name, coalesce(now.clients, 0)::int as clients
      from seen full join now on now.name = seen.name
      order by lower(coalesce(seen.name, now.name))
    `),
  );
  return rows;
}
