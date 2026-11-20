import "server-only";
import { resolveTxt } from "node:dns/promises";
import { and, asc, desc, eq, inArray, isNotNull, lt } from "drizzle-orm";
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
import { headerValue, splitMessage, verifyDkim } from "./dkim";
import {
  absoluteLinks,
  addressOf,
  checkSender,
  forwardAddress,
  forwardDomain,
  forwardPrompt,
  fromAddresses,
  isAutomatic,
  messageIds,
  newConversationKey,
  newForwardToken,
  parseForwardAddress,
  replySubject,
  stripQuoted,
  trustedAuthservIds,
  type Exchange,
} from "./rules";

/**
 * Email forwarded to the agent (docs/AGENT.md#email-forwarding). Each
 * teammate has a private address; Resend receives mail for it and calls our
 * webhook. Before anything is read, the email must be provably from that
 * teammate: their own address on the From line, with a DKIM signature from
 * their domain that we check ourselves (or DMARC passing at a receiver the
 * deployment trusts). Then it becomes background work, as them, and the
 * answer goes back to them by email. Replies continue the conversation.
 *
 * Mail that fails a check is never answered (a reply to a forged sender
 * would mail a stranger); it's listed in the teammate's Settings with why.
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

/** A teammate's address and their recent forwards, for Settings → Agent. Only ever their own. */
export async function forwardingFor(user: Pick<User, "id" | "forwardToken">) {
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
    address: availability.on && user.forwardToken ? forwardAddress(user.forwardToken, availability.domain) : null,
    recent: recent.map((r) => ({ ...r, receivedAt: r.receivedAt.toISOString() })),
  };
}

