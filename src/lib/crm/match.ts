import "server-only";
import { clientAtOrganization } from "@/lib/crm/client-organizations";
import { and, desc, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { matchKey } from "@/lib/phone/numbers";

/**
 * Who a message is about, from the other side's email addresses or phone
 * number. Inbox mail, synced mailboxes, calls and texts all link the same
 * way: a person first, else an organization (by website domain, or main phone
 * line), and the client tied to them, current clients first.
 */

const { people, organizations, clients } = schema;

export type Links = { personId: string | null; organizationId: string | null; clientId: string | null };

async function clientFor(personId: string | null, organizationId: string | null) {
  if (!personId && !organizationId) return null;
  const db = await getDb();
  // On a client as its contact or added to its people (a merged client's other contacts are), or at one of its organizations.
  const onClient = personId ? sql`(${clients.personId} = ${personId} or exists (select 1 from client_people cp where cp.client_id = ${clients.id} and cp.person_id = ${personId}))` : null;
  const match = onClient && organizationId ? sql`(${onClient} or ${clientAtOrganization(organizationId)})` : (onClient ?? clientAtOrganization(organizationId!));
  const [c] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(isNull(clients.archivedAt), match))
    .orderBy(sql`case ${clients.category} when 'current' then 0 when 'prospective' then 1 else 2 end`, desc(clients.updatedAt))
    .limit(1);
  return c?.id ?? null;
}

/** The first address that belongs to a person, else an organization whose website matches an address's domain (unless `peopleOnly`). Addresses must be lowercased. */
export async function linksForEmails(addresses: string[], opts: { peopleOnly?: boolean } = {}): Promise<Links> {
  const db = await getDb();
  let personId: string | null = null;
  let organizationId: string | null = null;
  if (addresses.length) {
    const found = await db
      .select({ id: people.id, email: people.email, otherEmails: people.otherEmails, organizationId: people.organizationId })
      .from(people)
      .where(
        and(
          isNull(people.archivedAt),
          or(
            inArray(sql`lower(${people.email})`, addresses),
            sql`exists (select 1 from jsonb_array_elements_text(${people.otherEmails}) o(email) where lower(o.email) in (${sql.join(
              addresses.map((a) => sql`${a}`),
              sql`, `,
            )}))`,
          ),
        ),
      );
    // A main address wins over someone else's other address.
    const first = addresses.map((p) => found.find((f) => f.email?.toLowerCase() === p) ?? found.find((f) => f.otherEmails.some((e) => e.toLowerCase() === p))).find(Boolean);
    personId = first?.id ?? null;
    organizationId = first?.organizationId ?? null;
    // Synced mailboxes only take mail with someone who is a person here: a matching website alone isn't enough.
    if (opts.peopleOnly && !personId) return { personId: null, organizationId: null, clientId: null };
    if (!organizationId) {
      const domains = [...new Set(addresses.map((p) => p.split("@")[1]).filter(Boolean))];
      if (domains.length) {
        const [org] = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(and(isNull(organizations.archivedAt), inArray(organizations.domain, domains)))
          .limit(1);
        organizationId = org?.id ?? null;
      }
    }
  }
  return { personId, organizationId, clientId: await clientFor(personId, organizationId) };
}

/**
 * The last 10 digits of a stored phone, without an extension: the SQL twin of
 * `matchKey` (src/lib/phone/numbers.ts). Keep it identical to the indexes in
 * schema.ts so they're used.
 */
export const phoneDigits = (col: typeof people.phone | typeof organizations.phone) =>
  sql`right(regexp_replace(regexp_replace(${col}, '\\s*(x|ext\\.?|extension|#)\\s*[0-9]+\\s*$', '', 'i'), '[^0-9]', '', 'g'), 10)`;
const digits = phoneDigits;

/** A person whose phone, or one of their other phones, has these last 10 digits (`matchKey`). */
export const hasPhone = (key: string) =>
  sql`(${digits(people.phone)} = ${key} or exists (select 1 from jsonb_array_elements_text(${people.otherPhones}) o(phone) where right(regexp_replace(regexp_replace(o.phone, '\\s*(x|ext\\.?|extension|#)\\s*[0-9]+\\s*$', '', 'i'), '[^0-9]', '', 'g'), 10) = ${key}))`;

/**
 * A caller or texter: the person whose phone matches (the most recently
 * active, if several share it), else an organization's main line. Compared on
 * the last 10 digits, so "(303) 555-0123" matches +13035550123.
 */
export async function linksForPhone(raw: string): Promise<Links & { personName: string | null; organizationName: string | null }> {
  const key = matchKey(raw);
  if (key.length < 7) return { personId: null, organizationId: null, clientId: null, personName: null, organizationName: null };
  const db = await getDb();
  const [p] = await db
    .select({ id: people.id, organizationId: people.organizationId, firstName: people.firstName, lastName: people.lastName })
    .from(people)
    .where(
      and(
        isNull(people.archivedAt),
        hasPhone(key),
      ),
    )
    .orderBy(sql`${people.lastActivityAt} desc nulls last`)
    .limit(1);
  let organizationId = p?.organizationId ?? null;
  let organizationName: string | null = null;
  if (!p) {
    const [o] = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(and(isNull(organizations.archivedAt), sql`${digits(organizations.phone)} = ${key}`))
      .limit(1);
    organizationId = o?.id ?? null;
    organizationName = o?.name ?? null;
  }
  const personId = p?.id ?? null;
  return { personId, organizationId, clientId: await clientFor(personId, organizationId), personName: p ? [p.firstName, p.lastName].filter(Boolean).join(" ") : null, organizationName };
}
