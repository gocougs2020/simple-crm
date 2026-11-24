import "server-only";
import { after } from "next/server";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import MentionEmail from "@/emails/mention";
import { emailBrand } from "@/lib/brand";
import { wantsMentionEmail, type MentionEmailKind } from "@/lib/constants";
import { sendEmail } from "@/lib/email";
import { siteOrigin } from "@/lib/origin";

/**
 * Emails a teammate when someone mentions them ("@Sam") in a note, a reply or
 * the team chat, with what was written and links straight to it. Push alerts
 * for the same mention go through src/lib/push; this is the email beside them,
 * on unless the teammate turns it off (Settings → Notifications).
 *
 * Like push, it runs after the response, so a slow mail service never slows the
 * change, and each email is a row in `notifications` claimed before sending, so a
 * retried request can't send it twice.
 */

export type Mention = {
  kind: MentionEmailKind;
  /** Who wrote it, in full: "Sam Lee", or "Sam Lee via Agent". */
  who: string;
  /** "Sam Lee mentioned you in a note on Acme": the subject, and the email's first line. */
  title: string;
  /** What was written, as plain text. */
  text: string;
  /** A path on this site: the note on its record, or the message in the chat. */
  path: string;
  action: string;
  record?: { name: string; kind: string; path: string } | null;
  /** Per note, reply or message. */
  dedupeKey: string;
};

/** The longest quote an email carries. */
export const MAX_QUOTE = 2_000;

export function quoteOf(text: string) {
  const t = text
    // "[Acme](/clients/<id>)" reads as "Acme" in an email.
    .replace(/\[([^\]\n]{1,200})\]\((?:\/[^\s)]*|https?:\/\/[^\s)]+)\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return t.length <= MAX_QUOTE ? t : `${t.slice(0, MAX_QUOTE - 1).trimEnd()}…`;
}

/** Queues the email for each mentioned teammate, after the current request. Nobody is emailed about their own words. */
export function emailMentioned(userIds: string[], mention: Mention | (() => Promise<Mention>), opts: { except?: string | null } = {}) {
  const ids = [...new Set(userIds)].filter((id) => id && id !== opts.except);
  if (!ids.length) return;
  // `mention` can be a function, for details that take a query (the record's name): it runs after the response too.
  const work = async () => {
    try {
      await sendMentionEmails(ids, typeof mention === "function" ? await mention() : mention);
    } catch (err) {
      console.error("[mention email]", err);
    }
  };
  try {
    after(work);
  } catch {
    // Outside a request (a script): send now.
    void work();
  }
}

export async function sendMentionEmails(userIds: string[], m: Mention) {
  const db = await getDb();
  const u = schema.users;
  // Active teammates who have signed in at least once: an invite nobody took up doesn't get mail.
  const people = await db
    .select({ id: u.id, name: u.name, email: u.email, prefs: u.prefs })
    .from(u)
    .where(and(inArray(u.id, userIds), isNull(u.deactivatedAt), isNotNull(u.passwordHash)));
  const wanting = people.filter((p) => wantsMentionEmail(p.prefs, m.kind));
  if (!wanting.length) return 0;
  const [origin, brand] = await Promise.all([siteOrigin(), emailBrand()]);
  let sent = 0;
  for (const person of wanting) {
    const [claim] = await db
      .insert(schema.notifications)
      .values({ userId: person.id, kind: `${m.kind}_mention_email`, title: m.title.slice(0, 200), body: m.text.slice(0, 500), url: m.path, dedupeKey: `email:${m.dedupeKey}` })
      .onConflictDoNothing()
      .returning({ id: schema.notifications.id });
    if (!claim) continue;
    try {
      await sendEmail({
        to: person.email,
        subject: m.title,
        react: MentionEmail({
          brand,
          firstName: person.name.split(" ")[0],
          title: m.title,
          quote: quoteOf(m.text) || "Open it to read it.",
          url: `${origin}${m.path}`,
          action: m.action,
          record: m.record ? { name: m.record.name, kind: m.record.kind, url: `${origin}${m.record.path}` } : null,
          settingsUrl: `${origin}/settings/notifications`,
        }),
        tags: [{ name: "type", value: `${m.kind}_mention` }],
        idempotencyKey: `mention:${person.id}:${m.dedupeKey}`.slice(0, 256),
      });
      await db.update(schema.notifications).set({ delivered: 1 }).where(eq(schema.notifications.id, claim.id));
      sent++;
    } catch (err) {
      // Give the slot back so a retry can send it.
      console.error("[mention email] send", err);
      await db.delete(schema.notifications).where(eq(schema.notifications.id, claim.id));
    }
  }
  return sent;
}
