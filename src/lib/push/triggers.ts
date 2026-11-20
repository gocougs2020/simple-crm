import "server-only";
import { eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { actorUserId, type Actor } from "@/lib/crm/actor";
import type { ActivityType, ClientCategory } from "@/lib/constants";
import { notify, notifyEach } from "./notify";
import { activityVerb, noteTargets, stageTitle, type Owner } from "./routing";

/**
 * What notifies whom. Each function is called from the service that made the
 * change, so the browser, the API, MCP and the agent all notify the same
 * way. Nobody hears about a change they made themselves.
 */

const actorName = (a: Actor) => (a.kind === "user" ? a.user.name.split(" ")[0] : a.keyName);
type Links = { personId?: string | null; organizationId?: string | null; clientId?: string | null };
const recordUrl = (l: Links) => (l.clientId ? `/clients/${l.clientId}` : l.personId ? `/people/${l.personId}` : l.organizationId ? `/organizations/${l.organizationId}` : "/activities");

/** A task (or a planned call or meeting) given to someone other than whoever made the change. */
export function taskAssigned(a: Actor, task: { id: string; subject: string | null; type: string; assigneeId: string | null; completedAt?: Date | null } & Links) {
  if (!task.assigneeId || task.completedAt) return;
  notify(
    [task.assigneeId],
    {
      kind: "task_assigned",
      title: `${actorName(a)} gave you a ${task.type === "task" ? "task" : task.type}`,
      body: task.subject || "Open it to see the details.",
      url: recordUrl(task),
      // Per assignment, not per task and person: handing a task back to someone who had it before tells them again.
      // The minute stops a double-submitted form from notifying twice.
      dedupeKey: `task_assigned:${task.id}:${task.assigneeId}:${Math.floor(Date.now() / 60_000)}`,
    },
    { except: actorUserId(a) },
  );
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

/** Whoever owns each record an activity is on, with the name and page of the record they own (a client before its contact before its organization). */
async function ownersOf(l: Links) {
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
export function noteWritten(a: Actor, note: { id: string; replyId?: string } & Links, text: string, mentioned: string[], thread: (string | null)[] = []) {
  const who = actorName(a);
  const body = snippet(text, "Open it to read the note.");
  const url = recordUrl(note);
  const dedupeKey = `note:${note.replyId ?? note.id}`;
  notifyEach(async () => noteTargets({ who, body, url, dedupeKey, reply: !!note.replyId, mentioned, thread, owners: await ownersOf(note) }), {
    except: actorUserId(a),
  });
}

/**
 * A call, email, text, meeting or task was logged or planned on a record
 * someone else owns. Notes go through noteWritten. An open task's assignee
 * isn't told twice: "gave you a task" covers them.
 */
export function activityLogged(a: Actor, activity: { id: string; type: ActivityType; subject: string | null; text: string; done: boolean; assigneeId: string | null } & Links) {
  if (activity.type === "note") return;
  const who = actorName(a);
  const verb = activityVerb(activity.type, activity.done);
  const body = activity.subject?.trim() || snippet(activity.text, "Open it to see the details.");
  notifyEach(
    async () =>
      (await ownersOf(activity))
        .filter((o) => activity.done || o.userId !== activity.assigneeId)
        .map((o) => ({ userId: o.userId, notices: [{ kind: "owned_activity" as const, title: `${who} ${verb} on ${o.name}`, body, url: o.url, dedupeKey: `activity:${activity.id}` }] })),
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
