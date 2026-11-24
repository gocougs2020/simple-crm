import "server-only";
import { eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { actorUserId, type Actor } from "@/lib/crm/actor";
import type { ActivityType, ClientCategory } from "@/lib/constants";
import { emailMentioned } from "@/lib/notifications/mentions";
import { notify, notifyEach, type Notice } from "./notify";
import { activityTargets, activityVerb, noteTargets, stageTitle, type Owner } from "./routing";

/**
 * What notifies whom. Each function is called from the service that made the
 * change, so the browser, the API, MCP and the agent all notify the same
 * way. Nobody hears about a change they made themselves.
 */

const actorName = (a: Actor) => (a.kind === "user" ? a.user.name.split(" ")[0] : a.keyName);
type Links = { personId?: string | null; organizationId?: string | null; clientId?: string | null };
const recordUrl = (l: Links) => (l.clientId ? `/clients/${l.clientId}` : l.personId ? `/people/${l.personId}` : l.organizationId ? `/organizations/${l.organizationId}` : "/activities");

/** "Sam gave you a task": for a task, or a planned call or meeting, given to someone. */
function taskNotice(a: Actor, task: { id: string; subject: string | null; type: string; assigneeId: string } & Links): Notice {
  return {
    kind: "task_assigned",
    title: `${actorName(a)} gave you a ${task.type === "task" ? "task" : task.type}`,
    body: task.subject || "Open it to see the details.",
    url: recordUrl(task),
    // Per assignment, not per task and person: handing a task back to someone who had it before tells them again.
    // The minute stops a double-submitted form from notifying twice.
    dedupeKey: `task_assigned:${task.id}:${task.assigneeId}:${Math.floor(Date.now() / 60_000)}`,
  };
}

/** A task (or a planned call or meeting) reassigned to someone other than whoever made the change. New ones go through activityLogged. */
export function taskAssigned(a: Actor, task: { id: string; subject: string | null; type: string; assigneeId: string | null; completedAt?: Date | null } & Links) {
  if (!task.assigneeId || task.completedAt) return;
  notify([task.assigneeId], taskNotice(a, { ...task, assigneeId: task.assigneeId }), { except: actorUserId(a) });
}

const entityPath = { client: "clients", person: "people", organization: "organizations" } as const;

/** Someone made a teammate the owner of a client, person or organization. */
export function recordAssigned(a: Actor, record: { entity: keyof typeof entityPath; id: string; name: string; ownerId: string | null | undefined; previousOwnerId?: string | null }) {
  if (!record.ownerId || record.ownerId === record.previousOwnerId) return;
  notify(
    [record.ownerId],
    {
      kind: "record_assigned",
      title: `${actorName(a)} made you the owner of ${record.name}`,
      body: record.entity === "client" ? "A client is yours to look after now." : record.entity === "person" ? "This contact is yours now." : "This organization is yours now.",
      url: `/${entityPath[record.entity]}/${record.id}`,
      dedupeKey: `record_assigned:${record.id}:${record.ownerId}:${Date.now() - (Date.now() % 60_000)}`,
    },
    { except: actorUserId(a) },
  );
}

/** "Jane Doe <jane@acme.com>" → "Jane Doe". */
export const senderName = (from: string) => from.replace(/<[^>]*>/, "").replace(/"/g, "").trim() || from.replace(/[<>]/g, "").trim();

/**
 * Mail arrived in a connected inbox from someone linked to a record: tell the
 * record's owner (the client's, else the person's, else the organization's).
 */
export async function inboundEmail(message: { id: string; from: string; subject: string | null; sentAt: Date; threadId: string } & Links) {
  // A first sync of an inbox brings in old mail; only recent mail is news.
  if (Date.now() - message.sentAt.getTime() > 24 * 3600_000) return;
  const db = await getDb();
  const owner = async (table: typeof schema.clients | typeof schema.people | typeof schema.organizations, id: string | null | undefined) =>
    id ? ((await db.select({ ownerId: table.ownerId }).from(table).where(inArray(table.id, [id])))[0]?.ownerId ?? null) : null;
  const ownerId = (await owner(schema.clients, message.clientId)) ?? (await owner(schema.people, message.personId)) ?? (await owner(schema.organizations, message.organizationId));
  if (!ownerId) return;
  notify([ownerId], {
    kind: "inbound_email",
    title: `Email from ${senderName(message.from)}`,
    body: message.subject || "(no subject)",
    url: `/email?t=${message.threadId}`,
    dedupeKey: `inbound:${message.id}`,
  });
}

/**
 * Whoever owns each record an activity is on, with the name and page of the
 * record they own: its client, its contact, its organization, then the other
 * people on it (a meeting's other attendees, an email's other recipients).
 */
async function ownersOf(l: Links, people: string[] = []) {
  const db = await getDb();
  const [client] = l.clientId ? await db.select({ ownerId: schema.clients.ownerId, name: schema.clients.name }).from(schema.clients).where(eq(schema.clients.id, l.clientId)) : [];
  const [person] = l.personId
    ? await db.select({ ownerId: schema.people.ownerId, firstName: schema.people.firstName, lastName: schema.people.lastName }).from(schema.people).where(eq(schema.people.id, l.personId))
    : [];
  const [org] = l.organizationId ? await db.select({ ownerId: schema.organizations.ownerId, name: schema.organizations.name }).from(schema.organizations).where(eq(schema.organizations.id, l.organizationId)) : [];
  const found = [
    client && { userId: client.ownerId, name: client.name, url: `/clients/${l.clientId}` },
    person && { userId: person.ownerId, name: [person.firstName, person.lastName].filter(Boolean).join(" "), url: `/people/${l.personId}` },
    org && { userId: org.ownerId, name: org.name, url: `/organizations/${l.organizationId}` },
  ];
  const more = people.filter((id) => id !== l.personId);
  if (more.length) {
    const rows = await db
      .select({ id: schema.people.id, ownerId: schema.people.ownerId, firstName: schema.people.firstName, lastName: schema.people.lastName })
      .from(schema.people)
      .where(inArray(schema.people.id, more));
    for (const p of rows) found.push({ userId: p.ownerId, name: [p.firstName, p.lastName].filter(Boolean).join(" "), url: `/people/${p.id}` });
  }
  const owners: Owner[] = [];
  for (const o of found) if (o && o.userId && !owners.some((x) => x.userId === o.userId)) owners.push({ userId: o.userId, name: o.name, url: o.url });
  return owners;
}

const snippet = (text: string, fallback: string) => text.replace(/\s+/g, " ").trim().slice(0, 140) || fallback;

/**
 * A note or a reply was written. Teammates it mentions ("@Sam") hear first;
 * a reply also reaches whoever is already in the thread (the note's author
 * and everyone who replied); and the owners of the records it's on hear about
 * it too. Each of them gets one alert: the most specific one they want.
 */
export function noteWritten(a: Actor, note: { id: string; replyId?: string; people?: string[] } & Links, text: string, mentioned: string[], thread: (string | null)[] = []) {
  const who = actorName(a);
  const body = snippet(text, "Open it to read the note.");
  const url = noteUrl(note);
  const dedupeKey = `note:${note.replyId ?? note.id}`;
  notifyEach(async () => noteTargets({ who, body, url, dedupeKey, reply: !!note.replyId, mentioned, thread, owners: await ownersOf(note, note.people) }), {
    except: actorUserId(a),
  });
  // Mentioned teammates also get an email, with the note and a link to it.
  emailMentioned(
    mentioned,
    async () => {
      const [author, record] = await Promise.all([actorFullName(a), recordOf(note)]);
      return {
        kind: "note",
        who: author,
        title: `${author} mentioned you in ${note.replyId ? "a reply to a note" : "a note"}${record ? ` on ${record.name}` : ""}`,
        text,
        path: url,
        action: "Open the note",
        record,
        dedupeKey,
      };
    },
    { except: actorUserId(a) },
  );
}

/** A note on its record's timeline (the entry's anchor), or on the Activities page when it's on no record. */
export const noteUrl = (note: { id: string } & Links) => (note.clientId || note.personId || note.organizationId ? `${recordUrl(note)}#a-${note.id}` : "/activities");

/** "Sam Lee", or "Sam Lee via Agent" when it came through a key or the agent. */
export async function actorFullName(a: Actor) {
  if (a.kind !== "user") return a.keyName;
  if (!a.keyId) return a.user.name;
  const db = await getDb();
  const [key] = await db.select({ name: schema.apiKeys.name }).from(schema.apiKeys).where(eq(schema.apiKeys.id, a.keyId));
  return key ? `${a.user.name} via ${key.name}` : a.user.name;
}

/** The record a note is on, for the email: its client, else its person, else its organization. */
async function recordOf(l: Links): Promise<{ name: string; kind: string; path: string } | null> {
  const db = await getDb();
  if (l.clientId) {
    const [c] = await db.select({ name: schema.clients.name }).from(schema.clients).where(eq(schema.clients.id, l.clientId));
    if (c) return { name: c.name, kind: "client", path: `/clients/${l.clientId}` };
  }
  if (l.personId) {
    const [p] = await db.select({ first: schema.people.firstName, last: schema.people.lastName }).from(schema.people).where(eq(schema.people.id, l.personId));
    if (p) return { name: [p.first, p.last].filter(Boolean).join(" "), kind: "person", path: `/people/${l.personId}` };
  }
  if (l.organizationId) {
    const [o] = await db.select({ name: schema.organizations.name }).from(schema.organizations).where(eq(schema.organizations.id, l.organizationId));
    if (o) return { name: o.name, kind: "organization", path: `/organizations/${l.organizationId}` };
  }
  return null;
}

/**
 * An activity was logged or planned. An open one tells its assignee "gave you
 * a task"; a call, email, text, meeting or task also tells the owners of the
 * records it's on (notes go through noteWritten). An assignee who owns the
 * record hears once: the task if their device wants it, else the activity.
 */
export function activityLogged(a: Actor, activity: { id: string; type: ActivityType; subject: string | null; text: string; done: boolean; assigneeId: string | null; people?: string[] } & Links) {
  const task = !activity.done && activity.assigneeId ? taskNotice(a, { ...activity, assigneeId: activity.assigneeId }) : null;
  if (!task && activity.type === "note") return;
  const who = actorName(a);
  const verb = activityVerb(activity.type, activity.done);
  const body = activity.subject?.trim() || snippet(activity.text, "Open it to see the details.");
  notifyEach(
    async () =>
      activityTargets({
        assigneeId: activity.assigneeId,
        task,
        owners: activity.type === "note" ? [] : await ownersOf(activity, activity.people),
        owned: (o, dedupeKey) => ({ kind: "owned_activity", title: `${who} ${verb} on ${o.name}`, body, url: o.url, dedupeKey: dedupeKey ?? `activity:${activity.id}` }),
      }),
    { except: actorUserId(a) },
  );
}

/** Someone else moved a client to another stage, or into another category (signed, lost, won back). Its owner hears. */
export function clientStageChanged(a: Actor, client: { id: string; name: string; ownerId: string | null; stage: string; category?: ClientCategory }) {
  if (!client.ownerId) return;
  notify(
    [client.ownerId],
    {
      kind: "client_stage",
      title: stageTitle(actorName(a), client.name, client.stage, client.category),
      body: client.category ? `Now in ${client.stage}.` : "Open the client to see where it stands.",
      url: `/clients/${client.id}`,
      // Per stage, per minute: dragging a card back and forth sends one per stage it lands on, not a flood.
      dedupeKey: `client_stage:${client.id}:${client.stage}:${Math.floor(Date.now() / 60_000)}`,
    },
    { except: actorUserId(a) },
  );
}
