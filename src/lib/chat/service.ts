import "server-only";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { actorUserId, assertCan, can, type Actor } from "@/lib/crm/actor";
import { onAnyRecord } from "@/lib/crm/files";
import { mentionedTeammates } from "@/lib/crm/mentions";
import { removeStoredBytes } from "@/lib/crm/service/files";
import { ActionError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { mentionsAgent } from "@/lib/agent/run-rules";
import { likeTerm } from "@/lib/crm/records";
import { emailMentioned } from "@/lib/notifications/mentions";
import { notifyEach, type Notice } from "@/lib/push/notify";
import { chatTargets } from "@/lib/push/routing";
import { actorFullName } from "@/lib/push/triggers";
import type { AgentRunStatus } from "@/lib/constants";
import { getWorkspace } from "@/lib/workspace";
import { MAX_CHAT_FILES, MAX_CHAT_LENGTH } from "./format";
import { chatWindow } from "./window";

/**
 * The team chat: one thread for everyone who can sign in. Viewers can read
 * and post, but not attach files.
 * Messages are plain text; mentioning a teammate ("@Sam") sends them the
 * "Mentioned in team chat" push and email, and teammates who chose "Every team
 * chat message" hear about the rest. Attachments are ordinary files uploaded with
 * `origin: "chat"` and claimed by the message they're posted with.
 * Messages can also come through the API and MCP (a teammate's key or connected
 * app) and from the agent, which answers a message that mentions it ("@Agent")
 * with a reply here. Those carry the key (`api_key_id`), so they read "via Claude".
 */

const { chatMessages, files, users, apiKeys, agentRuns } = schema;
const parent = alias(chatMessages, "parent");

export type ChatFile = { id: string; name: string; size: number; contentType: string };
export type ChatMessage = {
  id: string;
  userId: string;
  body: string;
  mentions: string[];
  createdAt: Date;
  editedAt: Date | null;
  files: ChatFile[];
  /** The key or app it came through ("Claude"), and whether that's the teammate's agent. Null when they typed it. */
  via: { name: string; agent: boolean } | null;
  /** The message it answers, with the start of its text. */
  replyTo: { id: string; userId: string; body: string; deleted: boolean } | null;
  /** The background run this message handed to the agent, and how it's going. */
  agentRun: { id: string; status: AgentRunStatus } | null;
};
type MessageRow = Omit<ChatMessage, "files" | "via" | "replyTo" | "agentRun"> & {
  viaName: string | null;
  viaKind: string | null;
  replyToId: string | null;
  parentUserId: string | null;
  parentBody: string | null;
  parentDeleted: boolean | null;
  runId: string | null;
  runStatus: AgentRunStatus | null;
};

/** What every read of messages selects: the message, the key it came through, the message it answers and its run. */
const messageColumns = {
  id: chatMessages.id,
  userId: chatMessages.userId,
  body: chatMessages.body,
  mentions: chatMessages.mentions,
  createdAt: chatMessages.createdAt,
  editedAt: chatMessages.editedAt,
  viaName: apiKeys.name,
  viaKind: apiKeys.kind,
  replyToId: chatMessages.replyToId,
  parentUserId: parent.userId,
  parentBody: sql<string | null>`left(${parent.body}, 200)`,
  parentDeleted: sql<boolean | null>`${parent.deletedAt} is not null`,
  runId: agentRuns.id,
  runStatus: agentRuns.status,
};

type Db = Awaited<ReturnType<typeof getDb>>;

/** chat_messages with the key it came through, the message it answers and its run: what messageColumns reads. */
function selectMessages<E extends Record<string, SQL>>(db: Db, extra: E = {} as E) {
  return db
    .select({ ...messageColumns, ...extra })
    .from(chatMessages)
    .leftJoin(apiKeys, eq(apiKeys.id, chatMessages.apiKeyId))
    .leftJoin(parent, eq(parent.id, chatMessages.replyToId))
    .leftJoin(agentRuns, eq(agentRuns.id, chatMessages.agentRunId));
}

function shape(r: MessageRow): Omit<ChatMessage, "files"> {
  return {
    id: r.id,
    userId: r.userId,
    body: r.body,
    mentions: r.mentions,
    createdAt: r.createdAt,
    editedAt: r.editedAt,
    via: r.viaName ? { name: r.viaName, agent: r.viaKind === "assistant" } : null,
    replyTo: r.replyToId && r.parentUserId ? { id: r.replyToId, userId: r.parentUserId, body: r.parentDeleted ? "" : (r.parentBody ?? ""), deleted: !!r.parentDeleted } : null,
    agentRun: r.runId && r.runStatus ? { id: r.runId, status: r.runStatus } : null,
  };
}

const PAGE = 80;

/** Microseconds since the epoch, as a string: the same unit as the live versions (src/lib/live.ts). */
const microseconds = (col: typeof chatMessages.updatedAt) => sql<string>`(extract(epoch from ${col}) * 1000000)::bigint::text`;

/**
 * One page of messages, oldest first. `before` (a message id) pages back from it; without it, the newest.
 * `version` is the chat's newest change when this was read, from the same statement as the messages:
 * `chatChangesSince` picks up from it, so nothing posted meanwhile is skipped.
 */
export async function listChat(o: { before?: string | null; limit?: number } = {}): Promise<{ messages: ChatMessage[]; hasMore: boolean; version: string }> {
  const db = await getDb();
  const limit = Math.min(o.limit ?? PAGE, 200);
  let cursor: { createdAt: Date; id: string } | undefined;
  if (o.before) {
    [cursor] = await db.select({ createdAt: chatMessages.createdAt, id: chatMessages.id }).from(chatMessages).where(eq(chatMessages.id, z.uuid().parse(o.before)));
    if (!cursor) return { messages: [], hasMore: false, version: "0" };
  }
  const rows = await selectMessages(db, { version: sql<string>`(select coalesce((extract(epoch from max(c.updated_at)) * 1000000)::bigint, 0)::text from chat_messages c)` })
    .where(and(isNull(chatMessages.deletedAt), cursor ? or(lt(chatMessages.createdAt, cursor.createdAt), and(eq(chatMessages.createdAt, cursor.createdAt), lt(chatMessages.id, cursor.id))) : undefined))
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit).reverse();
  const withFiles = await attachFiles(page.map((r) => shape(r as MessageRow)));
  return { messages: withFiles, hasMore: rows.length > limit, version: (rows[0]?.version as string | undefined) ?? (await chatVersion()) };
}

