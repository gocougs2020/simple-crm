import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import * as runs from "@/lib/agent/runs";
import { can, type Actor } from "@/lib/crm/actor";
import { dayBounds } from "@/lib/crm/activities";
import * as activities from "@/lib/crm/service/activities";
import * as clients from "@/lib/crm/service/clients";
import * as drafts from "@/lib/crm/service/drafts";
import * as merging from "@/lib/crm/service/merge";
import * as records from "@/lib/crm/service/records";
import { NotFoundError } from "@/lib/errors";
import { fetchKnowledge } from "@/lib/knowledge/source";
import { permissions } from "@/lib/permissions";
import { getWorkspace } from "@/lib/workspace";
import type { OperationId, Operations } from "./operations";
import * as q from "./queries";
import type { InputOf } from "./spec";

/**
 * What each operation does. Writes go through the same service functions as
 * the browser (permissions, validation, history), then read the record back
 * in its API shape.
 */

/** `assistant` marks a call from the in-app assistant; `threadId` is the chat it came from, so work it starts can answer there. */
export type HandlerContext = { origin: string; assistant?: boolean; threadId?: string };
type Handler<O> = (a: Actor, input: InputOf<O>, ctx: HandlerContext) => Promise<unknown>;

const deleted = (id: string) => ({ id, deleted: true as const });

async function archive(a: Actor, entity: "person" | "organization" | "client", id: string, archived: boolean) {
  const { count } = await records.setArchived(a, entity, [id], archived);
  if (!count) throw new NotFoundError(`There's no ${entity} with that id.`);
}

/** Tasks without a due date land on today, so they show as open in the CRM. */
async function todayStart() {
  const ws = await getWorkspace();
  return dayBounds(ws.timezone).startOfToday.toISOString();
}

