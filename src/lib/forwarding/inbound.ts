import "server-only";
import { resolveTxt } from "node:dns/promises";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { appConfig } from "@/app.config";
import { getDb, schema } from "@/db";
import DirectEmail from "@/emails/direct";
import { assistantActor } from "@/lib/agent/actor";
import { aiFeatures } from "@/lib/agent/config";
import { markdownToHtml } from "@/lib/agent/markdown";
import { startRun, type Run } from "@/lib/agent/runs";
import type { User } from "@/lib/auth";
import { emailBrand } from "@/lib/brand";
import { emailConfigured, fromAs, getResend, sendEmail } from "@/lib/email";
import { ActionError } from "@/lib/errors";
import { siteOrigin } from "@/lib/origin";
import { roleCan } from "@/lib/permissions";
import { rateLimit } from "@/lib/rate-limit";
import { htmlToText, sanitizeHtml } from "@/lib/safe-html";
import { headerValue, LOOKUP_FAILED, splitMessage, verifyDkim } from "./dkim";
import {
  absoluteLinks,
  addressOf,
  checkSender,
  forwardAddress,
  forwardDomain,
  forwardPrompt,
  freshEnough,
  fromAddresses,
  isAutomatic,
  messageIds,
  newConversationKey,
  parseForwardAddress,
  replySubject,
  stripQuoted,
  trustedAuthservIds,
  type Exchange,
} from "./rules";

/**
 * Email forwarded to the agent (docs/AGENT.md#email-forwarding). The team
 * shares one address, the agent's name at FORWARD_EMAIL_DOMAIN; Resend
 * receives mail for it and calls our webhook. Who sent it decides whose work
 * it is, so before anything is read the email must be provably from that
 * teammate: their sign-in address alone on the From line, with a DKIM
 * signature from their domain that we check ourselves (or DMARC passing at
 * a receiver the deployment trusts), dated in the last few days, and never
 * seen before. Then it becomes background work, as them, and the answer goes
 * back to them by email. Replies continue the conversation.
 *
 * Mail that fails a check is never answered (a reply to a forged sender
 * would mail a stranger); it's listed in the teammate's Settings with why.
 * Mail that doesn't even claim to be from a teammate isn't stored at all.
 */

const forwards = schema.emailForwards;
const cfg = () => appConfig.agent.forwarding;
const MAX_RAW_BYTES = 30 * 1024 * 1024;
/** How long what a forwarded email said is kept. The notes the agent wrote stay. */
const KEEP_TEXT_DAYS = 30;

export type ForwardingAvailability = { on: true; domain: string } | { on: false; reason: string };

/** Whether this deployment can take forwarded email, and if not, what an admin needs to do. */
export function forwardingAvailability(): ForwardingAvailability {
  if (!cfg().enabled) return { on: false, reason: "Email forwarding is turned off on this deployment (agent.forwarding.enabled in app.config.ts)." };
  if (!aiFeatures().background) return { on: false, reason: "Email forwarding needs the agent's background work, which isn't set up on this deployment (docs/AGENT.md)." };
  if (!emailConfigured()) return { on: false, reason: "Email forwarding needs Resend. An admin can add RESEND_API_KEY." };
  const domain = forwardDomain();
  if (!domain) return { on: false, reason: "Email forwarding needs a receiving domain. An admin can set FORWARD_EMAIL_DOMAIN to a Resend domain with receiving turned on (docs/AGENT.md#email-forwarding)." };
  return { on: true, domain };
}

// ─── Settings ────────────────────────────────────────────────────────────

/** The team's address and this teammate's recent emails to it, for Settings → Agent. Only ever their own. */
export async function forwardingFor(user: Pick<User, "id">) {
  const availability = forwardingAvailability();
  const db = await getDb();
  const recent = await db
    .select({ id: forwards.id, subject: forwards.subject, fromAddress: forwards.fromAddress, status: forwards.status, reason: forwards.reason, round: forwards.round, runId: forwards.runId, receivedAt: forwards.receivedAt })
    .from(forwards)
    .where(eq(forwards.userId, user.id))
    .orderBy(desc(forwards.receivedAt))
    .limit(10);
  return {
    availability,
    address: availability.on ? forwardAddress(availability.domain) : null,
    recent: recent.map((r) => ({ ...r, receivedAt: r.receivedAt.toISOString() })),
  };
}

// ─── Receiving ───────────────────────────────────────────────────────────