async function chatVersion() {
  const db = await getDb();
  const [row] = await db.select({ v: sql<string>`coalesce((extract(epoch from max(${chatMessages.updatedAt})) * 1000000)::bigint, 0)::text` }).from(chatMessages);
  return row?.v ?? "0";
}

async function attachFiles<M extends Omit<ChatMessage, "files">>(page: M[]): Promise<(M & { files: ChatFile[] })[]> {
  const db = await getDb();
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
  return page.map((m) => ({ ...m, files: attached.filter((f) => f.messageId === m.id).map((f) => ({ id: f.id, name: f.name, size: f.size, contentType: f.contentType })) }));
}

/**
 * Messages posted, edited or deleted since `since` (a chat version from
 * `listChat` or an earlier call), oldest change first, and the version to
 * ask from next time. Deleted ones come back with `deleted` so the page can
 * drop them. Lets the open chat follow along without re-rendering the page.
 */
export async function chatChangesSince(since: string, limit = 200): Promise<{ changes: (ChatMessage & { deleted: boolean })[]; version: string; more: boolean }> {
  const db = await getDb();
  const from = z.string().regex(/^\d{1,19}$/).parse(since);
  const rows = await selectMessages(db, { deleted: sql<boolean>`${chatMessages.deletedAt} is not null`, version: microseconds(chatMessages.updatedAt) })
    // Integer microseconds, so the cursor is exact.
    .where(sql`${chatMessages.updatedAt} > 'epoch'::timestamptz + ${from}::bigint * interval '1 microsecond'`)
    .orderBy(asc(chatMessages.updatedAt))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const withFiles = await attachFiles(page.map((r) => ({ ...shape(r as MessageRow), deleted: r.deleted as boolean })));
  // `more`: there's another page after this one; ask again from `version`.
  return { changes: withFiles, version: (page.at(-1)?.version as string | undefined) ?? from, more: rows.length > limit };
}

// ─── Reading for the API and MCP ─────────────────────────────────────────

export type ChatQuery = {
  /** Messages posted at or after this time (or date, in the workspace time zone). Defaults to DEFAULT_CHAT_DAYS ago. */
  from?: string;
  /** Messages posted at or before this time. Defaults to now. */
  to?: string;
  /** Only this teammate's messages (theirs, their keys' and their agent's). */
  userId?: string;
  /** Only messages that mention this teammate. */
  mentions?: string;
  /** Words in the message. */
  q?: string;
  /** newest (the default) or oldest first. */
  order?: "newest" | "oldest";
  limit?: number;
  cursor?: string;
};

