import "server-only";
import { and, eq, gt } from "drizzle-orm";
import { appConfig } from "@/app.config";
import { getDb, schema } from "@/db";
import type { CallStatus } from "@/db/schema";
import { resolveLinks } from "@/lib/crm/activities";
import { touch } from "@/lib/crm/events";
import { linksForPhone } from "@/lib/crm/match";
import { workspaceToday } from "@/lib/crm/inputs";
import { formatPhone } from "@/lib/phone/numbers";
import { callOutcome, finalCallStatuses } from "@/lib/phone/rules";
import { notify } from "@/lib/push/notify";
import { textToHtml } from "@/lib/safe-html";
import { getWorkspace } from "@/lib/workspace";
import { zonedTime } from "@/lib/format";
import { numberByE164, type PhoneNumber } from "./access";
import { WEBHOOKS } from "./config";
import { el, twiml } from "./twiml";

/**
 * Calls. Outgoing ones are placed from the browser (Twilio Voice SDK): the
 * page asks the CRM to prepare the call, the SDK connects, Twilio asks the
 * voice webhook what to do, and the CRM dials the person from the chosen
 * number. Incoming ones are forwarded to the number's cell phone, logged on
 * whoever called, and leave a task to write the call up.
 */

const { phoneCalls, activities } = schema;

/** The Voice SDK identity for a teammate. Only letters, digits and underscores travel safely. */
export const identityFor = (userId: string) => `user_${userId.replace(/-/g, "")}`;

const userFromIdentity = (from: string) => {
  const hex = /^client:user_([0-9a-f]{32})$/.exec(from)?.[1];
  return hex ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : null;
};

/** A prepared browser call that Twilio didn't ask about within this long is stale and refused. */
const PREPARED_MS = 5 * 60_000;

/** Creates the call the browser is about to connect. The activity is logged when Twilio actually places it. */
export async function prepareCall(input: { userId: string; number: PhoneNumber; to: string; personId?: string | null; organizationId?: string | null; clientId?: string | null }) {
  const links = await resolveLinks(input);
  const db = await getDb();
  const [row] = await db
    .insert(phoneCalls)
    .values({ direction: "outbound", from: input.number.number, to: input.to, userId: input.userId, phoneNumberId: input.number.id, status: "initiated", ...links })
    .returning({ id: phoneCalls.id });
  return row;
}

const hangUp = (message?: string) => twiml(...(message ? [el("Say", undefined, message)] : []), el("Hangup"));

/** What Twilio should do with a call from a teammate's browser: dial the person the CRM prepared, from the number they chose. */
export async function browserCallTwiml(origin: string, p: Record<string, string>) {
  const userId = userFromIdentity(p.From ?? "");
  const callId = p.callId;
  if (!userId || !callId || !/^[0-9a-f-]{36}$/.test(callId)) return hangUp("This call couldn't be placed.");
  const db = await getDb();
  // The prepared call must be this teammate's, fresh, and not already used.
  const [call] = await db
    .update(phoneCalls)
    .set({ callSid: p.CallSid, status: "ringing", updatedAt: new Date() })
    .where(and(eq(phoneCalls.id, callId), eq(phoneCalls.userId, userId), eq(phoneCalls.status, "initiated"), gt(phoneCalls.createdAt, new Date(Date.now() - PREPARED_MS))))
    .returning();
  if (!call) return hangUp("This call expired. Try again from the CRM.");
  const now = new Date();
  await db.insert(activities).values({
    type: "call",
    direction: "outbound",
    occurredAt: now,
    userId,
    assigneeId: userId,
    callId: call.id,
    personId: call.personId,
    organizationId: call.organizationId,
    clientId: call.clientId,
  });
  await touch(call, now);
  const q = `?call=${call.id}`;
  return twiml(
    el(
      "Dial",
      { callerId: call.from, answerOnBridge: true, timeout: 40, action: `${origin}${WEBHOOKS.dial}${q}`, method: "POST" },
      el("Number", { statusCallback: `${origin}${WEBHOOKS.voiceStatus}${q}`, statusCallbackEvent: "answered completed", statusCallbackMethod: "POST" }, call.to),
    ),
  );
}

/**
 * An incoming call to one of the numbers: logged on whoever's calling (if
 * they're in the CRM), forwarded to the number's cell phone, and a task for
 * the teammate who looks after the number to write it up.
 */
export async function inboundCallTwiml(origin: string, p: Record<string, string>) {
  const number = p.To ? await numberByE164(p.To) : null;
  if (!number || number.archivedAt) return twiml(el("Reject"));
  const caller = p.From ?? "";
  const db = await getDb();
  const [existing] = p.CallSid ? await db.select().from(phoneCalls).where(eq(phoneCalls.callSid, p.CallSid)) : [];
  const forwardTo = number.forwardTo;
  const missed = appConfig.phone.missedCallMessage;
  // Twilio retries a webhook that timed out; the second ask gets the same answer without logging it again.
  let call = existing;
  if (!call) {
    const links = await linksForPhone(caller);
    const [created] = await db
      .insert(phoneCalls)
      .values({ callSid: p.CallSid, direction: "inbound", from: caller, to: number.number, phoneNumberId: number.id, userId: number.forwardUserId, status: "ringing", forwardedTo: forwardTo, personId: links.personId, organizationId: links.organizationId, clientId: links.clientId })
      .onConflictDoNothing()
      .returning();
    call = created ?? (await db.select().from(phoneCalls).where(eq(phoneCalls.callSid, p.CallSid)))[0];
    if (created) await logInbound(created, number, links.personName ?? links.organizationName);
  }
  if (!forwardTo) return twiml(...(missed ? [el("Say", undefined, missed)] : [el("Say", undefined, "Sorry, no one can take your call right now. Please try again later.")]), el("Hangup"));
  const q = `?call=${call.id}`;
  return twiml(
    el(
      "Dial",
      {
        callerId: appConfig.phone.forwardCallerId === "caller" && caller.startsWith("+") ? caller : number.number,
        timeout: Math.min(Math.max(appConfig.phone.forwardTimeoutSeconds, 5), 120),
        action: `${origin}${WEBHOOKS.dial}${q}`,
        method: "POST",
      },
      el("Number", { statusCallback: `${origin}${WEBHOOKS.voiceStatus}${q}`, statusCallbackEvent: "answered completed", statusCallbackMethod: "POST" }, forwardTo),
    ),
  );
}

