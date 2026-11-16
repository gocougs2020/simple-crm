"use server";

import { refresh } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { appConfig } from "@/app.config";
import { run, type Result } from "@/lib/action";
import { ActionError, actionAdmin, actionEditor, actionUser } from "@/lib/auth";
import { sessionActor } from "@/lib/crm/actor";
import { resolveLinks } from "@/lib/crm/activities";
import { updateActivity } from "@/lib/crm/service/activities";
import { siteOrigin } from "@/lib/origin";
import { toE164 } from "@/lib/phone/numbers";
import { assertNumberAccess } from "@/lib/twilio/access";
import { TwilioError } from "@/lib/twilio/client";
import { phoneConfigured } from "@/lib/twilio/config";
import { buyNumber, connectNumber, releaseNumber, searchAvailableNumbers, setUpCalling, voiceToken } from "@/lib/twilio/setup";
import { logSentText, sendText } from "@/lib/twilio/texts";
import { identityFor, prepareCall } from "@/lib/twilio/voice";

/**
 * Calling and texting from records, and managing the team's numbers
 * (Settings → Phone numbers, admins). Every call and text goes through a
 * number the teammate has access to.
 */

const uuid = z.uuid();

function twilioError(err: unknown): never {
  if (err instanceof TwilioError) throw new ActionError(err.message);
  throw err;
}

function requirePhone() {
  if (!phoneConfigured()) throw new ActionError("Calling and texting aren't set up on this deployment. An admin can add a Twilio account (docs/PHONE.md).");
}

/** Who to reach: a typed number, else the person's (or organization's) phone on file. */
async function destination(input: { to?: string | null; personId?: string | null; organizationId?: string | null }) {
  const db = await getDb();
  let raw = input.to?.trim() || null;
  if (!raw && input.personId) raw = (await db.select({ phone: schema.people.phone }).from(schema.people).where(eq(schema.people.id, input.personId)))[0]?.phone ?? null;
  if (!raw && input.organizationId) raw = (await db.select({ phone: schema.organizations.phone }).from(schema.organizations).where(eq(schema.organizations.id, input.organizationId)))[0]?.phone ?? null;
  if (!raw) throw new ActionError("Add a phone number to this record first.");
  const e164 = toE164(raw, appConfig.phone.defaultCountryCode);
  if (!e164) throw new ActionError(`${raw} doesn't look like a full phone number. Include the area code (and the country code for numbers abroad).`);
  return e164;
}

async function rememberNumber(userId: string, prefs: Record<string, unknown>, phoneNumberId: string) {
  if (prefs.phoneNumberId === phoneNumberId) return;
  const db = await getDb();
  await db
    .update(schema.users)
    .set({ prefs: { ...prefs, phoneNumberId } })
    .where(eq(schema.users.id, userId));
}

// ─── Calls ───────────────────────────────────────────────────────────────

const callInput = z.object({
  phoneNumberId: uuid,
  to: z.string().max(40).nullable().optional(),
  personId: uuid.nullable().optional(),
  organizationId: uuid.nullable().optional(),
  clientId: uuid.nullable().optional(),
});

/** Gets a call ready for the browser to connect: checks access to the number, and hands back a calling token. */
export async function startCall(input: z.input<typeof callInput>): Promise<Result<{ callId: string; token: string; to: string; from: string; identity: string }>> {
  return run(async () => {
    const user = await actionEditor();
    requirePhone();
    const data = callInput.parse(input);
    const number = await assertNumberAccess(user, data.phoneNumberId);
    const to = await destination(data);
    const token = await voiceToken(identityFor(user.id)).catch(twilioError);
    const call = await prepareCall({ userId: user.id, number, to, personId: data.personId, organizationId: data.organizationId, clientId: data.clientId });
    await rememberNumber(user.id, user.prefs, number.id);
    return { callId: call.id, token: token.token, to, from: number.number, identity: identityFor(user.id) };
  });
}

/** A fresh calling token, before the browser's runs out mid-call. */
export async function refreshCallToken(): Promise<Result<{ token: string }>> {
  return run(async () => {
    const user = await actionEditor();
    requirePhone();
    return { token: (await voiceToken(identityFor(user.id)).catch(twilioError)).token };
  });
}

