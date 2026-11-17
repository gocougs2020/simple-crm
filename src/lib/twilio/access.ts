import "server-only";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { User } from "@/lib/auth";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { roleCan } from "@/lib/permissions";
import { numberTeammateId } from "@/lib/phone/rules";

/**
 * Who may call and text from which number. A number is open to everyone who
 * can change records, or to the teammates picked in Settings. Admins can use
 * every number.
 */

const { phoneNumbers, phoneNumberUsers } = schema;

export type PhoneNumber = typeof phoneNumbers.$inferSelect;

const isAdmin = (u: Pick<User, "role">) => u.role === "owner" || u.role === "admin";

/** Numbers this teammate may call and text from, label order. */
export async function numbersFor(user: Pick<User, "id" | "role">): Promise<PhoneNumber[]> {
  if (!roleCan(user.role, "records:write")) return [];
  const db = await getDb();
  return db
    .select()
    .from(phoneNumbers)
    .where(
      and(
        isNull(phoneNumbers.archivedAt),
        isAdmin(user)
          ? undefined
          : // Qualified by hand: with no joins Drizzle renders a bare "id".
            or(eq(phoneNumbers.access, "everyone"), sql`exists (select 1 from phone_number_users u where u.phone_number_id = "phone_numbers"."id" and u.user_id = ${user.id})`),
      ),
    )
    .orderBy(asc(phoneNumbers.label));
}

/** The number, if this teammate may use it; refuses otherwise with a sentence that says what to do. */
export async function assertNumberAccess(user: Pick<User, "id" | "role">, phoneNumberId: string): Promise<PhoneNumber> {
  const db = await getDb();
  const [n] = await db.select().from(phoneNumbers).where(eq(phoneNumbers.id, phoneNumberId));
  if (!n || n.archivedAt) throw new NotFoundError("That phone number was removed. Pick another.");
  if (!roleCan(user.role, "records:write")) throw new ForbiddenError("Your role can view records but not call or text. Ask an admin for edit access.");
  if (isAdmin(user) || n.access === "everyone") return n;
  const [ok] = await db
    .select({ userId: phoneNumberUsers.userId })
    .from(phoneNumberUsers)
    .where(and(eq(phoneNumberUsers.phoneNumberId, n.id), eq(phoneNumberUsers.userId, user.id)));
  if (!ok) throw new ForbiddenError(`You don't have access to ${n.label}. Ask an admin to add you in Settings → Phone numbers.`);
  return n;
}

/** Who's on each number's access list, for Settings. */
export async function accessLists(ids: string[]) {
  if (!ids.length) return new Map<string, string[]>();
  const db = await getDb();
  const rows = await db.select().from(phoneNumberUsers).where(inArray(phoneNumberUsers.phoneNumberId, ids));
  const map = new Map<string, string[]>();
  for (const r of rows) map.set(r.phoneNumberId, [...(map.get(r.phoneNumberId) ?? []), r.userId]);
  return map;
}

/** The number a call or text came in on (the `To` Twilio sends), if the CRM uses it. */
export async function numberByE164(e164: string) {
  const db = await getDb();
  const [n] = await db.select().from(phoneNumbers).where(eq(phoneNumbers.number, e164));
  return n ?? null;
}

/** The teammate who looks after a number's calls and texts: whose cell it forwards to, else the one picked in Settings (numberTeammateId). */
export async function numberTeammate(number: Pick<PhoneNumber, "forwardTo" | "forwardUserId">): Promise<{ id: string; name: string; phone: string | null } | null> {
  if (!number.forwardTo && !number.forwardUserId) return null;
  const db = await getDb();
  const u = schema.users;
  const team = await db
    .select({ id: u.id, name: u.name, phone: u.phone })
    .from(u)
    .where(and(isNull(u.deactivatedAt), or(sql`${u.phone} is not null`, number.forwardUserId ? eq(u.id, number.forwardUserId) : undefined)));
  const id = numberTeammateId(number, team.map((t) => ({ ...t, active: true })));
  return team.find((t) => t.id === id) ?? null;
}
