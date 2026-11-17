import { z } from "zod";
import { activityTypes, clientCategories, clientHealths, entityTypes } from "@/lib/constants";
import { activityInput, categoryInput, datetime, clientCreateInput, clientInput, metricInput, moveInput, orgInput, personInput, subscriptionInput } from "@/lib/crm/schemas";
import { idParam, op, pageQuery, queryBool, recordQuery, type Operation } from "./spec";

/**
 * Every endpoint of the REST API (under /api/v1) and every MCP tool. Adding an
 * operation here and its handler in handlers.ts is all it takes: routing, the
 * OpenAPI document, the docs page and MCP pick it up.
 */

const ids = (...names: string[]) => z.object(Object.fromEntries(names.map((n) => [n, z.uuid()])));
const links = {
  personId: z.uuid().optional().describe("Only those linked to this person."),
  organizationId: z.uuid().optional().describe("Only those linked to this organization."),
  clientId: z.uuid().optional().describe("Only those linked to this client."),
};
const linkFields = {
  personId: z.uuid().nullable().optional(),
  organizationId: z.uuid().nullable().optional(),
  clientId: z.uuid().nullable().optional().describe("Linking a client also links its contact and organization; linking a person also links their organization."),
};
const pinned = z.boolean().optional().describe("Pinned activity stays at the top of the record's timeline.");

const taskBody = z.object({
  subject: activityInput.shape.subject.describe("What needs doing."),
  body: activityInput.shape.body,
  dueAt: activityInput.shape.dueAt.describe("When it's due (ISO 8601 with offset). Defaults to today."),
  dueHasTime: activityInput.shape.dueHasTime,
  assigneeId: activityInput.shape.assigneeId,
  ...linkFields,
});
const noteBody = z.object({
  body: activityInput.shape.body.describe("The note. HTML (p, strong, em, a, ul, ol, li, blockquote, code) or plain text; blank lines start new paragraphs."),
  subject: activityInput.shape.subject.describe("An optional title."),
  ...linkFields,
  pinned,
});

const timelineQuery = z.object({ limit: z.coerce.number().int().min(1).max(300).optional().describe("How many history entries, newest first. Defaults to 50.") });

const entity = (one: string, many: string, path: string, tag: string, tool: string, tools: string) => ({ one, many, path, tag, tool, tools });
const P = entity("person", "people", "/people", "People", "person", "people");
const O = entity("organization", "organizations", "/organizations", "Organizations", "organization", "organizations");
const C = entity("client", "clients", "/clients", "Clients", "client", "clients");

/** get, archive, restore and timeline: the same four for every record type. */
function recordOps(e: typeof P) {
  return {
    get: op({ method: "GET", path: `${e.path}/{id}`, tag: e.tag, summary: `Get a ${e.one}`, permission: "records:read", params: idParam, response: e === P ? "Person" : e === O ? "Organization" : "Client", tool: `get_${e.tool}` }),
    archive: op({
      method: "DELETE",
      path: `${e.path}/{id}`,
      tag: e.tag,
      summary: `Archive a ${e.one}`,
      description: `Archived ${e.many} leave lists and search but keep their history; restore brings them back. Nothing is erased.`,
      permission: "records:archive",
      params: idParam,
      response: "Deleted",
      tool: `archive_${e.tool}`,
    }),
    restore: op({ method: "POST", path: `${e.path}/{id}/restore`, tag: e.tag, summary: `Restore an archived ${e.one}`, permission: "records:archive", params: idParam, response: e === P ? "Person" : e === O ? "Organization" : "Client", tool: null }),
    timeline: op({
      method: "GET",
      path: `${e.path}/{id}/timeline`,
      tag: e.tag,
      summary: `A ${e.one}'s timeline`,
      description: "Planned activity, then everything logged and changed, newest first. The quickest way to catch up on a relationship.",
      permission: "records:read",
      params: idParam,
      query: timelineQuery,
      response: "Timeline",
      tool: `get_${e.tool}_timeline`,
    }),
  };
}

