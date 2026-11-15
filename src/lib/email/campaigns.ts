import "server-only";
import { render } from "@react-email/render";
import { and, eq, inArray, isNotNull, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { CampaignAudience } from "@/db/schema";
import { signUnsubscribe } from "@/lib/auth";
import { emailBrand } from "@/lib/brand";
import { getResend, emailFrom, fromAs } from "@/lib/email";
import { loadAttachments } from "./attachments";
import CampaignEmail from "@/emails/campaign";
import { escapeHtml, fillMergeTags, fillMergeTagsHtml, mergeValues } from "./merge-tags";

const { people, organizations, campaigns, outboundEmails } = schema;

/** Resend's batch endpoint takes up to 100 messages per call. */
const BATCH_SIZE = 100;
/** A send that hasn't progressed in this long is treated as interrupted and resumed. */
const STALE_SEND_MS = 10 * 60_000;

/** The full email HTML for a campaign body, in the brand kit's layout. Rendered on every save. */
export async function renderCampaign(body: string, previewText: string | null) {
  return render(CampaignEmail({ brand: await emailBrand(), body, preview: previewText ?? "" }));
}

const list = (xs: readonly (string | number)[]) => sql.join(xs.map((x) => sql`${x}`), sql`, `);

/** Client filters, as conditions on `clients c`. Empty when the audience doesn't filter by client. */
function clientConditions(a: CampaignAudience): SQL[] {
  const client: SQL[] = [];
  if (a.clientCategories?.length) client.push(sql`c.category in (${list(a.clientCategories)})`);
  if (a.pipelineIds?.length) client.push(sql`c.pipeline_id in (${list(a.pipelineIds)})`);
  if (a.stageIds?.length) client.push(sql`c.stage_id in (${list(a.stageIds)})`);
  if (a.clientTags?.length) client.push(sql`c.tags ?| array[${list(a.clientTags)}]`);
  if (a.churnReasons?.length) client.push(sql`c.churn_reason in (${list(a.churnReasons)})`);
  if (a.serviceIds?.length) client.push(sql`exists (select 1 from client_services cs where cs.client_id = c.id and cs.service_id in (${list(a.serviceIds)}))`);
  if (a.openToReturnOnly) client.push(sql`(c.category <> 'past' or c.open_to_return)`);
  return client;
}

/** A client the person is tied to (its contact, or someone at its organization) that matches all of `conds`. */
const clientOf = (conds: SQL[]) =>
  sql`clients c where c.archived_at is null and (c.person_id = ${people.id} or (c.organization_id is not null and c.organization_id = ${people.organizationId})) and ${sql.join(conds, sql` and `)}`;

function audienceWhere(a: CampaignAudience): SQL[] {
  // Never: no address, archived, unsubscribed, or an address that bounced for good.
  const where: SQL[] = [isNotNull(people.email), isNull(people.archivedAt), isNull(people.unsubscribedAt), isNull(people.emailBouncedAt)];
  if (a.personIds?.length) return [...where, inArray(people.id, a.personIds)];
  where.push(eq(people.marketingOptIn, true));
  if (a.tags?.length) where.push(a.tagMatch === "all" ? sql`${people.tags} ?& array[${list(a.tags)}]` : sql`${people.tags} ?| array[${list(a.tags)}]`);
  if (a.excludeTags?.length) where.push(sql`not (${people.tags} ?| array[${list(a.excludeTags)}])`);
  if (a.ownerIds?.length) where.push(inArray(people.ownerId, a.ownerIds));
  if (a.organizationIds?.length) where.push(inArray(people.organizationId, a.organizationIds));
  if (a.activeWithinDays) where.push(sql`${people.lastActivityAt} >= now() - make_interval(days => ${a.activeWithinDays}::int)`);
  if (a.inactiveForDays) where.push(sql`(${people.lastActivityAt} is null or ${people.lastActivityAt} < now() - make_interval(days => ${a.inactiveForDays}::int))`);
  for (const f of a.customFields ?? []) {
    if (!f.values.length) continue;
    // Single values compare as text (checkboxes read "true"/"false"); multi-selects match any chosen option.
    where.push(
      sql`(coalesce(${people.custom} ->> ${f.key}, '') in (${list(f.values)}) or (jsonb_typeof(${people.custom} -> ${f.key}) = 'array' and ${people.custom} -> ${f.key} ?| array[${list(f.values)}]))`,
    );
  }
  const client = clientConditions(a);
  if (client.length) where.push(sql`exists (select 1 from ${clientOf(client)})`);
  return where;
}

export type AudienceMember = {
  id: string;
  email: string;
  firstName: string;
  lastName: string | null;
  title: string | null;
  organizationId: string | null;
  organizationName: string | null;
  ownerName: string | null;
  custom: Record<string, unknown>;
  /** With client filters: the matching client this person is getting the campaign because of (their own first). */
  clientId: string | null;
  clientName: string | null;
};

/**
 * People a campaign goes to right now: a fixed list, or everyone matching the
 * filters who has an email, hasn't unsubscribed or bounced, and is opted in.
 * Ordered by id so a resumed send makes the same batches.
 */
export async function resolveAudience(a: CampaignAudience, limit?: number): Promise<AudienceMember[]> {
  const db = await getDb();
  const client = clientConditions(a);
  const matched = (col: "id" | "name") =>
    client.length ? sql<string | null>`(select c.${sql.raw(col)} from ${clientOf(client)} order by (c.person_id = ${people.id}) desc, c.updated_at desc limit 1)` : sql<string | null>`null`;
  const q = db
    .select({
      id: people.id,
      email: sql<string>`${people.email}`,
      firstName: people.firstName,
      lastName: people.lastName,
      title: people.title,
      organizationId: people.organizationId,
      organizationName: organizations.name,
      ownerName: schema.users.name,
      custom: people.custom,
      clientId: matched("id"),
      clientName: matched("name"),
    })
    .from(people)
    .leftJoin(organizations, eq(organizations.id, people.organizationId))
    .leftJoin(schema.users, eq(schema.users.id, people.ownerId))
    .where(and(...audienceWhere(a)))
    .orderBy(people.id);
  return limit ? q.limit(limit) : q;
}

export async function audienceCount(a: CampaignAudience) {
  const db = await getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(people)
    .where(and(...audienceWhere(a)));
  return row.n;
}

/** The email of whoever set the campaign up, which is where its replies go unless it names another address. */
export async function campaignCreatorEmail(createdBy: string | null) {
  if (!createdBy) return null;
  const db = await getDb();
  const [u] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, createdBy));
  return u?.email ?? null;
}