export const handlers: { [K in OperationId]: Handler<Operations[K]> } = {
  // Assistant
  async startAssistantTask(a, { body }, ctx) {
    const run = await runs.startRun(a, { prompt: body.request, title: body.title, source: ctx.assistant ? "chat" : "api", threadId: ctx.threadId, personId: body.personId, organizationId: body.organizationId, clientId: body.clientId }, ctx);
    return q.toAssistantTask(run);
  },
  listAssistantTasks: async (a, { query }) => (await runs.listRuns(a, query)).map(q.toAssistantTask),
  getAssistantTask: async (a, { params }) => q.toAssistantTask(await runs.getRun(a, params.id)),
  async startAssistantBulk(a, { body }, ctx) {
    const started = await runs.startBulk(a, { ...body, threadId: ctx.threadId }, ctx);
    return { batchId: started.batchId, count: started.runs.length, tasks: started.runs.map(q.toAssistantTask) };
  },
  async draftMessage(a, { body }, ctx) {
    return q.toDraft(await drafts.createDraft(a, body), ctx);
  },
  listDrafts: async (a, { query }, ctx) => (await drafts.listDrafts(a, query)).map((d) => q.toDraft(d, ctx)),
  cancelAssistantTask: async (a, { params }, ctx) => q.toAssistantTask(await runs.cancelRun(a, params.id, ctx)),

  async me(a) {
    const db = await getDb();
    const [key] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, a.keyId!));
    const ws = await getWorkspace();
    return {
      kind: key.kind,
      key: { id: key.id, name: key.name, prefix: key.prefix, expiresAt: key.expiresAt?.toISOString() ?? null },
      user: a.kind === "user" ? q.toUser(a.user) : null,
      permissions: permissions.filter((p) => can(a, p)),
      workspace: { name: ws.name, currency: ws.currency, timezone: ws.timezone },
    };
  },
  async search(a, { query }, ctx) {
    const [p, o, c] = await Promise.all([q.listPeople(a, ctx, { q: query.q, limit: 5 }), q.listOrganizations(a, ctx, { q: query.q, limit: 5 }), q.listClients(a, ctx, { q: query.q, limit: 5 })]);
    return { people: p.data, organizations: o.data, clients: c.data };
  },

  // People
  listPeople: (a, { query }, ctx) => q.listPeople(a, ctx, query),
  async createPerson(a, { body }, ctx) {
    const { id } = await records.createPerson(a, body);
    return q.getPerson(ctx, id);
  },
  getPerson: (_a, { params }, ctx) => q.getPerson(ctx, params.id),
  async updatePerson(a, { params, body }, ctx) {
    await records.updatePerson(a, params.id, body);
    return q.getPerson(ctx, params.id);
  },
  async mergePeople(a, { params, body }, ctx) {
    const { id } = await merging.mergePeople(a, { keepId: params.id, mergeIds: body.mergeIds });
    return q.getPerson(ctx, id);
  },
  async archivePerson(a, { params }) {
    await archive(a, "person", params.id, true);
    return deleted(params.id);
  },
  async restorePerson(a, { params }, ctx) {
    await archive(a, "person", params.id, false);
    return q.getPerson(ctx, params.id);
  },
  personTimeline: (_a, { params, query }) => q.recordTimeline("person", params.id, query.limit),

  // Organizations
  listOrganizations: (a, { query }, ctx) => q.listOrganizations(a, ctx, query),
  async createOrganization(a, { body }, ctx) {
    const { id } = await records.createOrganization(a, body);
    return q.getOrganization(ctx, id);
  },
  getOrganization: (_a, { params }, ctx) => q.getOrganization(ctx, params.id),
  async updateOrganization(a, { params, body }, ctx) {
    await records.updateOrganization(a, params.id, body);
    return q.getOrganization(ctx, params.id);
  },
  async mergeOrganizations(a, { params, body }, ctx) {
    const { id } = await merging.mergeOrganizations(a, { keepId: params.id, mergeIds: body.mergeIds });
    return q.getOrganization(ctx, id);
  },
  async archiveOrganization(a, { params }) {
    await archive(a, "organization", params.id, true);
    return deleted(params.id);
  },
  async restoreOrganization(a, { params }, ctx) {
    await archive(a, "organization", params.id, false);
    return q.getOrganization(ctx, params.id);
  },
  organizationTimeline: (_a, { params, query }) => q.recordTimeline("organization", params.id, query.limit),

  // Clients
  listClients: (a, { query }, ctx) => q.listClients(a, ctx, query),
  async createClient(a, { body }, ctx) {
    const { id } = await clients.createClient(a, body);
    return q.getClient(ctx, id);
  },
  getClient: (_a, { params }, ctx) => q.getClient(ctx, params.id),
  async updateClient(a, { params, body }, ctx) {
    await clients.updateClient(a, params.id, body);
    return q.getClient(ctx, params.id);
  },
  async archiveClient(a, { params }) {
    await archive(a, "client", params.id, true);
    return deleted(params.id);
  },
  async restoreClient(a, { params }, ctx) {
    await archive(a, "client", params.id, false);
    return q.getClient(ctx, params.id);
  },
  clientTimeline: (_a, { params, query }) => q.recordTimeline("client", params.id, query.limit),
  async moveClient(a, { params, body }, ctx) {
    await clients.moveClient(a, params.id, body.stageId);
    return q.getClient(ctx, params.id);
  },
  async changeClientCategory(a, { params, body }, ctx) {
    await clients.changeClientCategory(a, params.id, body);
    return q.getClient(ctx, params.id);
  },
  async listClientServices(_a, { params }) {
    return { data: await q.clientServices(params.id), nextCursor: null };
  },
  async addClientService(a, { params, body }) {
    const { serviceId, ...rest } = body;
    const { id } = await clients.addClientService(a, params.id, serviceId, rest);
    return (await q.clientServices(params.id)).find((s) => s.id === id);
  },
  async updateClientService(a, { params, body }) {
    await clients.updateClientService(a, params.subscriptionId, body, params.id);
    return (await q.clientServices(params.id)).find((s) => s.id === params.subscriptionId);
  },
  async removeClientService(a, { params }) {
    await q.assertExists("client", params.id);
    await clients.removeClientService(a, params.subscriptionId, params.id);
    return deleted(params.subscriptionId);
  },
  async listClientMetrics(_a, { params, query }) {
    return { data: await q.clientMetrics(params.id, query.label), nextCursor: null };
  },
  async logClientMetric(a, { params, body }) {
    const { id } = await clients.logClientMetric(a, params.id, body);
    return (await q.clientMetrics(params.id)).find((m) => m.id === id);
  },
  async deleteClientMetric(a, { params }) {
    await clients.deleteClientMetric(a, params.metricId, params.id);
    return deleted(params.metricId);
  },

  // Tasks
  listTasks: (a, { query }) => {
    const { status, ...rest } = query;
    return q.listActivities(a, { ...rest, types: ["task"], status: status === "done" ? "done" : status === "all" ? "all" : "planned" });
  },
  async createTask(a, { body }) {
    const dueAt = body.dueAt ?? (await todayStart());
    const { id } = await activities.logActivity(a, { ...body, type: "task", dueAt, dueHasTime: body.dueAt ? body.dueHasTime : false, done: false });
    return q.getActivity(id);
  },
  getTask: (_a, { params }) => q.getActivity(params.id, "task"),
  async updateTask(a, { params, body }) {
    await q.getActivity(params.id, "task");
    await activities.updateActivity(a, params.id, body);
    return q.getActivity(params.id);
  },
  async completeTask(a, { params }) {
    await q.getActivity(params.id, "task");
    await activities.setCompleted(a, params.id, true);
    return q.getActivity(params.id);
  },
  async reopenTask(a, { params }) {
    await q.getActivity(params.id, "task");
    await activities.setCompleted(a, params.id, false);
    return q.getActivity(params.id);
  },
  async deleteTask(a, { params }) {
    await activities.deleteActivity(a, params.id, "task");
    return deleted(params.id);
  },

  // Notes
  listNotes: (a, { query }) => q.listActivities(a, { ...query, types: ["note"] }),
  async createNote(a, { body }) {
    const { pinned, ...rest } = body;
    const { id } = await activities.logActivity(a, { ...rest, type: "note" });
    if (pinned) await activities.setPinned(a, id, true);
    return q.getActivity(id);
  },
  getNote: (_a, { params }) => q.getActivity(params.id, "note"),
  async updateNote(a, { params, body }) {
    await q.getActivity(params.id, "note");
    const { pinned, ...rest } = body;
    if (Object.keys(rest).length) await activities.updateActivity(a, params.id, rest);
    if (pinned !== undefined) await activities.setPinned(a, params.id, pinned);
    return q.getActivity(params.id);
  },
  async deleteNote(a, { params }) {
    await activities.deleteActivity(a, params.id, "note");
    return deleted(params.id);
  },

  // Activities
  listActivities: (a, { query }) => {
    const { type, ...rest } = query;
    return q.listActivities(a, { ...rest, types: type === undefined ? undefined : Array.isArray(type) ? type : [type], status: rest.status === "all" ? undefined : rest.status });
  },
  async createActivity(a, { body }) {
    const { id } = await activities.logActivity(a, body);
    return q.getActivity(id);
  },
  getActivity: (_a, { params }) => q.getActivity(params.id),
  async updateActivity(a, { params, body }) {
    await q.getActivity(params.id);
    const { pinned, ...rest } = body;
    if (Object.keys(rest).length) await activities.updateActivity(a, params.id, rest);
    if (pinned !== undefined) await activities.setPinned(a, params.id, pinned);
    return q.getActivity(params.id);
  },
  async completeActivity(a, { params, body }) {
    await activities.setCompleted(a, params.id, body.completed ?? true);
    return q.getActivity(params.id);
  },
  async deleteActivity(a, { params }) {
    await q.getActivity(params.id);
    await activities.deleteActivity(a, params.id);
    return deleted(params.id);
  },

  // Workspace
  listPipelines: async () => ({ data: await q.listPipelines(), nextCursor: null }),
  listServices: async () => ({ data: await q.listServices(), nextCursor: null }),
  listUsers: async () => ({ data: await q.listUsers(), nextCursor: null }),
  listCustomFields: async (_a, { query }) => ({ data: await q.listCustomFields(query.entityType), nextCursor: null }),

  // Knowledge
  getKnowledge: (_a, { query }) => fetchKnowledge(query.path ?? "/"),
};