/** How a call the browser placed is going, and the activity its notes go on. */
export async function callState(callId: string) {
  const user = await actionUser();
  const db = await getDb();
  const [row] = await db
    .select({ status: schema.phoneCalls.status, durationSeconds: schema.phoneCalls.durationSeconds, activityId: schema.activities.id, body: schema.activities.body })
    .from(schema.phoneCalls)
    .leftJoin(schema.activities, eq(schema.activities.callId, schema.phoneCalls.id))
    .where(and(eq(schema.phoneCalls.id, uuid.parse(callId)), eq(schema.phoneCalls.userId, user.id)));
  return row ?? null;
}

/** Saves notes on a call made or forwarded through the CRM (its activity), during or after it. */
export async function saveCallNotes(callId: string, body: string): Promise<Result<{ activityId: string }>> {
  return run(async () => {
    const user = await actionEditor();
    const db = await getDb();
    const [row] = await db.select({ id: schema.activities.id }).from(schema.activities).where(eq(schema.activities.callId, uuid.parse(callId)));
    if (!row) throw new ActionError("The call hasn't connected yet, so there's nothing to add notes to. Try again once it rings.");
    await updateActivity(sessionActor(user), row.id, { body: z.string().max(100_000).parse(body) });
    refresh();
    return { activityId: row.id };
  });
}

// ─── Texts ───────────────────────────────────────────────────────────────

const textInput = z.object({
  phoneNumberId: uuid,
  personId: uuid,
  clientId: uuid.nullable().optional(),
  body: z.string().trim().min(1, "Write the text first.").max(1600, "Texts can be up to 1,600 characters."),
});

/** Texts a person from one of the team's numbers, and puts it on their timeline. */
export async function sendTextMessage(input: z.input<typeof textInput>): Promise<Result<{ activityId: string }>> {
  return run(async () => {
    const user = await actionEditor();
    requirePhone();
    const data = textInput.parse(input);
    const number = await assertNumberAccess(user, data.phoneNumberId);
    const db = await getDb();
    const [person] = await db.select({ textOptOutAt: schema.people.textOptOutAt, firstName: schema.people.firstName }).from(schema.people).where(eq(schema.people.id, data.personId));
    if (!person) throw new ActionError("This person was deleted.");
    if (person.textOptOutAt) throw new ActionError(`${person.firstName} replied STOP, so texts to them are blocked. They can reply START to opt back in.`);
    const to = await destination({ personId: data.personId });
    const links = await resolveLinks({ personId: data.personId, clientId: data.clientId ?? null });
    const result = await sendText({ number, to, body: data.body, userId: user.id, links, origin: await siteOrigin() });
    if (!result.sent || !result.row) throw new ActionError(result.error ?? "The text didn't send.");
    const activity = await logSentText(result.row);
    await rememberNumber(user.id, user.prefs, number.id);
    refresh();
    return { activityId: activity.id };
  });
}

// ─── Settings → Phone numbers (admins) ───────────────────────────────────

/** Creates or repairs what browser calling needs in the Twilio account (a TwiML app and an API key), pointed at this deployment. */
export async function setUpBrowserCalling(): Promise<Result> {
  return run(async () => {
    await actionAdmin();
    requirePhone();
    await setUpCalling(await siteOrigin()).catch(twilioError);
    refresh();
  });
}

/**
 * Numbers for sale in an area code that can call, text and send pictures
 * (voice, SMS, MMS). The Twilio account's other numbers are never listed here:
 * the CRM only ever sees the numbers it bought.
 */
export async function searchPhoneNumbers(areaCode: string): Promise<Result<{ number: string; locality: string | null; region: string | null }[]>> {
  return run(async () => {
    await actionAdmin();
    requirePhone();
    const code = z
      .string()
      .trim()
      .regex(/^\d{3}$/, "Enter a three-digit area code, like 303.")
      .parse(areaCode);
    const found = await searchAvailableNumbers(code, appConfig.phone.numberCountry).catch(twilioError);
    if (!found.length) throw new ActionError(`Twilio has no numbers in ${code} that can call and text right now. Try a nearby area code.`);
    return found;
  });
}

const e164Field = z
  .string()
  .trim()
  .max(40)
  .nullable()
  .optional()
  .transform((v, ctx) => {
    if (!v) return null;
    const n = toE164(v, appConfig.phone.defaultCountryCode);
    if (!n) ctx.addIssue({ code: "custom", message: "Enter the forwarding number with its area code." });
    return n;
  });

const numberInput = z.object({
  label: z.string().trim().min(1, "Name the number (Main line, Sales…).").max(60),
  forwardTo: e164Field,
  forwardUserId: uuid.nullable().optional(),
  access: z.enum(["everyone", "selected"]),
  userIds: z.array(uuid).max(500).optional(),
});