/** Turns a teammate's address on (or gives them a new one, which stops the old one at once), or off. */
export async function setForwarding(user: Pick<User, "id" | "role">, action: "on" | "new" | "off") {
  if (action !== "off") {
    const availability = forwardingAvailability();
    if (!availability.on) throw new ActionError(availability.reason);
    if (!roleCan(user.role, "records:write")) throw new ActionError("Forwarding changes records, and your role is read-only. Ask an admin for edit access.");
  }
  const db = await getDb();
  await db
    .update(schema.users)
    .set({ forwardToken: action === "off" ? null : newForwardToken() })
    .where(eq(schema.users.id, user.id));
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

  const db = await getDb();
  const [row] = await db
    .insert(forwards)
    .values({ resendEmailId: event.email_id, fromAddress: addressOf(event.from).slice(0, 320), subject: event.subject?.slice(0, 300) ?? null, messageId: bracketed(event.message_id) })
    .onConflictDoNothing({ target: forwards.resendEmailId })
    .returning();
  // Seen already: a repeated webhook.
  if (!row) return true;
  try {
    await processForward(row, hit);
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

async function refuse(row: Forward, reason: string, opts: { userId?: string | null; reply?: User } = {}) {
  const db = await getDb();
  const [updated] = await db
    .update(forwards)
    .set({ status: "refused", reason, ...(opts.userId !== undefined ? { userId: opts.userId } : {}) })
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
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok || !res.body) throw new RetryLater(`raw download ${res.status}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
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

async function processForward(row: Forward, hit: { token: string; conversationKey: string | null }) {
  const db = await getDb();
  const [user] = await db.select().from(schema.users).where(eq(schema.users.forwardToken, hit.token));
  if (!user || user.deactivatedAt) return refuse(row, "This address doesn't belong to anyone now: it was turned off or replaced.", { userId: user?.id ?? null });
  await db.update(forwards).set({ userId: user.id }).where(eq(forwards.id, row.id));
  // Before anything is fetched: mail to an address someone else learned can't pile up without limit.
  const arriving = await rateLimit("forward-in", user.id, { limit: cfg().perHour * 5, windowMs: 3_600_000 });
  if (arriving.limited) return refuse(row, "Too many emails arrived at your address in the last hour, so this one wasn't read. If you didn't send them, get a new address in Settings → Agent.");

  const resend = getResend();
  if (!resend) throw new RetryLater("Resend isn't connected");
  const { data: email, error } = await resend.emails.receiving.get(row.resendEmailId);
  if (error || !email) throw new RetryLater(error?.message ?? "no email");
  const raw = email.raw?.download_url ? await fetchRaw(email.raw.download_url) : null;
  if (email.raw?.download_url && !raw) return refuse(row, "It's too large to read. Forward it without the attachments.", { userId: user.id });
  const headers: Header[] = raw
    ? splitMessage(raw).headers.map((h) => ({ name: h.name, value: headerValue(h) }))
    : Object.entries(email.headers ?? {}).map(([name, value]) => ({ name: name.toLowerCase(), value: String(value) }));
  const subject = email.subject?.trim() || null;

  // 1. Their own address, and only theirs, on the From line.
  const fromLines = headers.filter((h) => h.name === "from");
  const from = fromLines.length === 1 ? fromAddresses(fromLines[0].value) : [];
  if (from.length !== 1) return refuse(row, "Its From line doesn't name exactly one sender, so it can't be trusted.");
  if (from[0] !== user.email.toLowerCase()) return refuse(row, `It came from ${from[0]}, not ${user.email}, the address you sign in with. Forward from that address.`);
  // 2. A person wrote it: out-of-office replies and bounces never start work, so nothing can loop.
  if (isAutomatic(headers, subject)) return refuse(row, "It's an automatic reply, so it was ignored.");
  // 3. Provably sent by their domain, not just claiming to be.
  const fromDomain = from[0].split("@")[1] ?? "";
  const sender = checkSender({
    fromDomain,
    dkim: raw ? await verifyDkim(raw, dnsLookup) : [],
    authResults: headers.filter((h) => h.name === "authentication-results").map((h) => h.value),
    trusted: trustedAuthservIds(),
  });
  if (!sender.ok) return refuse(row, sender.reason);
  await db.update(forwards).set({ verifiedBy: sender.how }).where(eq(forwards.id, row.id));

  // From here on it's certainly them, so a refusal is answered.
  if (!roleCan(user.role, "records:write")) return refuse(row, "Your role is read-only, so the agent can't change records for you. Ask an admin for edit access.", { reply: user });
  const limit = await rateLimit("forward", user.id, { limit: cfg().perHour, windowMs: 3_600_000 });
  if (limit.limited) return refuse(row, `Your address took ${cfg().perHour} emails in the last hour, the most it accepts. Forward this one again later.`);

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
  const text = (round > 1 ? stripQuoted(body) : body.trim()).slice(0, cfg().maxChars);
  if (!text) return refuse(row, "There was no text in it to read. Forward it again with the email in the body.", { reply: user });
  const date = new Date(email.created_at).toISOString();
  const earlier: Exchange[] = earlierRows.map((r) => ({
    email: { from: r.forward.fromAddress ?? "", date: r.forward.receivedAt.toISOString(), subject: r.forward.subject, text: r.forward.text ?? "(no longer kept)" },
    answer: r.status === "done" ? r.answer : null,
  }));
  const prompt = forwardPrompt(earlier, { from: from[0], date, subject, text });

  const [working] = await db
    .update(forwards)
    .set({ conversationId, conversationKey: root?.conversationKey ?? newConversationKey(), round, text, subject, messageId: bracketed(email.message_id) ?? row.messageId, status: "working" })
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
  const footer = `Reply to this email to answer ${name} or correct it. What it changed is in each record's history, and under Background tasks in the ${name} panel. Your forwarding address and recent emails: ${origin}/settings/agent`;
  const brand = await emailBrand();
  const { id } = await sendEmail({
    to: user.email,
    from: fromAs(name),
    ...(domain && user.forwardToken && forward.conversationKey ? { replyTo: forwardAddress(user.forwardToken, domain, forward.conversationKey) } : {}),
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
  const html = done ? markdownToHtml(run.result ?? "") : `<p><strong>${appConfig.agent.name} couldn't finish.</strong> ${escapeHtml(run.error ?? "")}</p>`;
  await sendReply(claimed, user, html);
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
