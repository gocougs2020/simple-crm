import "server-only";
import { and, asc, count, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { actorUserId, assertCan, can, type Actor } from "@/lib/crm/actor";
import { onAnyRecord } from "@/lib/crm/files";
import { mentionedTeammates } from "@/lib/crm/mentions";
import { removeStoredBytes } from "@/lib/crm/service/files";
import { ActionError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { notifyEach, type Notice } from "@/lib/push/notify";
import { chatTargets } from "@/lib/push/routing";
import { MAX_CHAT_FILES, MAX_CHAT_LENGTH } from "./format";

/**
 * The team chat: one thread for everyone who can sign in. Viewers can read
 * and post, but not attach files.
 * Messages are plain text; mentioning a teammate ("@Sam") sends them the
 * "Mentioned in team chat" push, and teammates who chose "Every team chat
 * message" hear about the rest. Attachments are ordinary files uploaded with
 * `origin: "chat"` and claimed by the message they're posted with.
 */

const { chatMessages, files, users } = schema;

export type ChatFile = { id: string; name: string; size: number; contentType: string };
export type ChatMessage = { id: string; userId: string; body: string; mentions: string[]; createdAt: Date; editedAt: Date | null; files: ChatFile[] };

const PAGE = 80;

/** One page of messages, oldest first. `before` (a message id) pages back from it; without it, the newest. */
export async function listChat(o: { before?: string | null; limit?: number } = {}): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
  const db = await getDb();
  const limit = Math.min(o.limit ?? PAGE, 200);
  let cursor: { createdAt: Date; id: string } | undefined;
  if (o.before) {
    [cursor] = await db.select({ createdAt: chatMessages.createdAt, id: chatMessages.id }).from(chatMessages).where(eq(chatMessages.id, z.uuid().parse(o.before)));
    if (!cursor) return { messages: [], hasMore: false };
  }
  const rows = await db
    .select({ id: chatMessages.id, userId: chatMessages.userId, body: chatMessages.body, mentions: chatMessages.mentions, createdAt: chatMessages.createdAt, editedAt: chatMessages.editedAt })
    .from(chatMessages)
    .where(and(isNull(chatMessages.deletedAt), cursor ? or(lt(chatMessages.createdAt, cursor.createdAt), and(eq(chatMessages.createdAt, cursor.createdAt), lt(chatMessages.id, cursor.id))) : undefined))
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit).reverse();
  const attached = page.length
    ? await db
        .select({ id: files.id, name: files.name, size: files.size, contentType: files.contentType, messageId: files.chatMessageId })
        .from(files)
        .where(
          and(
            inArray(
              files.chatMessageId,
              page.map((m) => m.id),
            ),
            isNull(files.deletedAt),
          ),
        )
        .orderBy(asc(files.createdAt))
    : [];
  return {
    messages: page.map((m) => ({ ...m, files: attached.filter((f) => f.messageId === m.id).map((f) => ({ id: f.id, name: f.name, size: f.size, contentType: f.contentType })) })),
    hasMore: rows.length > limit,
  };
}

const bodyInput = z.string().max(MAX_CHAT_LENGTH, `Keep messages under ${MAX_CHAT_LENGTH.toLocaleString()} characters.`);

function chatUser(a: Actor) {
  const id = actorUserId(a);
  if (!id || a.kind !== "user") throw new ForbiddenError("Only teammates can post in the team chat.");
  if (a.readOnly) throw new ForbiddenError("This key or connected app is read-only.");
  return a.user;
}

async function mentionsIn(text: string) {
  const db = await getDb();
  const team = await db.select({ id: users.id, name: users.name, deactivatedAt: users.deactivatedAt, passwordHash: users.passwordHash }).from(users);
  return mentionedTeammates(
    text,
    team.map((u) => ({ id: u.id, name: u.name, active: !u.deactivatedAt && !!u.passwordHash })),
  );
}

/**
 * A new message: teammates it mentions hear "mentioned you", and everyone who
 * wants every message hears the rest. An edit only tells the teammates it
 * newly mentions.
 */
function tellTeam(a: Actor, messageId: string, text: string, mentioned: string[], o: { files?: number; everyone?: boolean } = {}) {
  const who = a.kind === "user" ? a.user.name.split(" ")[0] : a.keyName;
  const body = text.replace(/\s+/g, " ").trim().slice(0, 140) || (o.files ? (o.files === 1 ? "Sent a file." : `Sent ${o.files} files.`) : "Open the chat to read it.");
  const base = { body, url: `/chat#m-${messageId}`, dedupeKey: `chat:${messageId}` };
  const mention: Notice = { kind: "chat_mention", title: `${who} mentioned you in team chat`, ...base };
  const message: Notice = { kind: "chat_message", title: `${who} in team chat`, ...base };
  notifyEach(
    async () => {
      if (!o.everyone) return mentioned.map((userId) => ({ userId, notices: [mention] }));
      // Only teammates with a device that wants every message: no point asking about the others.
      const db = await getDb();
      const listeners = await db
        .selectDistinct({ userId: schema.pushSubscriptions.userId })
        .from(schema.pushSubscriptions)
        .where(sql`${schema.pushSubscriptions.alerts} @> ${JSON.stringify(["chat_message"])}::jsonb`);
      return chatTargets(
        mentioned,
        listeners.map((l) => l.userId),
        { mention, message },
      );
    },
    { except: actorUserId(a) },
  );
}