/** What Resend's `email.received` webhook says about a message. Only used to decide whether to look closer; the email itself is fetched from Resend. */
export type ReceivedEvent = { email_id: string; from: string; to: string[]; cc?: string[] | null; bcc?: string[] | null; received_for?: string[] | null; subject?: string | null; message_id?: string | null };

/** Thrown before a run starts when Resend couldn't be read: the webhook answers 500 and Resend tries again. */
class RetryLater extends Error {}

/**
 * Handles an `email.received` webhook. Returns false when the email isn't
 * to a forwarding address (it's for another use of the domain). Throws
 * when it should be retried.
 */
export async function handleReceived(event: ReceivedEvent): Promise<boolean> {
  const availability = forwardingAvailability();
  if (!availability.on) return false;
  const recipients = [...event.to, ...(event.cc ?? []), ...(event.bcc ?? []), ...(event.received_for ?? [])].map(addressOf);
  const hit = recipients.map((a) => parseForwardAddress(a, availability.domain)).find((x) => !!x);
  if (!hit) return false;

  // A first, cheap filter before anything is fetched or stored: it must at least claim to be from an active
  // teammate. Mail from anyone else (a client's reply-all, spam) is dropped here. The claim is proven below.
  const db = await getDb();
  const claimed = addressOf(event.from);
  const [user] = await db
    .select()
    .from(schema.users)
    .where(and(sql`lower(${schema.users.email}) = ${claimed}`, isNull(schema.users.deactivatedAt)))
    .limit(1);
  if (!user) return true;

  const [row] = await db
    .insert(forwards)
    .values({ resendEmailId: event.email_id, userId: user.id, fromAddress: claimed.slice(0, 320), subject: event.subject?.slice(0, 300) ?? null, messageId: bracketed(event.message_id) })
    // A repeated webhook (same Resend id) does nothing. The same email sent again is caught once it's verified, below.
    .onConflictDoNothing({ target: forwards.resendEmailId })
    .returning();
  if (!row) return true;
  try {
    await processForward(row, hit, user);
  } catch (err) {
    if (err instanceof RetryLater) {
      // Nothing started yet, so let Resend's retry begin again from the top.
      await db.delete(forwards).where(eq(forwards.id, row.id));
      throw err;
    }
    console.error("[forwarding]", row.id, err);
    await db.update(forwards).set({ status: "failed", reason: "Something went wrong while reading this email. Forward it again in a moment." }).where(eq(forwards.id, row.id));
  }
  return true;
}

type Forward = typeof forwards.$inferSelect;
type Header = { name: string; value: string };

async function refuse(row: Forward, reason: string, opts: { reply?: User } = {}) {
  const db = await getDb();
  const [updated] = await db
    .update(forwards)
    .set({ status: "refused", reason })
    .where(eq(forwards.id, row.id))
    .returning();
  // Only mail that proved it's from the teammate is ever answered.
  if (opts.reply && updated) await sendReply(updated, opts.reply, `<p><strong>${appConfig.agent.name} didn't take this one.</strong> ${escapeHtml(reason)}</p>`).catch((err) => console.error("[forwarding] reply", err));
}