const chatCursor = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });
const encodeChatCursor = (m: { createdAt: Date; id: string }) => Buffer.from(JSON.stringify({ createdAt: m.createdAt.toISOString(), id: m.id })).toString("base64url");
function decodeChatCursor(cursor: string) {
  try {
    return chatCursor.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new ActionError("That cursor isn't valid. Start again from the first page.");
  }
}

/**
 * Messages in a time window, for the API and MCP: the last 30 days unless
 * `from` / `to` say otherwise, newest first unless `order` is oldest, with
 * who posted each one, what it mentions, its files and what it answers.
 * Deleted messages are left out. Keyset-paged by (created_at, id).
 */
export async function queryChat(a: Actor, q: ChatQuery = {}) {
  assertCan(a, "records:read");
  const db = await getDb();
  const { from, to } = chatWindow(q, (await getWorkspace()).timezone);
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const newest = (q.order ?? "newest") === "newest";
  const c = q.cursor ? decodeChatCursor(q.cursor) : null;
  const where = [
    isNull(chatMessages.deletedAt),
    gte(chatMessages.createdAt, from),
    lte(chatMessages.createdAt, to),
    q.userId ? eq(chatMessages.userId, z.uuid("Pass a teammate id from GET /users.").parse(q.userId)) : undefined,
    q.mentions ? sql`${z.uuid("Pass a teammate id from GET /users.").parse(q.mentions)}::uuid = any(${chatMessages.mentions})` : undefined,
    q.q?.trim() ? ilike(chatMessages.body, likeTerm(q.q.trim())) : undefined,
    c
      ? newest
        ? sql`(${chatMessages.createdAt}, ${chatMessages.id}) < (${c.createdAt}::timestamptz, ${c.id}::uuid)`
        : sql`(${chatMessages.createdAt}, ${chatMessages.id}) > (${c.createdAt}::timestamptz, ${c.id}::uuid)`
      : undefined,
  ];
  const rows = await selectMessages(db)
    .where(and(...where))
    .orderBy(newest ? desc(chatMessages.createdAt) : asc(chatMessages.createdAt), newest ? desc(chatMessages.id) : asc(chatMessages.id))
    .limit(limit + 1);
  const shown = rows.slice(0, limit);
  const messages = await attachFiles(shown.map((r) => shape(r as MessageRow)));
  const last = shown.at(-1);
  return { messages, from, to, nextCursor: rows.length > limit && last ? encodeChatCursor(last) : null };
}

/** One message, with the same details as queryChat. */
export async function getChatMessage(a: Actor, id: string) {
  assertCan(a, "records:read");
  const db = await getDb();
  const [row] = await selectMessages(db).where(and(eq(chatMessages.id, z.uuid().parse(id)), isNull(chatMessages.deletedAt)));
  if (!row) throw new NotFoundError("There's no team chat message with that id. It may have been deleted.");
  const [m] = await attachFiles([shape(row as MessageRow)]);
  return m;
}

// ─── Posting ─────────────────────────────────────────────────────────────

const bodyInput = z.string().max(MAX_CHAT_LENGTH, `Keep messages under ${MAX_CHAT_LENGTH.toLocaleString()} characters.`);

