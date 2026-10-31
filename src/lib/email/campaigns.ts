import "server-only";
import { render } from "@react-email/render";
import { and, eq, inArray, isNotNull, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { CampaignAudience } from "@/db/schema";
import { signUnsubscribe } from "@/lib/auth";
import { emailBrand } from "@/lib/brand";
import { getResend, emailFrom, fromAs } from "@/lib/email";
import CampaignEmail from "@/emails/campaign";
import { escapeHtml, fillMergeTags, fillMergeTagsHtml, mergeValues } from "./merge-tags";

const { people, organizations, campaigns, outboundEmails, deals } = schema;

/** Resend's batch endpoint takes up to 100 messages per call. */
const BATCH_SIZE = 100;
/** A send that hasn't progressed in this long is treated as interrupted and resumed. */
const STALE_SEND_MS = 10 * 60_000;

/** The full email HTML for a campaign body, in the brand kit's layout. Rendered on every save. */
export async function renderCampaign(body: string, previewText: string | null) {
  return render(CampaignEmail({ brand: await emailBrand(), body, preview: previewText ?? "" }));
}

function audienceWhere(a: CampaignAudience): SQL[] {
  const where: SQL[] = [isNotNull(people.email), isNull(people.archivedAt), isNull(people.unsubscribedAt)];
  if (a.personIds?.length) return [...where, inArray(people.id, a.personIds)];
  where.push(eq(people.marketingOptIn, true));
  if (a.tags?.length) where.push(sql`${people.tags} ?| array[${sql.join(a.tags.map((t) => sql`${t}`), sql`, `)}]`);
  if (a.ownerIds?.length) where.push(inArray(people.ownerId, a.ownerIds));
  if (a.organizationIds?.length) where.push(inArray(people.organizationId, a.organizationIds));
  if (a.stageIds?.length) {
    where.push(
      sql`exists (select 1 from ${deals} d where d.person_id = ${people.id} and d.status = 'open' and d.archived_at is null and d.stage_id in (${sql.join(a.stageIds.map((s) => sql`${s}`), sql`, `)}))`,
    );
  }
  return where;
}

/**
 * People a campaign goes to right now: a fixed list, or everyone matching the
 * filters who has an email, hasn't unsubscribed and is opted in. Ordered by id
 * so a resumed send makes the same batches.
 */
export async function resolveAudience(a: CampaignAudience) {
  const db = await getDb();
  return db
    .select({ id: people.id, email: people.email, firstName: people.firstName, lastName: people.lastName, organizationName: organizations.name })
    .from(people)
    .leftJoin(organizations, eq(organizations.id, people.organizationId))
    .where(and(...audienceWhere(a)))
    .orderBy(people.id) as Promise<{ id: string; email: string; firstName: string; lastName: string | null; organizationName: string | null }[]>;
}

export async function audienceCount(a: CampaignAudience) {
  const db = await getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(people)
    .where(and(...audienceWhere(a)));
  return row.n;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends a claimed campaign to everyone in its audience who hasn't had it yet.
 * Recipients already sent are skipped (unique campaign + person), each batch
 * carries an idempotency key, and progress is recorded batch by batch, so a
 * retry after a timeout or crash never double-sends.
 */
export async function sendCampaign(campaignId: string, origin: string) {
  const db = await getDb();
  const [c] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!c) throw new Error("Campaign not found.");
  if (c.status === "sent") return { sent: 0 };
  if (!c.subject.trim()) throw new Error("Add a subject line first.");
  if (!c.html) throw new Error("Write the email first.");
  const brand = await emailBrand();
  if (!brand.postalAddress) throw new Error("Add your postal address in Settings → Email and brand. Marketing email must include one.");

  const audience = await resolveAudience(c.audience);
  const done = new Set((await db.select({ id: outboundEmails.personId }).from(outboundEmails).where(eq(outboundEmails.campaignId, c.id))).map((r) => r.id));
  const pending = audience.filter((p) => !done.has(p.id));
  const resend = getResend();
  const from = brand.senderName ? fromAs(brand.senderName) : emailFrom;
  let sent = 0;

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const chunk = pending.slice(i, i + BATCH_SIZE);
    const messages = await Promise.all(
      chunk.map(async (p) => {
        const token = await signUnsubscribe(p.id);
        const unsubscribeUrl = `${origin}/unsubscribe?t=${token}`;
        const values = mergeValues(p);
        const html = fillMergeTagsHtml(c.html!, values).replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, escapeHtml(unsubscribeUrl));
        return {
          person: p,
          payload: {
            from,
            replyTo: brand.replyTo,
            to: p.email,
            subject: fillMergeTags(c.subject, values),
            html,
            headers: { "List-Unsubscribe": `<${origin}/unsubscribe/one-click?t=${token}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
            tags: [
              { name: "type", value: "campaign" },
              { name: "campaign", value: c.id },
            ],
          },
        };
      }),
    );

    let ids: (string | null)[] = messages.map(() => null);
    if (resend) {
      if (i > 0) await sleep(250); // stay well under Resend's per-second request limit
      const { data, error } = await resend.batch.send(
        messages.map((m) => m.payload),
        { idempotencyKey: `campaign-${c.id}-${chunk[0].id}-${chunk.length}` },
      );
      if (error) throw new Error(`Resend: ${error.message}`);
      ids = data?.data?.map((d) => d.id) ?? ids;
    } else {
      for (const m of messages) console.info(`[email:dev] campaign "${m.payload.subject}" → ${m.payload.to}`);
    }

    await db
      .insert(outboundEmails)
      .values(messages.map((m, j) => ({ personId: m.person.id, campaignId: c.id, to: m.person.email, subject: m.payload.subject, resendId: ids[j], userId: c.createdBy })))
      .onConflictDoNothing();
    // Heartbeat, so the cron only resumes sends that have actually stalled.
    await db
      .update(campaigns)
      .set({ updatedAt: new Date(), recipientCount: done.size + sent + chunk.length })
      .where(eq(campaigns.id, c.id));
    sent += chunk.length;
  }

  await db
    .update(campaigns)
    .set({ status: "sent", sentAt: new Date(), recipientCount: done.size + sent, updatedAt: new Date() })
    .where(eq(campaigns.id, c.id));
  return { sent };
}

/**
 * Claims due campaigns (and stalled sends) with one conditional UPDATE, so
 * overlapping cron runs or a double-clicked "Send now" never send twice, then
 * sends each. Failures go back to draft with the reason shown.
 */
export async function runDueCampaigns(origin: string, onlyId?: string) {
  const db = await getDb();
  const now = new Date();
  const due = or(
    and(eq(campaigns.status, "scheduled"), lte(campaigns.scheduledAt, now)),
    and(eq(campaigns.status, "sending"), lt(campaigns.updatedAt, new Date(now.getTime() - STALE_SEND_MS))),
  );
  const claimed = await db
    .update(campaigns)
    .set({ status: "sending", updatedAt: now })
    .where(onlyId ? and(eq(campaigns.id, onlyId), due) : due)
    .returning({ id: campaigns.id, name: campaigns.name });
  const results: { id: string; name: string; sent?: number; error?: string }[] = [];
  for (const c of claimed) {
    try {
      results.push({ ...c, sent: (await sendCampaign(c.id, origin)).sent });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.update(campaigns).set({ status: "draft", sendError: message, updatedAt: new Date() }).where(eq(campaigns.id, c.id));
      results.push({ ...c, error: message });
    }
  }
  return { checkedAt: now.toISOString(), campaigns: results };
}