/** Merging duplicates into the record in the path: the same for people and organizations. */
function mergeOp(e: typeof P) {
  const person = e === P;
  return op({
    method: "POST",
    path: `${e.path}/{id}/merge`,
    tag: e.tag,
    summary: `Merge ${e.many} into this one`,
    description: person
      ? "The person in the path is kept with every value it has; blanks are filled from the others (most recently active first). Their notes, tasks, meetings, emails, calls, texts, files, clients and history move to it, their emails, phones and organizations are kept as other emails, other phones and Also at, an opt-out on any of them carries over, and then they're deleted. If that leaves this person with more than one client that has no organization, those clients become one: the one furthest along is kept. Can't be undone."
      : "The organization in the path is kept with every value it has; blanks are filled from the others (most recently active first). Their people, clients, notes, tasks, meetings, emails, calls, texts, files and history move to it, and then they're deleted. If that leaves it with more than one client, those clients become one: the one furthest along (current, then past, then prospective; among prospects, the stage with the higher win probability) is kept, and the others' services, metrics and timelines move to it. Can't be undone.",
    permission: "records:archive",
    params: idParam,
    body: z.object({ mergeIds: z.array(z.uuid()).min(1).max(49).describe(`The ${e.many} to merge into it and delete. Up to 49.`) }),
    response: person ? "Person" : "Organization",
    destructive: true,
    tool: `merge_${e.tools}`,
    toolDescription: `Merge duplicate ${e.many} into one. Check with the user which one to keep before calling: the others are deleted and this can't be undone.`,
  });
}

const people = recordOps(P);
const orgs = recordOps(O);
const clients = recordOps(C);

