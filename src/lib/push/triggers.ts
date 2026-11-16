import "server-only";
import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { actorUserId, type Actor } from "@/lib/crm/actor";
import { notify } from "./notify";

/**
 * What notifies whom. Each function is called from the service that made the
 * change, so the browser, the API, MCP and the assistant all notify the same
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
