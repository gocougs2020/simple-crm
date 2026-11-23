import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import * as runs from "@/lib/agent/runs";
import { startEnrichment } from "@/lib/agent/enrich";
import * as schedules from "@/lib/agent/schedules";
import * as skills from "@/lib/agent/skills";
import { can, type Actor } from "@/lib/crm/actor";
import { dayBounds } from "@/lib/crm/activities";
import * as activities from "@/lib/crm/service/activities";
import * as clients from "@/lib/crm/service/clients";
import * as drafts from "@/lib/crm/service/drafts";
import * as fileService from "@/lib/crm/service/files";
import { fileDetails, listFolders, recordsFor } from "@/lib/crm/files";
import { readStoredBytes } from "@/lib/file-bytes";
import { describeKind } from "@/lib/file-describe-rules";
import * as fileSearch from "@/lib/file-search";
import { fileText } from "@/lib/file-text";
import { folderLabel } from "@/lib/folder-tree";
import * as merging from "@/lib/crm/service/merge";
import * as records from "@/lib/crm/service/records";
import { ConflictError, NotFoundError } from "@/lib/errors";
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

/** `agent` marks a call from the in-app agent; `threadId` is the chat it came from, so work it starts can answer there. */
export type HandlerContext = { origin: string; agent?: boolean; threadId?: string };
type Handler<O> = (a: Actor, input: InputOf<O>, ctx: HandlerContext) => Promise<unknown>;

const deleted = (id: string) => ({ id, deleted: true as const });

async function archive(a: Actor, entity: "person" | "organization" | "client", id: string, archived: boolean) {
  const { count } = await records.setArchived(a, entity, [id], archived);
  if (!count) throw new NotFoundError(`There's no ${entity} with that id.`);
}

/** Creates a record, or with ifExists=return hands back the one a duplicate points at (find-or-create for integrations). */
async function orExisting(ifExists: "error" | "return" | undefined, create: () => Promise<{ id: string }>) {
  try {
    return (await create()).id;
  } catch (err) {
    const existing = err instanceof ConflictError ? (err.cause as { id?: string } | undefined)?.id : undefined;
    if (ifExists === "return" && existing) return existing;
    throw err;
  }
}

/** Tasks without a due date land on today, so they show as open in the CRM. */
async function todayStart() {
  const ws = await getWorkspace();
  return dayBounds(ws.timezone).startOfToday.toISOString();
}