/** A Message-ID in its bracketed form, the way In-Reply-To and References quote it. */
const bracketed = (id: string | null | undefined) => {
  const v = id?.trim();
  return v ? (v.startsWith("<") ? v : `<${v}>`).slice(0, 500) : null;
};

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The raw message from Resend's short-lived download link: https only, and no bigger than an email can be. */
async function fetchRaw(url: string) {
  if (!/^https:\/\//i.test(url)) throw new RetryLater("raw link isn't https");
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    // A timeout or dropped connection: Resend retries the webhook, and this starts over.
    throw new RetryLater(`raw download: ${(err as Error).message}`);
  }
  if (!res.ok || !res.body) throw new RetryLater(`raw download ${res.status}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    let next: ReadableStreamReadResult<Uint8Array>;
    try {
      next = await reader.read();
    } catch (err) {
      throw new RetryLater(`raw download: ${(err as Error).message}`);
    }
    const { done, value } = next;
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RAW_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

const dnsLookup = async (name: string) => {
  try {
    const records = await resolveTxt(name);
    return records.map((parts) => parts.join("")).find((r) => /(^|;)\s*p=/.test(r)) ?? null;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA") return null;
    throw err;
  }
};

async function processForward(row: Forward, hit: { conversationKey: string | null }, user: User) {
  const db = await getDb();
  // No limit before the checks: anything that refuses unproven mail would let forged mail lock real senders out.
  // Checking costs a Resend lookup and a DNS query; the hourly limit below counts only mail that passed.

  const resend = getResend();
  if (!resend) throw new RetryLater("Resend isn't connected");
  const { data: email, error } = await resend.emails.receiving.get(row.resendEmailId).catch((err: Error) => {
    throw new RetryLater(`Resend: ${err.message}`);
  });
  if (error || !email) throw new RetryLater(error?.message ?? "no email");
  const raw = email.raw?.download_url ? await fetchRaw(email.raw.download_url) : null;
  if (email.raw?.download_url && !raw) return refuse(row, "It's too large to read. Forward it without the attachments.");
  const headers: Header[] = raw
    ? splitMessage(raw).headers.map((h) => ({ name: h.name, value: headerValue(h) }))
    : Object.entries(email.headers ?? {}).map(([name, value]) => ({ name: name.toLowerCase(), value: String(value) }));
  const subject = email.subject?.trim() || null;

  // 1. Their own address, and only theirs, on the From line.
  const fromLines = headers.filter((h) => h.name === "from");
  const from = fromLines.length === 1 ? fromAddresses(fromLines[0].value) : [];
  if (from.length !== 1) return refuse(row, "Its From line doesn't name exactly one sender, so it can't be trusted.");
  if (from[0] !== user.email.toLowerCase()) return refuse(row, `Its From line says ${from[0]}, not ${user.email}, so it can't be trusted.`);
  // 2. A person wrote it: out-of-office replies and bounces never start work, so nothing can loop.
  if (isAutomatic(headers, subject)) return refuse(row, "It's an automatic reply, so it was ignored.");
  // 3. Provably sent by their domain, not just claiming to be.
  const fromDomain = from[0].split("@")[1] ?? "";
  const dkim = raw ? await verifyDkim(raw, dnsLookup) : [];
  const sender = checkSender({
    fromDomain,
    dkim,
    // In message order, so the topmost (the receiver's own) comes first. Without the raw message the order is lost, so none count.
    authResults: raw ? headers.filter((h) => h.name === "authentication-results").map((h) => h.value) : [],
    trusted: trustedAuthservIds(),
  });
  if (!sender.ok) {
    // DNS didn't answer for a key: that's on the way, not the sender. Retry rather than refuse a real email.
    if (dkim.some((d) => d.reason === LOOKUP_FAILED)) throw new RetryLater("DKIM key lookup failed");
    return refuse(row, sender.reason);
  }
  // 4. Written lately, so an old email of theirs can't be sent again by someone who received it. Only meaningful
  // when the signature covers the date; a forward is dated when it's sent, so old threads forwarded today pass.
  // The same goes for the Message-ID the never-twice rule keys on: it must be signed, and be the one this row was stored under.
  if (sender.signed && !(sender.signed.includes("date") && sender.signed.includes("message-id"))) {
    return refuse(row, "Its signature doesn't cover its date and Message-ID, so it can't be told apart from an old email sent again.");
  }
  // Exactly one of each: the signature covers the last instance of a header, so a second Date or Message-ID
  // added on top would otherwise be what's read here.
  const messageLines = headers.filter((h) => h.name === "message-id");
  if (messageLines.length !== 1 || !row.messageId || bracketed(messageLines[0].value) !== row.messageId) return refuse(row, "Its Message-ID is missing, repeated or doesn't match, so it can't be checked against emails already read.");
  const dateLines = headers.filter((h) => h.name === "date");
  if (dateLines.length !== 1) return refuse(row, "It has no date, or more than one, so it can't be told apart from an old email sent again.");
  const fresh = freshEnough(dateLines[0].value);
  if (!fresh.ok) return refuse(row, fresh.reason);
  // Marking it verified claims its (sender, Message-ID) slot; only verified emails hold one, so a forged copy
  // that arrived first can't take the real email's place. If the slot is taken, it's been read already.
  try {
    await db.update(forwards).set({ verifiedBy: sender.how }).where(eq(forwards.id, row.id));
  } catch (err) {
    if ((err as { code?: string; cause?: { code?: string } }).code === "23505" || (err as { cause?: { code?: string } }).cause?.code === "23505") {
      return refuse(row, "This exact email was already read once, so it wasn't read again.");
    }
    throw err;
  }

  // From here on it's certainly them, so a refusal is answered.
  if (!roleCan(user.role, "records:write")) return refuse(row, "Your role is read-only, so the agent can't change records for you. Ask an admin for edit access.", { reply: user });
  const limit = await rateLimit("forward", user.id, { limit: cfg().perHour, windowMs: 3_600_000 });
  if (limit.limited) return refuse(row, `You sent ${appConfig.agent.name} ${cfg().perHour} emails in the last hour, the most it takes. Forward this one again later.`);

  // Which conversation: the key in the reply address, else the threading headers.
  const refs = messageIds([headers.find((h) => h.name === "in-reply-to")?.value, headers.find((h) => h.name === "references")?.value].join(" "));
  const [root] = hit.conversationKey
    ? await db
        .select()
        .from(forwards)
        .where(and(eq(forwards.userId, user.id), eq(forwards.conversationKey, hit.conversationKey), isNotNull(forwards.conversationId)))
        .orderBy(asc(forwards.receivedAt))
        .limit(1)
    : refs.length
      ? await db
          .select()
          .from(forwards)
          .where(and(eq(forwards.userId, user.id), inArray(forwards.messageId, refs), isNotNull(forwards.conversationId)))
          .orderBy(desc(forwards.receivedAt))
          .limit(1)
      : [];
  const conversationId = root?.conversationId ?? row.id;
  const earlierRows = root
    ? await db
        .select({ forward: forwards, answer: schema.agentRuns.result, status: schema.agentRuns.status })
        .from(forwards)
        .leftJoin(schema.agentRuns, eq(schema.agentRuns.id, forwards.runId))
        .where(and(eq(forwards.conversationId, conversationId), eq(forwards.userId, user.id), inArray(forwards.status, ["working", "answered", "failed"])))
        .orderBy(asc(forwards.round), asc(forwards.receivedAt))
    : [];
  const round = (earlierRows.at(-1)?.forward.round ?? 0) + 1;
  if (round > cfg().maxRounds) return refuse(row, `This conversation has gone back and forth ${cfg().maxRounds} times, the most one can. Forward the email again to start fresh.`, { reply: user });

  const body = email.text?.trim() ? email.text : htmlToText(sanitizeHtml(email.html));
  // A reply to the agent's own email drops the quoted conversation it already has. Anything else (a later
  // message in a thread it was copied on) is kept whole: what's quoted may be news to it.
  const text = (hit.conversationKey && root ? stripQuoted(body) : body.trim()).slice(0, cfg().maxChars);
  if (!text) return refuse(row, "There was no text in it to read. Forward it again with the email in the body.", { reply: user });
  const date = new Date(email.created_at).toISOString();
  const earlier: Exchange[] = earlierRows.map((r) => ({
    email: { from: r.forward.fromAddress ?? "", date: r.forward.receivedAt.toISOString(), subject: r.forward.subject, text: r.forward.text ?? "(no longer kept)" },
    answer: r.status === "done" ? r.answer : null,
  }));
  const prompt = forwardPrompt(earlier, { from: from[0], date, subject, text });

  const [working] = await db
    .update(forwards)
    .set({ conversationId, conversationKey: root?.conversationKey ?? newConversationKey(), round, text, subject, status: "working" })
    .where(eq(forwards.id, row.id))
    .returning();
  try {
    const run = await startRun(await assistantActor(user), { prompt, title: subject ? `Email: ${subject}` : "Forwarded email", source: "email" });
    await db.update(forwards).set({ runId: run.id }).where(eq(forwards.id, row.id));
    // A run that couldn't even start (the worker didn't answer) ended before its id was saved here.
    if (run.status === "failed") await deliverForwardReply(run);
  } catch (err) {
    if (!(err instanceof ActionError)) throw err;
    await db.update(forwards).set({ status: "failed", reason: err.message }).where(eq(forwards.id, row.id));
    await sendReply(working, user, `<p><strong>${appConfig.agent.name} couldn't start.</strong> ${escapeHtml(err.message)}</p>`).catch((e) => console.error("[forwarding] reply", e));
  }
}

// ─── Answering ───────────────────────────────────────────────────────────

/** Sends the answer to the teammate, threaded under their email, with a reply address that continues the conversation. */
async function sendReply(forward: Forward, user: User, html: string) {
  const domain = forwardDomain();
  const db = await getDb();
  const thread = forward.conversationId
    ? await db
        .select({ messageId: forwards.messageId })
        .from(forwards)
        .where(and(eq(forwards.conversationId, forward.conversationId), eq(forwards.userId, user.id)))
        .orderBy(asc(forwards.round))
    : [];
  const ids = [...new Set([...thread.map((t) => t.messageId), forward.messageId].filter((m): m is string => !!m && /^<[^<>\s]+>$/.test(m)))];
  const origin = await siteOrigin();
  const name = appConfig.agent.name;
  const footer = `Reply to this email to answer ${name} or correct it. What it changed is in each record's history, and under Background tasks in the ${name} panel. Your recent emails to ${name}: ${origin}/settings/agent`;
  const brand = await emailBrand();
  const { id } = await sendEmail({
    to: user.email,
    from: fromAs(name),
    ...(domain && forward.conversationKey ? { replyTo: forwardAddress(domain, forward.conversationKey) } : {}),
    subject: replySubject(forward.subject),
    react: DirectEmail({ brand, html: absoluteLinks(sanitizeHtml(html), origin), preview: htmlToText(html).slice(0, 120), signature: footer }),
    headers: {
      ...(forward.messageId && ids.includes(forward.messageId) ? { "In-Reply-To": forward.messageId } : {}),
      ...(ids.length ? { References: ids.join(" ") } : {}),
      // RFC 3834: an automatic reply. Out-of-office responders skip it, and we ignore anything marked like this.
      "Auto-Submitted": "auto-replied",
      "X-Auto-Response-Suppress": "All",
      "X-CRM-Forward-Reply": forward.id,
    },
    idempotencyKey: `forward-reply:${forward.id}`,
  });
  await db.update(forwards).set({ replyId: id, repliedAt: new Date() }).where(eq(forwards.id, forward.id));
}

/** Called when an email's run ends: the answer (or why it couldn't finish) goes back by email. */
export async function deliverForwardReply(run: Run) {
  if (run.source !== "email") return;
  const db = await getDb();
  const [forward] = await db.select().from(forwards).where(eq(forwards.runId, run.id));
  if (!forward || forward.repliedAt || !forward.userId) return;
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, forward.userId));
  if (!user || user.deactivatedAt) return;
  const done = run.status === "done";
  const [claimed] = await db
    .update(forwards)
    .set({ status: done ? "answered" : "failed", reason: done ? null : run.error })
    .where(and(eq(forwards.id, forward.id), eq(forwards.status, "working")))
    .returning();
  if (!claimed) return;
  // If Resend is down this throws and replied_at stays empty; retryReplies (the agent cron) sends it later.
  await sendReply(claimed, user, answerHtml(run));
}