/** `callerName`: the person (or organization line) the number matched, if any. */
async function logInbound(call: typeof phoneCalls.$inferSelect, number: PhoneNumber, callerName: string | null) {
  const db = await getDb();
  const ws = await getWorkspace();
  const [forwardUser] = number.forwardUserId ? await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(eq(schema.users.id, number.forwardUserId)) : [];
  const links = { personId: call.personId, organizationId: call.organizationId, clientId: call.clientId };
  const who = callerName ?? formatPhone(call.from);
  const forwarded = call.forwardedTo ? `Forwarded to ${forwardUser?.name ?? "a cell phone"} at ${formatPhone(call.forwardedTo)}.` : `${number.label} has no forwarding number, so no one picked up.`;
  const now = new Date();
  await db.insert(activities).values({
    type: "call",
    direction: "inbound",
    subject: callerName ? null : `Call from ${formatPhone(call.from)}`,
    body: textToHtml(`${forwarded} Came in on ${number.label}, ${formatPhone(number.number)}.`),
    occurredAt: now,
    userId: null,
    assigneeId: number.forwardUserId,
    callId: call.id,
    ...links,
  });
  if (links.personId || links.organizationId) await touch(links, now);
  if (!forwardUser) return;
  // Due today (no time), so it's on their list without a "due now" ping in the middle of the call.
  const [task] = await db
    .insert(activities)
    .values({
      type: "task",
      subject: `Add notes from the call with ${who}`,
      body: textToHtml(`${who}${callerName ? "" : `, who isn't in the CRM yet,`} called ${number.label}. Write up what it was about on the call, then check this off.`),
      dueAt: zonedTime(await workspaceToday(), "00:00", ws.timezone),
      dueHasTime: false,
      userId: null,
      assigneeId: forwardUser.id,
      ...links,
    })
    .returning({ id: activities.id });
  notify([forwardUser.id], {
    kind: "task_assigned",
    title: `Call from ${who}`,
    body: "Add your notes from the call when you're done.",
    url: links.clientId ? `/clients/${links.clientId}` : links.personId ? `/people/${links.personId}` : links.organizationId ? `/organizations/${links.organizationId}` : "/activities",
    dedupeKey: `call_task:${task.id}`,
  });
}

/** Status reports for the dialed leg: answered (live), then completed with its length. */
export async function recordCallStatus(callId: string, p: Record<string, string>) {
  const status = p.CallStatus as CallStatus | undefined;
  if (!status) return;
  await updateCall(callId, status, p.CallDuration ? Number(p.CallDuration) : null);
}

/** The Dial finished (answered and hung up, busy, no answer…). For a missed incoming call, says the missed-call message. */
export async function dialFinished(callId: string, p: Record<string, string>) {
  const status = (p.DialCallStatus as CallStatus | undefined) ?? "completed";
  const call = await updateCall(callId, status, p.DialCallDuration ? Number(p.DialCallDuration) : null);
  const missed = call?.direction === "inbound" && status !== "completed";
  const message = appConfig.phone.missedCallMessage;
  return missed && message ? twiml(el("Say", undefined, message), el("Hangup")) : twiml(el("Hangup"));
}

async function updateCall(callId: string, status: CallStatus, seconds: number | null) {
  if (!/^[0-9a-f-]{36}$/.test(callId)) return null;
  const db = await getDb();
  const [call] = await db.select().from(phoneCalls).where(eq(phoneCalls.id, callId));
  if (!call) return null;
  // A finished call stays finished; a later "completed" may still add the length.
  if (finalCallStatuses.includes(call.status) && !(status === "completed" && call.status === "completed" && seconds && !call.durationSeconds)) return call;
  const now = new Date();
  const final = finalCallStatuses.includes(status);
  const answered = status === "in-progress" || (status === "completed" && (seconds ?? 0) > 0);
  const [row] = await db
    .update(phoneCalls)
    .set({
      status: status === "in-progress" || !final ? (status === "initiated" ? call.status : status) : status,
      ...(answered && !call.answeredAt ? { answeredAt: now } : {}),
      ...(final ? { endedAt: call.endedAt ?? now, durationSeconds: seconds ?? call.durationSeconds } : {}),
      updatedAt: now,
    })
    .where(eq(phoneCalls.id, call.id))
    .returning();
  if (final) {
    const outcome = callOutcome(status, call.direction, seconds);
    await db
      .update(activities)
      .set({ outcome, durationMinutes: seconds ? Math.max(1, Math.round(seconds / 60)) : null, updatedAt: now })
      .where(eq(activities.callId, call.id));
  }
  return row;
}