export const handlers: { [K in OperationId]: Handler<Operations[K]> } = {
  // Agent
  async startAgentTask(a, { body }, ctx) {
    const run = await runs.startRun(a, { prompt: body.request, title: body.title, source: ctx.agent ? "chat" : "api", threadId: ctx.threadId, personId: body.personId, organizationId: body.organizationId, clientId: body.clientId });
    return q.toAgentTask(run);
  },
  enrichPerson: async (a, { params }) => q.toAgentTask(await startEnrichment(a, "person", params.id)),
  enrichOrganization: async (a, { params }) => q.toAgentTask(await startEnrichment(a, "organization", params.id)),
  listAgentTasks: async (a, { query }) => (await runs.listRuns(a, query)).map(q.toAgentTask),
  getAgentTask: async (a, { params }) => q.toAgentTask(await runs.getRun(a, params.id)),
  async startAgentBulk(a, { body }, ctx) {
    const started = await runs.startBulk(a, { ...body, threadId: ctx.threadId });
    return { batchId: started.batchId, count: started.runs.length, tasks: started.runs.map(q.toAgentTask) };
  },
  async draftMessage(a, { body }, ctx) {
    return q.toDraft(await drafts.createDraft(a, body), ctx);
  },
  listDrafts: async (a, { query }, ctx) => (await drafts.listDrafts(a, query)).map((d) => q.toDraft(d, ctx)),
  cancelAgentTask: async (a, { params }) => q.toAgentTask(await runs.cancelRun(a, params.id)),

  // Skills
  listSkills: async (a, { query }) => (await skills.listSkills(a, query)).map((s) => q.toSkill(s, { brief: true })),
  getSkill: async (a, { params }) => q.toSkill(await skills.getSkill(a, params.id)),
  createSkill: async (a, { body }) => q.toSkill(await skills.createSkill(a, body)),
  updateSkill: async (a, { params, body }) => q.toSkill(await skills.updateSkill(a, params.id, body)),
  async deleteSkill(a, { params }) {
    await skills.deleteSkill(a, params.id);
    return deleted(params.id);
  },

  // Scheduled jobs
  listScheduledJobs: async (a, { query }) => (await schedules.listJobs(a, query)).map(q.toScheduledJob),
  createScheduledJob: async (a, { body }) => q.toScheduledJob(await schedules.createJob(a, body)),
  updateScheduledJob: async (a, { params, body }) => q.toScheduledJob(await schedules.updateJob(a, params.id, body)),
  async deleteScheduledJob(a, { params }) {
    await schedules.deleteJob(a, params.id);
    return deleted(params.id);
  },
  addScheduledJob: async (a, { params }) => q.toScheduledJob(await schedules.addSharedJob(a, params.id)),

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
  async createPerson(a, { body, query }, ctx) {
    const id = await orExisting(query.ifExists, () => records.createPerson(a, body));
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
  async createOrganization(a, { body, query }, ctx) {
    const id = await orExisting(query.ifExists, () => records.createOrganization(a, body));
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
  async mergeClients(a, { params, body }, ctx) {
    const { id } = await merging.mergeClients(a, { keepId: params.id, mergeIds: body.mergeIds });
    return q.getClient(ctx, id);
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
  async listClientPeople(_a, { params }, ctx) {
    return { data: await q.clientPeople(ctx, params.id), nextCursor: null };
  },
  async addClientPerson(a, { params, body }, ctx) {
    await clients.addClientPerson(a, params.id, body.personId);
    return (await q.clientPeople(ctx, params.id)).find((p) => p.id === body.personId);
  },
  async removeClientPerson(a, { params }) {
    await clients.removeClientPerson(a, params.id, params.personId);
    return deleted(params.personId);
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
  async replyToNote(a, { params, body }) {
    await q.getActivity(params.id, "note");
    await activities.replyToNote(a, params.id, body);
    return q.getActivity(params.id);
  },
  async deleteNoteReply(a, { params }) {
    const note = await q.getActivity(params.id, "note");
    if (!note.replies.some((r) => r.id === params.replyId)) throw new NotFoundError("There's no reply with that id on this note.");
    await activities.deleteReply(a, params.replyId);
    return q.getActivity(params.id);
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
  listLabels: async () => ({ data: await q.listLabelDefinitions(), nextCursor: null }),
  listUsers: async () => ({ data: await q.listUsers(), nextCursor: null }),
  listCustomFields: async (_a, { query }) => ({ data: await q.listCustomFields(query.entityType), nextCursor: null }),

  // Files
  async searchFiles(_a, { query }, ctx) {
    const record = query.clientId ? { entity: "client" as const, id: query.clientId } : query.personId ? { entity: "person" as const, id: query.personId } : query.organizationId ? { entity: "organization" as const, id: query.organizationId } : undefined;
    const found = await fileSearch.searchFiles({ q: query.q, record, onRecords: query.onRecords, folderId: query.folderId, limit: query.limit });
    const c = await fileContext(ctx);
    return found.map((f) => q.toFile(f, c));
  },
  getFile: async (_a, { params, query }, ctx) => fileDetail(params.id, !!query.includeText, ctx),
  async uploadFile(a, { body }, ctx) {
    const row = await fileService.uploadFileBytes(a, body);
    return apiFile(row.id, ctx);
  },
  async updateFile(a, { params, body }, ctx) {
    const { attach, detach, ...patch } = body;
    if (Object.keys(patch).length) await fileService.updateFile(a, params.id, patch);
    if (attach?.length || detach?.length) {
      const current = (await recordsFor([params.id])).get(params.id) ?? [];
      const key = (r: { entity: string; id: string }) => `${r.entity}:${r.id}`;
      const drop = new Set((detach ?? []).map(key));
      const next = [...current.filter((r) => !drop.has(key(r))), ...(attach ?? []).filter((r) => !drop.has(key(r)))];
      await fileService.setFileRecords(
        a,
        params.id,
        [...new Map(next.map((r) => [key(r), { entity: r.entity, id: r.id }])).values()],
      );
    }
    return apiFile(params.id, ctx);
  },
  async deleteFile(a, { params }) {
    await fileService.deleteFile(a, params.id);
    return deleted(params.id);
  },
  async setFileVisibility(a, { params, body }, ctx) {
    await fileService.setFileVisibility(a, params.id, body.visibility);
    return apiFile(params.id, ctx);
  },
  async listFolders() {
    const all = await listFolders();
    return all.map(toFolder(all));
  },
  async createFolder(a, { body }) {
    const row = await fileService.createFolder(a, body);
    return folderById(row.id);
  },
  async updateFolder(a, { params, body }) {
    await fileService.updateFolder(a, params.id, body);
    return folderById(params.id);
  },
  async deleteFolder(a, { params, query }) {
    await fileService.deleteFolder(a, params.id, query.contents === "move" ? { contents: "move", to: query.moveTo ?? null } : { contents: "delete" });
    return deleted(params.id);
  },

  // Knowledge
  getKnowledge: (_a, { query }) => fetchKnowledge(query.path ?? "/"),
};

// ─── Files ───────────────────────────────────────────────────────────────

/** What a file's API shape needs besides the file: every folder (for its path) and teammates' names (for the uploader). Two small reads, not the whole app context. */
async function fileContext(ctx: HandlerContext) {
  const db = await getDb();
  const [folders, team] = await Promise.all([listFolders(), db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users)]);
  return { origin: ctx.origin, folders, team };
}

const toFolder = (all: Awaited<ReturnType<typeof listFolders>>) => (f: Awaited<ReturnType<typeof listFolders>>[number]) => ({ id: f.id, name: f.name, parentId: f.parentId, path: folderLabel(all, f.id), files: f.files });

async function folderById(id: string) {
  const all = await listFolders();
  const f = all.find((x) => x.id === id);
  if (!f) throw new NotFoundError("There's no folder with that id.");
  return toFolder(all)(f);
}

/** One file in its API shape. */
async function apiFile(id: string, ctx: HandlerContext) {
  const details = await fileDetails(id);
  if (!details) throw new NotFoundError("There's no file with that id.");
  return q.toFile(details.file, await fileContext(ctx));
}

const MAX_TEXT = 20_000;

/** A file with its key facts and, when asked, its own text. Both come from the file, so the tool says to read them as information. */
async function fileDetail(id: string, includeText: boolean, ctx: HandlerContext) {
  const details = await fileDetails(id);
  if (!details) throw new NotFoundError("There's no file with that id.");
  let text: string | null = null;
  let textTruncated = false;
  if (includeText) {
    const kind = describeKind(details.file.name, details.file.contentType);
    if (kind && kind !== "pdf" && kind !== "image") {
      const db = await getDb();
      const [row] = await db.select({ url: schema.files.url, pathname: schema.files.pathname, name: schema.files.name }).from(schema.files).where(eq(schema.files.id, id));
      const full = row ? await fileText(await readStoredBytes(row), kind).catch(() => null) : null;
      if (full) {
        textTruncated = full.length > MAX_TEXT;
        text = textTruncated ? full.slice(0, MAX_TEXT) : full;
      }
    }
  }
  return { ...q.toFile(details.file, await fileContext(ctx)), keyFacts: details.file.contentNotes, text, textTruncated };
}