/**
 * Buys a number (from searchPhoneNumbers) in the Twilio account, points its
 * calls and texts at the CRM, and starts using it. Twilio bills it monthly.
 */
export async function buyPhoneNumber(input: { phoneNumber: string } & z.input<typeof numberInput>): Promise<Result<{ id: string; warning: string | null }>> {
  return run(async () => {
    await actionAdmin();
    requirePhone();
    const { phoneNumber } = z.object({ phoneNumber: z.string().regex(/^\+[1-9]\d{7,14}$/, "Pick a number from the search.") }).parse(input);
    const data = numberInput.parse(input);
    const bought = await buyNumber(phoneNumber, data.label, await siteOrigin()).catch(twilioError);
    const db = await getDb();
    const values = { twilioSid: bought.sid, number: bought.number, label: data.label, forwardTo: data.forwardTo, forwardUserId: data.forwardUserId ?? null, access: data.access, archivedAt: null, updatedAt: new Date() };
    let row: { id: string };
    try {
      // A number released earlier and bought back takes over its old row, keeping its history.
      [row] = await db.insert(schema.phoneNumbers).values(values).onConflictDoUpdate({ target: schema.phoneNumbers.number, set: values }).returning({ id: schema.phoneNumbers.id });
    } catch (err) {
      // Not saved here means never listed here (the account's numbers aren't shown): release it rather than pay for a number nobody can see.
      await releaseNumber(bought.sid).catch((e) => console.error("[twilio] release after failed save", e));
      throw err;
    }
    await setAccess(row.id, data.access === "selected" ? (data.userIds ?? []) : []);
    refresh();
    return { id: row.id, warning: bought.warning };
  });
}

export async function updatePhoneNumber(id: string, input: z.input<typeof numberInput>): Promise<Result> {
  return run(async () => {
    await actionAdmin();
    const data = numberInput.parse(input);
    const db = await getDb();
    const rows = await db
      .update(schema.phoneNumbers)
      .set({ label: data.label, forwardTo: data.forwardTo, forwardUserId: data.forwardUserId ?? null, access: data.access, updatedAt: new Date() })
      .where(eq(schema.phoneNumbers.id, uuid.parse(id)))
      .returning({ id: schema.phoneNumbers.id });
    if (!rows.length) throw new ActionError("This number was removed.");
    await setAccess(rows[0].id, data.access === "selected" ? (data.userIds ?? []) : []);
    refresh();
  });
}

async function setAccess(phoneNumberId: string, userIds: string[]) {
  const db = await getDb();
  await db.delete(schema.phoneNumberUsers).where(eq(schema.phoneNumberUsers.phoneNumberId, phoneNumberId));
  if (userIds.length) await db.insert(schema.phoneNumberUsers).values([...new Set(userIds)].map((userId) => ({ phoneNumberId, userId }))).onConflictDoNothing();
}

/**
 * Deletes a number: releases it from the Twilio account (it stops working and
 * stops being billed), and takes it off the list. Calls and texts it carried
 * stay on the records. Admins only.
 */
export async function deletePhoneNumber(id: string): Promise<Result> {
  return run(async () => {
    await actionAdmin();
    requirePhone();
    const db = await getDb();
    const [row] = await db.select().from(schema.phoneNumbers).where(eq(schema.phoneNumbers.id, uuid.parse(id)));
    if (!row || row.archivedAt) return;
    // Only ever a number the CRM bought (it's in this table), never another of the account's.
    await releaseNumber(row.twilioSid).catch(twilioError);
    await db.update(schema.phoneNumbers).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(schema.phoneNumbers.id, row.id));
    await db.delete(schema.phoneNumberUsers).where(eq(schema.phoneNumberUsers.phoneNumberId, row.id));
    refresh();
  });
}

/** Points every number in use at this deployment again (after a domain change). */
export async function reconnectPhoneNumbers(): Promise<Result<{ count: number }>> {
  return run(async () => {
    await actionAdmin();
    requirePhone();
    const db = await getDb();
    const origin = await siteOrigin();
    const rows = (await db.select().from(schema.phoneNumbers)).filter((n) => !n.archivedAt);
    for (const n of rows) await connectNumber(n.twilioSid, origin).catch(twilioError);
    await setUpCalling(origin).catch(twilioError);
    refresh();
    return { count: rows.length };
  });
}