/** Where a campaign's replies go: its own reply-to, else its creator. With neither (the creator was removed), replies go to the sending address. */
export async function campaignReplyTo(c: { replyTo: string | null; createdBy: string | null }) {
  return c.replyTo?.trim() || (await campaignCreatorEmail(c.createdBy)) || undefined;
}

/** A campaign's audience: its saved audience's filters as they are now, or its own. */
export async function campaignAudience(c: { audienceId: string | null; audience: CampaignAudience }) {
  if (!c.audienceId) return c.audience;
  const db = await getDb();
  const [saved] = await db.select({ filters: schema.audiences.filters }).from(schema.audiences).where(eq(schema.audiences.id, c.audienceId));
  return saved?.filters ?? c.audience;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Between single sends (campaigns with attachments), to stay under Resend's per-second request limit. */
const SINGLE_GAP_MS = 300;

/**
 * Sends a claimed campaign to everyone in its audience who hasn't had it yet.
 * Recipients already sent are skipped (unique campaign + person), every
 * request carries an idempotency key, and progress is recorded batch by
 * batch, so a retry after a timeout or crash never double-sends.
 *
 * Without attachments, each group of 100 goes in one call to Resend's batch
 * endpoint. That endpoint can't carry files, so a campaign with attachments
 * sends the same groups one email at a time, which takes longer.
 *
 * Each email is also logged as an email activity on the person (and their
 * organization, and the client they matched), so it's on their timeline.
 * Campaign emails don't count as contact: "last activity" doesn't move.
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

  const audience = await resolveAudience(await campaignAudience(c));
  const done = new Set((await db.select({ id: outboundEmails.personId }).from(outboundEmails).where(eq(outboundEmails.campaignId, c.id))).map((r) => r.id));
  const pending = audience.filter((p) => !done.has(p.id));
  const resend = getResend();
  const from = brand.senderName ? fromAs(brand.senderName) : emailFrom;
  const replyTo = await campaignReplyTo(c);
  // Read once: the same files go to everyone.
  const files = pending.length ? await loadAttachments(c.attachments) : [];
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
          values,
          payload: {
            from,
            replyTo,
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
    if (resend && !files.length) {
      if (i > 0) await sleep(250); // stay well under Resend's per-second request limit
      const { data, error } = await resend.batch.send(
        messages.map((m) => m.payload),
        { idempotencyKey: `campaign-${c.id}-${chunk[0].id}-${chunk.length}` },
      );
      if (error) throw new Error(`Resend: ${error.message}`);
      ids = data?.data?.map((d) => d.id) ?? ids;
    } else if (resend) {
      for (const [j, m] of messages.entries()) {
        if (i > 0 || j > 0) await sleep(SINGLE_GAP_MS);
        const { data, error } = await resend.emails.send({ ...m.payload, attachments: files }, { idempotencyKey: `campaign-${c.id}-${m.person.id}` });
        if (error) throw new Error(`Resend: ${error.message}`);
        ids[j] = data?.id ?? null;
      }
    } else {
      for (const m of messages) console.info(`[email:dev] campaign "${m.payload.subject}" → ${m.payload.to}${files.length ? ` (+${files.length} attachments)` : ""}`);
    }

    const now = new Date();
    const inserted = await db
      .insert(outboundEmails)
      .values(
        messages.map((m, j) => ({
          personId: m.person.id,
          clientId: m.person.clientId,
          campaignId: c.id,
          to: m.person.email,
          replyTo: replyTo ?? null,
          subject: m.payload.subject,
          attachments: c.attachments,
          resendId: ids[j],
          userId: c.createdBy,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: outboundEmails.id, personId: outboundEmails.personId });
    const byPerson = new Map(messages.map((m) => [m.person.id, m]));
    if (inserted.length) {
      await db.insert(schema.activities).values(
        inserted.map((row) => {
          const m = byPerson.get(row.personId!)!;
          return {
            type: "email" as const,
            direction: "outbound" as const,
            subject: m.payload.subject,
            // What they read, without the layout. The unsubscribe link is theirs alone, so it isn't kept.
            body: fillMergeTagsHtml(c.body, m.values).replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, "#"),
            occurredAt: now,
            userId: c.createdBy,
            emailId: row.id,
            personId: m.person.id,
            organizationId: m.person.organizationId,
            clientId: m.person.clientId,
          };
        }),
      );
    }
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