export const operations = {
  // ─── Account ───────────────────────────────────────────────────────────
  me: op({
    method: "GET",
    path: "/me",
    tag: "Account",
    summary: "Who this key acts as",
    description: "The key, the teammate behind it (personal keys), what it may do, and the workspace's currency and time zone.",
    permission: "records:read",
    response: "Me",
    tool: "whoami",
    toolDescription: "Who you are acting as in the CRM, your permissions, and the workspace's currency and time zone. Call this first.",
  }),
  search: op({
    method: "GET",
    path: "/search",
    tag: "Account",
    summary: "Search people, organizations and clients",
    permission: "records:read",
    query: z.object({ q: z.string().trim().min(1, "Enter something to search for.").max(100).describe("Name, email, domain or company.") }),
    response: "SearchResult",
    tool: "search",
    toolDescription: "Find people, organizations and clients by name, email or domain. Use it to get ids before reading or changing a record.",
  }),

  // ─── People ────────────────────────────────────────────────────────────
  listPeople: op({
    method: "GET",
    path: "/people",
    tag: "People",
    summary: "List people",
    description: "Contacts, newest first.",
    permission: "records:read",
    query: z.object({
      ...recordQuery,
      organizationId: z.uuid().optional().describe("Only people at this organization."),
      email: z.string().trim().toLowerCase().max(200).optional().describe("Exact email address."),
      tag: z.string().trim().toLowerCase().max(40).optional(),
    }),
    response: "Person",
    list: true,
    tool: "list_people",
  }),
  createPerson: op({ method: "POST", path: "/people", tag: "People", summary: "Create a person", permission: "records:write", body: personInput, response: "Person", status: 201, tool: "create_person", example: { firstName: "Sam", lastName: "Lee", email: "sam@acme.com", title: "Head of growth", organizationId: "9b1d…", tags: ["referral"] } }),
  getPerson: people.get,
  updatePerson: op({
    method: "PATCH",
    path: "/people/{id}",
    tag: "People",
    summary: "Update a person",
    description: "Send only the fields to change. Each change is written to the person's history.",
    permission: "records:write",
    params: idParam,
    body: personInput.partial(),
    response: "Person",
    tool: "update_person",
  }),
  mergePeople: mergeOp(P),
  archivePerson: people.archive,
  restorePerson: people.restore,
  personTimeline: people.timeline,

  // ─── Organizations ─────────────────────────────────────────────────────
  listOrganizations: op({
    method: "GET",
    path: "/organizations",
    tag: "Organizations",
    summary: "List organizations",
    description: "Companies, newest first.",
    permission: "records:read",
    query: z.object({ ...recordQuery, domain: z.string().trim().toLowerCase().max(200).optional().describe("Exact website domain, like acme.com.") }),
    response: "Organization",
    list: true,
    tool: "list_organizations",
  }),
  createOrganization: op({
    method: "POST",
    path: "/organizations",
    tag: "Organizations",
    summary: "Create an organization",
    description: "Names are unique (ignoring case) among organizations that aren't archived; a duplicate returns 409 with the existing id.",
    permission: "records:write",
    body: orgInput,
    response: "Organization",
    status: 201,
    tool: "create_organization",
    example: { name: "Acme", domain: "acme.com", industry: "Software" },
  }),
  getOrganization: orgs.get,
  updateOrganization: op({
    method: "PATCH",
    path: "/organizations/{id}",
    tag: "Organizations",
    summary: "Update an organization",
    description: "Send only the fields to change.",
    permission: "records:write",
    params: idParam,
    body: orgInput.partial(),
    response: "Organization",
    tool: "update_organization",
  }),
  mergeOrganizations: mergeOp(O),
  archiveOrganization: orgs.archive,
  restoreOrganization: orgs.restore,
  organizationTimeline: orgs.timeline,

  // ─── Clients ───────────────────────────────────────────────────────────
  listClients: op({
    method: "GET",
    path: "/clients",
    tag: "Clients",
    summary: "List clients",
    description: "Client relationships, newest first: prospects, current clients and past clients.",
    permission: "records:read",
    query: z.object({
      ...recordQuery,
      category: z.enum(clientCategories).optional(),
      pipelineId: z.uuid().optional(),
      stageId: z.uuid().optional(),
      personId: z.uuid().optional().describe("Only clients whose contact is this person."),
      organizationId: z.uuid().optional(),
      health: z.enum(clientHealths).optional(),
      tag: z.string().trim().toLowerCase().max(40).optional(),
    }),
    response: "Client",
    list: true,
    tool: "list_clients",
  }),
  createClient: op({
    method: "POST",
    path: "/clients",
    tag: "Clients",
    summary: "Create a client",
    description: "A prospect, a current client or a past client. It lands in the first stage of its category's first pipeline unless stageId says otherwise.",
    permission: "records:write",
    body: clientCreateInput,
    response: "Client",
    status: 201,
    tool: "create_client",
    example: { name: "Acme website rebuild", category: "prospective", value: 1250000, personId: "5c2e…", expectedCloseDate: "2026-12-15" },
  }),
  getClient: clients.get,
  updateClient: op({
    method: "PATCH",
    path: "/clients/{id}",
    tag: "Clients",
    summary: "Update a client",
    description: "Send only the fields to change. To change stage use /move; to sign, lose or win back a client use /category.",
    permission: "records:write",
    params: idParam,
    body: clientInput.partial(),
    response: "Client",
    tool: "update_client",
  }),
  archiveClient: clients.archive,
  restoreClient: clients.restore,
  clientTimeline: clients.timeline,
  moveClient: op({
    method: "POST",
    path: "/clients/{id}/move",
    tag: "Clients",
    summary: "Move a client to another stage",
    description: "Within its own category's pipelines. GET /pipelines lists the stages.",
    permission: "records:write",
    params: idParam,
    body: moveInput,
    example: { stageId: "c41a…" },
    response: "Client",
    tool: "move_client_stage",
  }),
  changeClientCategory: op({
    method: "POST",
    path: "/clients/{id}/category",
    tag: "Clients",
    summary: "Sign, lose or win back a client",
    description: "Moves a client between prospective, current and past. Records the date and reason, moves it into the new category's pipeline, and keeps services in step: leaving ends them, signing can start some.",
    permission: "records:write",
    params: idParam,
    body: categoryInput,
    example: { category: "current", on: "2026-11-01", serviceIds: ["e7f0…"] },
    response: "Client",
    tool: "change_client_category",
  }),
  listClientServices: op({
    method: "GET",
    path: "/clients/{id}/services",
    tag: "Clients",
    summary: "A client's services",
    description: "What the client uses or used, at what price, from when to when. Open ones make up its monthly revenue.",
    permission: "records:read",
    params: idParam,
    response: "ClientService",
    list: true,
    tool: "list_client_services",
  }),
  addClientService: op({
    method: "POST",
    path: "/clients/{id}/services",
    tag: "Clients",
    summary: "Add a service to a client",
    permission: "records:write",
    params: idParam,
    body: subscriptionInput.extend({ serviceId: z.uuid().describe("From GET /services.") }),
    response: "ClientService",
    status: 201,
    tool: "add_client_service",
  }),
  updateClientService: op({
    method: "PATCH",
    path: "/clients/{id}/services/{subscriptionId}",
    tag: "Clients",
    summary: "Change or end a client's service",
    description: "Set endedOn to end it.",
    permission: "records:write",
    params: ids("id", "subscriptionId"),
    body: subscriptionInput.partial(),
    response: "ClientService",
    tool: "update_client_service",
  }),
  removeClientService: op({
    method: "DELETE",
    path: "/clients/{id}/services/{subscriptionId}",
    tag: "Clients",
    summary: "Remove a service added by mistake",
    description: "To record that a client stopped using a service, end it instead (PATCH with endedOn).",
    permission: "records:write",
    params: ids("id", "subscriptionId"),
    response: "Deleted",
    tool: null,
  }),
  listClientMetrics: op({
    method: "GET",
    path: "/clients/{id}/metrics",
    tag: "Clients",
    summary: "A client's performance numbers",
    description: "Every logged value, newest period first.",
    permission: "records:read",
    params: idParam,
    query: z.object({ label: z.string().trim().max(60).optional().describe("Only this series.") }),
    response: "Metric",
    list: true,
    tool: null,
  }),
  logClientMetric: op({
    method: "POST",
    path: "/clients/{id}/metrics",
    tag: "Clients",
    summary: "Log a performance number",
    permission: "records:write",
    params: idParam,
    body: metricInput,
    response: "Metric",
    status: 201,
    tool: "log_client_metric",
  }),
  deleteClientMetric: op({ method: "DELETE", path: "/clients/{id}/metrics/{metricId}", tag: "Clients", summary: "Delete a performance number", permission: "records:write", params: ids("id", "metricId"), response: "Deleted", tool: null }),

  // ─── Tasks ─────────────────────────────────────────────────────────────
  listTasks: op({
    method: "GET",
    path: "/tasks",
    tag: "Tasks",
    summary: "List tasks",
    description: "Open tasks come soonest due first; done and all come newest first.",
    permission: "records:read",
    query: z.object({
      status: z.enum(["open", "done", "all"]).optional().describe("Defaults to open."),
      assigneeId: z.string().max(40).optional().describe('A teammate id, "me", or "none".'),
      ...links,
      dueBefore: datetime.optional(),
      dueAfter: datetime.optional(),
      ...pageQuery,
    }),
    response: "Activity",
    list: true,
    tool: "list_tasks",
    toolDescription: 'List tasks. Defaults to open tasks, soonest due first. Use assigneeId "me" for your own.',
  }),
  createTask: op({
    method: "POST",
    path: "/tasks",
    tag: "Tasks",
    summary: "Add a task",
    description: "A to-do, optionally linked to a person, organization or client. Assigned to the key's teammate unless assigneeId says otherwise.",
    permission: "records:write",
    body: taskBody,
    example: { subject: "Send the proposal", dueAt: "2026-11-20T09:00:00-07:00", dueHasTime: true, clientId: "3f6c…" },
    response: "Activity",
    status: 201,
    tool: "create_task",
  }),
  getTask: op({ method: "GET", path: "/tasks/{id}", tag: "Tasks", summary: "Get a task", permission: "records:read", params: idParam, response: "Activity", tool: null }),
  updateTask: op({
    method: "PATCH",
    path: "/tasks/{id}",
    tag: "Tasks",
    summary: "Update a task",
    description: "Reschedule, reassign, rename or relink. Anyone who can edit records can change a task.",
    permission: "records:write",
    params: idParam,
    body: taskBody.partial(),
    response: "Activity",
    tool: "update_task",
  }),
  completeTask: op({ method: "POST", path: "/tasks/{id}/complete", tag: "Tasks", summary: "Check a task off", permission: "records:write", params: idParam, response: "Activity", tool: "complete_task" }),
  reopenTask: op({ method: "POST", path: "/tasks/{id}/reopen", tag: "Tasks", summary: "Reopen a task", permission: "records:write", params: idParam, response: "Activity", tool: null }),
  deleteTask: op({ method: "DELETE", path: "/tasks/{id}", tag: "Tasks", summary: "Delete a task", description: "Only its author or an admin can delete it.", permission: "records:write", params: idParam, response: "Deleted", tool: "delete_task" }),

  // ─── Notes ─────────────────────────────────────────────────────────────
  listNotes: op({
    method: "GET",
    path: "/notes",
    tag: "Notes",
    summary: "List notes",
    description: "Newest first.",
    permission: "records:read",
    query: z.object({ ...links, unlinked: queryBool.optional().describe("Only notes not linked to any record."), ...pageQuery }),
    response: "Activity",
    list: true,
    tool: "list_notes",
  }),
  createNote: op({
    method: "POST",
    path: "/notes",
    tag: "Notes",
    summary: "Add a note",
    description: "On a person, organization or client, or on its own.",
    permission: "records:write",
    body: noteBody,
    example: { body: "Budget approved for Q1.\n\nThey want a call with design next week.", clientId: "3f6c…" },
    response: "Activity",
    status: 201,
    tool: "create_note",
  }),
  getNote: op({ method: "GET", path: "/notes/{id}", tag: "Notes", summary: "Get a note", permission: "records:read", params: idParam, response: "Activity", tool: null }),
  updateNote: op({
    method: "PATCH",
    path: "/notes/{id}",
    tag: "Notes",
    summary: "Update a note",
    description: "Only its author or an admin can rewrite it.",
    permission: "records:write",
    params: idParam,
    body: noteBody.partial(),
    response: "Activity",
    tool: "update_note",
  }),
  deleteNote: op({ method: "DELETE", path: "/notes/{id}", tag: "Notes", summary: "Delete a note", description: "Only its author or an admin can delete it.", permission: "records:write", params: idParam, response: "Deleted", tool: "delete_note" }),

  // ─── Activities ────────────────────────────────────────────────────────
  listActivities: op({
    method: "GET",
    path: "/activities",
    tag: "Activities",
    summary: "List activity",
    description: "Every kind: notes, calls, emails, texts, meetings and tasks. Newest first; planned activity soonest first.",
    permission: "records:read",
    query: z.object({
      type: z
        .union([z.enum(activityTypes), z.array(z.enum(activityTypes))])
        .optional()
        .describe("One type, or several (repeat the parameter)."),
      status: z.enum(["planned", "done", "all"]).optional().describe("Defaults to all."),
      assigneeId: z.string().max(40).optional().describe('A teammate id, "me", or "none".'),
      ...links,
      since: datetime.optional().describe("Only activity that happened (or was created) at or after this time."),
      ...pageQuery,
    }),
    response: "Activity",
    list: true,
    tool: "list_activities",
  }),
  createActivity: op({
    method: "POST",
    path: "/activities",
    tag: "Activities",
    summary: "Log or plan activity",
    description: "Log a call, email, text or meeting that happened, or plan one with dueAt and done: false. Calls, emails, texts and meetings need a link to a person, organization or client.",
    permission: "records:write",
    body: activityInput,
    example: { type: "call", subject: "Discovery call", direction: "outbound", outcome: "Connected", durationMinutes: 25, personId: "5c2e…" },
    response: "Activity",
    status: 201,
    tool: "log_activity",
    toolDescription: "Log a call, email, text or meeting that already happened (done defaults to true), or plan one with dueAt. Link it with personId, organizationId or clientId. Use create_task and create_note for tasks and notes.",
  }),
  getActivity: op({ method: "GET", path: "/activities/{id}", tag: "Activities", summary: "Get an activity", permission: "records:read", params: idParam, response: "Activity", tool: null }),
  updateActivity: op({
    method: "PATCH",
    path: "/activities/{id}",
    tag: "Activities",
    summary: "Update an activity",
    description: "Anyone who can edit records can reschedule or reassign; only the author or an admin can rewrite what was logged.",
    permission: "records:write",
    params: idParam,
    body: activityInput.omit({ done: true }).partial().extend({ pinned }),
    response: "Activity",
    tool: "update_activity",
  }),
  completeActivity: op({
    method: "POST",
    path: "/activities/{id}/complete",
    tag: "Activities",
    summary: "Mark planned activity done",
    description: "For tasks and planned calls or meetings. Send { \"completed\": false } to reopen.",
    permission: "records:write",
    params: idParam,
    body: z.object({ completed: z.boolean().optional().describe("Defaults to true.") }),
    response: "Activity",
    tool: null,
  }),
  deleteActivity: op({ method: "DELETE", path: "/activities/{id}", tag: "Activities", summary: "Delete an activity", description: "Only its author or an admin can delete it. Email sent or received through the CRM can't be deleted.", permission: "records:write", params: idParam, response: "Deleted", tool: "delete_activity" }),

  // ─── Workspace ─────────────────────────────────────────────────────────
  listPipelines: op({ method: "GET", path: "/pipelines", tag: "Workspace", summary: "Pipelines and their stages", description: "Each pipeline belongs to one client category.", permission: "records:read", response: "Pipeline", list: true, tool: "list_pipelines" }),
  listServices: op({ method: "GET", path: "/services", tag: "Workspace", summary: "What the workspace sells", permission: "records:read", response: "Service", list: true, tool: "list_services" }),
  listUsers: op({ method: "GET", path: "/users", tag: "Workspace", summary: "The team", description: "For ownerId and assigneeId.", permission: "records:read", response: "User", list: true, tool: "list_users" }),
  listCustomFields: op({
    method: "GET",
    path: "/custom-fields",
    tag: "Workspace",
    summary: "Custom field definitions",
    description: "The keys and types for each record's custom object.",
    permission: "records:read",
    query: z.object({ entityType: z.enum(entityTypes).optional() }),
    response: "CustomField",
    list: true,
    tool: "list_custom_fields",
  }),

  // ─── Knowledge ─────────────────────────────────────────────────────────
  getKnowledge: op({
    method: "GET",
    path: "/knowledge",
    tag: "Knowledge",
    summary: "Read the knowledge source",
    description:
      "Reads one path of the knowledge source this deployment connects (usually its own website's content API: services, team, articles, resources), with the deployment's key, and returns what it answered. Read-only, and limited to the source's base URL. 404 with code not_configured when none is connected (docs/KNOWLEDGE.md).",
    permission: "records:read",
    query: z.object({
      path: z
        .string()
        .trim()
        .max(2000)
        .optional()
        .describe('A path under the source, with its query string: "/" (often a list of what it offers), "/posts?q=onboarding&limit=5". Defaults to "/". In a URL, encode it (? as %3F, & as %26).'),
    }),
    response: "Knowledge",
    tool: "get_knowledge",
    toolDescription:
      'Look things up in the organization\'s own knowledge source (its website\'s content: services, team, approach, articles, resources, company facts). Pass path: a path under the source with any query string. Ask for "/" first if you don\'t know its paths. Read-only.',
    feature: "knowledge",
  }),
} satisfies Record<string, Operation>;

export type Operations = typeof operations;
export type OperationId = keyof Operations;

export const operationList = Object.entries(operations).map(([id, o]) => ({ id: id as OperationId, ...(o as Operation) }));

/** Tags in the order the docs show them, with a line about each. */
export const tags = [
  { name: "Account", description: "The key you're using, and search across records." },
  { name: "People", description: "Contacts. Each can work at an organization and be the contact on clients." },
  { name: "Organizations", description: "Companies. Their people and clients roll up to them." },
  { name: "Clients", description: "Client relationships in three categories: prospective, current and past. A client moves through its category's pipeline stages, uses services, and logs performance numbers." },
  { name: "Tasks", description: "To-dos, optionally linked to a person, organization or client." },
  { name: "Notes", description: "Notes on a record, or on their own." },
  { name: "Activities", description: "Everything logged or planned: notes, calls, emails, texts, meetings and tasks, in one list." },
  { name: "Workspace", description: "Pipelines, services, the team and custom fields: what ids in other requests refer to." },
  { name: "Knowledge", description: "The organization's own published material (its website's pages, articles and resources), from the knowledge source a deployment connects. Optional." },
] as const;