function chatUser(a: Actor) {
  const id = actorUserId(a);
  if (!id || a.kind !== "user") throw new ForbiddenError("Only teammates can post in the team chat. Use a personal key or a connected app, not a workspace key.");
  if (a.readOnly) throw new ForbiddenError("This key or connected app is read-only. Reconnect it with edit access to post in the team chat.");
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
 * A new message: teammates it mentions hear "mentioned you" (push, and an
 * email unless they turned it off), and everyone who wants every message hears
 * the rest. An edit only tells the teammates it newly mentions.
 */
function tellTeam(a: Actor, messageId: string, text: string, mentioned: string[], o: { files?: number; everyone?: boolean } = {}) {
  const who = a.kind === "user" ? a.user.name.split(" ")[0] : a.keyName;
  const body = text.replace(/\s+/g, " ").trim().slice(0, 140) || (o.files ? (o.files === 1 ? "Sent a file." : `Sent ${o.files} files.`) : "Open the chat to read it.");
  const path = `/chat#m-${messageId}`;
  const base = { body, url: path, dedupeKey: `chat:${messageId}` };
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
  emailMentioned(
    mentioned,
    async () => {
      const author = await actorFullName(a);
      return {
        kind: "chat",
        who: author,
        title: `${author} mentioned you in team chat`,
        text: text || body,
        path,
        action: "Open the message",
        dedupeKey: `chat:${messageId}`,
      };
    },
    { except: actorUserId(a) },
  );
}

export type PostInput = { body: string; fileIds?: string[]; replyToId?: string | null };

/**
 * Posts a message, with any files the poster just uploaded for it. Text, files or both.
 * From a teammate in the browser, a message that mentions the agent ("@Agent") hands it
 * the request: it answers with a reply here. Messages that come through a key, a
 * connected app or the agent itself never call on it (`handOff`), whatever they say.
 */
export async function postChatMessage(a: Actor, input: PostInput, opts: { handOff?: boolean } = {}) {
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
  const replyToId = input.replyToId ? z.uuid().parse(input.replyToId) : null;
  if (replyToId) await loadMessage(replyToId);
  // Only the poster's own chat uploads that no message has claimed yet.
  const own = fileIds.length
    ? await db
        .select({ id: files.id })
        .from(files)
        .where(and(inArray(files.id, fileIds), eq(files.uploadedBy, user.id), eq(files.origin, "chat"), isNull(files.chatMessageId), isNull(files.deletedAt)))
    : [];
  if (own.length !== fileIds.length) throw new ActionError("One of those files was already posted or removed. Attach it again.");
  const mentions = await mentionsIn(body);
  const [row] = await db.insert(chatMessages).values({ userId: user.id, body, mentions, apiKeyId: a.keyId, replyToId }).returning({ id: chatMessages.id, createdAt: chatMessages.createdAt });
  // Claimed only while still unclaimed, so a double-submitted message can't take another's files.
  if (fileIds.length) await db.update(files).set({ chatMessageId: row.id }).where(and(inArray(files.id, fileIds), isNull(files.chatMessageId)));
  // Typed in the chat: they've seen it up to here. A key, an app or the agent posting for them doesn't mean they have.
  if (!a.keyId) await db.update(users).set({ chatReadAt: row.createdAt }).where(eq(users.id, user.id));
  tellTeam(a, row.id, body, mentions, { files: fileIds.length, everyone: true });
  if (opts.handOff !== false && callsOnAgent(a, body)) {
    const { handOffChat } = await import("@/lib/agent/handoff");
    await handOffChat(a, { id: row.id, body, createdAt: row.createdAt, replyToId });
  }
  return row;
}

/** Whether a message calls on the agent: typed by a teammate in the browser (not a key, an app or the agent) and saying "@Agent". */
export const callsOnAgent = (a: Actor, body: string) => a.kind === "user" && !a.keyId && !a.runId && mentionsAgent(body);

async function loadMessage(id: string) {
  const db = await getDb();
  const [m] = await db.select().from(chatMessages).where(eq(chatMessages.id, z.uuid().parse(id)));
  if (!m || m.deletedAt) throw new NotFoundError("That message was deleted.");
  return m;
}

/**
 * The messages before one, oldest first, for the agent to read as context when it's
 * called on: who wrote each and what they said. Deleted ones are left out.
 */
export async function messagesBefore(at: { id: string; createdAt: Date }, limit = 15) {
  const db = await getDb();
  const rows = await db
    .select({ id: chatMessages.id, body: chatMessages.body, createdAt: chatMessages.createdAt, name: users.name, viaName: apiKeys.name, viaKind: apiKeys.kind })
    .from(chatMessages)
    .innerJoin(users, eq(users.id, chatMessages.userId))
    .leftJoin(apiKeys, eq(apiKeys.id, chatMessages.apiKeyId))
    .where(and(isNull(chatMessages.deletedAt), or(lt(chatMessages.createdAt, at.createdAt), and(eq(chatMessages.createdAt, at.createdAt), lt(chatMessages.id, at.id)))))
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(limit);
  return rows.reverse();
}

/** Links a message to the run it handed to the agent; touching it lets open chats show "working". */
export async function linkAgentRun(messageId: string, runId: string) {
  const db = await getDb();
  await db.update(chatMessages).set({ agentRunId: runId }).where(eq(chatMessages.id, messageId));
}

/** The run's status changed: open chats re-read the message that asked, so its badge follows. */
export async function touchMessage(messageId: string) {
  const db = await getDb();
  await db.update(chatMessages).set({ updatedAt: new Date() }).where(eq(chatMessages.id, messageId));
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
  const readAt = new Date();
  await db.update(users).set({ chatReadAt: readAt }).where(eq(users.id, userId));
  return readAt;
}