/** Posts a message, with any files the poster just uploaded for it. Text, files or both. */
export async function postChatMessage(a: Actor, input: { body: string; fileIds?: string[] }) {
  const user = chatUser(a);
  const body = bodyInput.parse(input.body ?? "").trim();
  const fileIds = z
    .array(z.uuid())
    .max(MAX_CHAT_FILES, `Attach ${MAX_CHAT_FILES} files at most to one message.`)
    .parse(input.fileIds ?? []);
  if (!body && !fileIds.length) throw new ActionError("Write a message or attach a file.");
  // Viewers can post, but not add files.
  if (fileIds.length) assertCan(a, "records:write");
  const db = await getDb();
  // Only the poster's own chat uploads that no message has claimed yet.
  const own = fileIds.length
    ? await db
        .select({ id: files.id })
        .from(files)
        .where(and(inArray(files.id, fileIds), eq(files.uploadedBy, user.id), eq(files.origin, "chat"), isNull(files.chatMessageId), isNull(files.deletedAt)))
    : [];
  if (own.length !== fileIds.length) throw new ActionError("One of those files was already posted or removed. Attach it again.");
  const mentions = await mentionsIn(body);
  const [row] = await db.insert(chatMessages).values({ userId: user.id, body, mentions }).returning({ id: chatMessages.id, createdAt: chatMessages.createdAt });
  // Claimed only while still unclaimed, so a double-submitted message can't take another's files.
  if (fileIds.length) await db.update(files).set({ chatMessageId: row.id }).where(and(inArray(files.id, fileIds), isNull(files.chatMessageId)));
  await db.update(users).set({ chatReadAt: row.createdAt }).where(eq(users.id, user.id));
  tellTeam(a, row.id, body, mentions, { files: fileIds.length, everyone: true });
  return row;
}

async function loadMessage(id: string) {
  const db = await getDb();
  const [m] = await db.select().from(chatMessages).where(eq(chatMessages.id, z.uuid().parse(id)));
  if (!m || m.deletedAt) throw new NotFoundError("That message was deleted.");
  return m;
}

/** Edits a message's text. Only whoever posted it can. Teammates it newly mentions hear about it. */
export async function editChatMessage(a: Actor, messageId: string, input: { body: string }) {
  const user = chatUser(a);
  const m = await loadMessage(messageId);
  if (m.userId !== user.id) throw new ForbiddenError("You can only edit your own messages.");
  const body = bodyInput.parse(input.body ?? "").trim();
  const db = await getDb();
  const [{ n }] = await db.select({ n: count() }).from(files).where(and(eq(files.chatMessageId, m.id), isNull(files.deletedAt)));
  if (!body && !n) throw new ActionError("A message needs some text. Delete it instead.");
  if (body === m.body) return;
  const mentions = await mentionsIn(body);
  await db.update(chatMessages).set({ body, mentions, editedAt: new Date() }).where(eq(chatMessages.id, m.id));
  tellTeam(
    a,
    m.id,
    body,
    mentions.filter((id) => !m.mentions.includes(id)),
  );
}

/**
 * Deletes a message: whoever posted it, or an admin. Its files go too, unless
 * someone has since put them in a folder, attached them to a record or made
 * them public; those stay in Files.
 */
export async function deleteChatMessage(a: Actor, messageId: string) {
  const user = chatUser(a);
  const m = await loadMessage(messageId);
  if (m.userId !== user.id && !can(a, "activities:moderate")) throw new ForbiddenError("You can delete your own messages. Ask an admin to delete this one.");
  const db = await getDb();
  await db.update(chatMessages).set({ body: "", mentions: [], deletedAt: new Date() }).where(eq(chatMessages.id, m.id));
  const gone = await db
    .update(files)
    .set({ deletedAt: new Date() })
    .where(and(eq(files.chatMessageId, m.id), isNull(files.deletedAt), isNull(files.folderId), isNull(files.publicToken), sql`not ${onAnyRecord}`))
    .returning({ url: files.url });
  await db.update(files).set({ chatMessageId: null, origin: null }).where(eq(files.chatMessageId, m.id));
  await removeStoredBytes(gone.map((f) => f.url));
}

/** The teammate has seen the chat up to now. */
export async function markChatRead(userId: string) {
  const db = await getDb();
  await db.update(users).set({ chatReadAt: new Date() }).where(eq(users.id, userId));
}

