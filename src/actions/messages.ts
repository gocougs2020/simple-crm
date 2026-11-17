"use server";

import { refresh } from "next/cache";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { run, type Result } from "@/lib/action";
import { ActionError, actionEditor, actionUser } from "@/lib/auth";
import { assertCanChangeRead } from "@/lib/conversations/read-state";
import { hasPhone, linksForPhone } from "@/lib/crm/match";
import { siteOrigin } from "@/lib/origin";
import { assertNumberAccess } from "@/lib/twilio/access";
import { phoneConfigured } from "@/lib/twilio/config";
import { logSentText, sendText } from "@/lib/twilio/texts";
import { adoptThread } from "@/lib/twilio/threads";

/**
 * The Messages page: text conversations, read and answered in one place.
 * Whether a conversation is read belongs to whoever owns its record
 * (src/lib/conversations/read-rules.ts).
 */

const { textThreads, people } = schema;
const uuid = z.uuid();

async function threadOrThrow(threadId: string) {
  const db = await getDb();
  const [t] = await db.select().from(textThreads).where(eq(textThreads.id, uuid.parse(threadId)));
  if (!t) throw new ActionError("This conversation is gone. Reload the page to see the latest.");
  return t;
}

/**
 * Opening a conversation: it's read now if it's this teammate's to read (or
 * nobody's), and a number someone has since added to the CRM moves onto that
 * record. Opening someone else's conversation changes nothing for them.
 */
export async function openTextThread(threadId: string): Promise<Result<{ markedRead: boolean }>> {
  return run(async () => {
    const user = await actionUser();
    const t = await threadOrThrow(threadId);
    let changed = false;
    if (!t.personId && !t.organizationId) {
      const links = await linksForPhone(t.remote);
      if (links.personId || links.organizationId) {
        await adoptThread(t.id, { personId: links.personId, organizationId: links.organizationId, clientId: links.clientId });
        changed = true;
      }
    }
    const fresh = changed ? await threadOrThrow(t.id) : t;
    let markedRead = false;
    if (!fresh.read) {
      const state = await assertCanChangeRead(fresh, user.id).catch(() => null);
      if (state) {
        const db = await getDb();
        // Conditional, so two teammates opening it at once both see it read without a second write.
        const done = await db.update(textThreads).set({ read: true, updatedAt: new Date() }).where(and(eq(textThreads.id, t.id), eq(textThreads.read, false))).returning({ id: textThreads.id });
        markedRead = done.length > 0;
      }
    }
    if (changed || markedRead) refresh();
    return { markedRead };
  });
}

/** Marks a conversation read or unread, for whoever's unread it is. */
export async function markTextThreadRead(threadId: string, read: boolean): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const value = z.boolean().parse(read);
    const t = await threadOrThrow(threadId);
    await assertCanChangeRead(t, user.id);
    if (t.read === value) return;
    const db = await getDb();
    await db.update(textThreads).set({ read: value, updatedAt: new Date() }).where(eq(textThreads.id, t.id));
    refresh();
  });
}

const replyInput = z.object({ body: z.string().trim().min(1, "Write the text first.").max(1600, "Texts can be up to 1,600 characters.") });

/**
 * Texts back from the number the conversation is on. It goes on the linked
 * record's timeline like any text, and answering it counts as reading it
 * when it's yours to read.
 */
export async function replyToTextThread(threadId: string, input: z.input<typeof replyInput>): Promise<Result> {
  return run(async () => {
    const user = await actionEditor();
    if (!phoneConfigured()) throw new ActionError("Texting isn't set up on this deployment. An admin can add a Twilio account (docs/PHONE.md).");
    const data = replyInput.parse(input);
    const t = await threadOrThrow(threadId);
    if (!t.phoneNumberId) throw new ActionError("The number this conversation was on was deleted. Text them from their record with another number.");
    const number = await assertNumberAccess(user, t.phoneNumberId);
    const db = await getDb();
    // STOP marks everyone with the number (main or other), so any of them having opted out means this number did; so does the linked person having opted out.
    const [stopped] = await db
      .select({ firstName: people.firstName })
      .from(people)
      .where(
        and(
          sql`${people.textOptOutAt} is not null`,
          or(and(hasPhone(t.remoteKey), isNull(people.archivedAt)), t.personId ? eq(people.id, t.personId) : undefined),
        ),
      )
      .limit(1);
    if (stopped) throw new ActionError(`${stopped.firstName} replied STOP, so texts to this number are blocked. They can reply START to opt back in.`);
    const links = { personId: t.personId, organizationId: t.organizationId, clientId: t.clientId };
    const result = await sendText({ number, to: t.remote, body: data.body, userId: user.id, links, origin: await siteOrigin() });
    if (!result.row) throw new ActionError("The text didn't send. Try again.");
    // A number nobody in the CRM has gets no timeline entry: there's no record to put it on.
    if (result.sent && (links.personId || links.organizationId)) await logSentText(result.row);
    if (!t.read) {
      const state = await assertCanChangeRead(t, user.id).catch(() => null);
      if (state) await db.update(textThreads).set({ read: true, updatedAt: new Date() }).where(eq(textThreads.id, t.id));
    }
    refresh();
    if (!result.sent) throw new ActionError(result.error ?? "The text didn't send.");
  });
}