const answerHtml = (run: Pick<Run, "status" | "result" | "error">) =>
  run.status === "done" ? markdownToHtml(run.result ?? "") : `<p><strong>${appConfig.agent.name} couldn't finish.</strong> ${escapeHtml(run.error ?? "")}</p>`;

/**
 * From the agent cron: sends answers that didn't go out when their run ended
 * (Resend was down, say), for up to a day. The idempotency key per email
 * means a reply that did go out, just unrecorded, isn't sent twice.
 */
export async function retryReplies(now = new Date()) {
  const db = await getDb();
  const owed = await db
    .select({ forward: forwards, run: schema.agentRuns, user: schema.users })
    .from(forwards)
    .innerJoin(schema.agentRuns, eq(schema.agentRuns.id, forwards.runId))
    .innerJoin(schema.users, eq(schema.users.id, forwards.userId))
    .where(
      and(
        inArray(forwards.status, ["answered", "failed"]),
        isNull(forwards.repliedAt),
        // Only runs that have ended: a row marked failed while its run still works waits for the run's own answer.
        inArray(schema.agentRuns.status, ["done", "failed", "cancelled"]),
        gte(forwards.receivedAt, new Date(now.getTime() - 86_400_000)),
        isNull(schema.users.deactivatedAt),
      ),
    )
    .limit(20);
  let sent = 0;
  for (const { forward, run, user } of owed) {
    try {
      await sendReply(forward, user, answerHtml(run));
      sent++;
    } catch (err) {
      console.error("[forwarding] reply retry", forward.id, err);
    }
  }
  return { sent };
}

/** From the agent cron: forget what old forwarded emails said, and drop the rows after half a year. The notes the agent wrote from them stay on the records. */
export async function pruneForwards(now = new Date()) {
  const db = await getDb();
  const cutoff = new Date(now.getTime() - KEEP_TEXT_DAYS * 86_400_000);
  await db.delete(forwards).where(lt(forwards.receivedAt, new Date(now.getTime() - 180 * 86_400_000)));
  const cleared = await db
    .update(forwards)
    .set({ text: null })
    .where(and(lt(forwards.receivedAt, cutoff), isNotNull(forwards.text)))
    .returning({ id: forwards.id });
  return { cleared: cleared.length };
}
