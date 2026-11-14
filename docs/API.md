# API and MCP

The CRM has a REST API for integrations and scripts, and an MCP server so each teammate's AI agent can work in it. Both cover people, organizations, clients, tasks, notes and every other kind of activity, and both write the same history the app does.

The full reference (every endpoint, field, model and tool, with curl examples) is generated from the code and served by each deployment at **`/developers`**. The OpenAPI 3.1 document is at **`/api/v1/openapi.json`**. This page covers how the pieces fit.

## Keys

Keys are made in **Settings → API and MCP**. Only a SHA-256 hash is stored; the key is shown once.

| | Personal key `crm_pk_…` | Workspace key `crm_ws_…` |
| --- | --- | --- |
| Made by | Any teammate, for themselves (up to 10 live keys each) | Admins |
| Acts as | The teammate | The workspace, no person behind it |
| Can do | What that teammate's role allows, checked on every request | Everything |
| REST API | Yes | Yes |
| MCP | Yes | **No** |
| History shows | "Sam via Claude on laptop" | The key's name |

- A personal key follows its teammate: a role change applies to the key at once; deactivating the teammate stops it.
- Keys can expire (30 days, 90 days, a year, or never). Revoking takes effect on the next request. Admins see and can revoke every key, including teammates' personal keys.
- Send the key as `Authorization: Bearer <key>` (or `X-API-Key: <key>`). The API never accepts the session cookie, so a browser can't be tricked into calling it.

## Roles

`src/lib/permissions.ts` is the one table of what each role may do, used by the interface, the server actions, the API and MCP alike.

| Role | `records:read` | `records:write` | `records:archive` | `activities:moderate` | `workspace:admin` |
| --- | --- | --- | --- | --- | --- |
| Owner, admin | ✓ | ✓ | ✓ | ✓ | ✓ |
| Member | ✓ | ✓ | ✓ | | |
| Viewer | ✓ | | | | |

- `records:write`: create and edit records, log activity, add tasks and notes, move and sign clients.
- `activities:moderate`: edit or delete activity someone else logged. Without it, you can still reschedule and reassign anyone's tasks.
- Viewers are new. The interface hides create buttons and the composer for them, and every action that changes data refuses them on the server (`actionEditor()` in `src/lib/auth.ts`).

## MCP

- Endpoint: `POST /api/mcp`, Streamable HTTP transport, protocol versions 2024-11-05 through 2025-11-25.
- Stateless: each request is a JSON-RPC message (or batch) answered with JSON. There's no session and no event stream, so it runs on serverless functions; `GET` and `DELETE` return 405.
- Personal keys only. Workspace keys get a 403 explaining why.
- `tools/list` is filtered by role: a viewer's agent sees only the reading tools. Each tool runs one API operation; its arguments are the operation's path, query and body fields together. Annotations mark reads as read-only and deletes as destructive.
- Tool failures come back as results with `isError: true` and the same sentence the API would return, so the agent can correct itself.
- Requests with a cross-site `Origin` are refused (DNS-rebinding protection).
- Clients that connect only through OAuth sign-in (rather than a header) can't connect yet.

Setup for Claude Code, Cursor, VS Code and Claude Desktop is on `/developers#mcp`, and in the dialog shown when a key is created.

## How it's built

```
src/lib/api/
  operations.ts   every endpoint: method, path, permission, zod schemas, response model, MCP tool name
  handlers.ts     what each operation does (calls the service layer, reads the result back)
  queries.ts      paged, filtered reads shaped as the API's models
  models.ts       response shapes, for the docs and OpenAPI
  execute.ts      permission check + validation + handler, shared by REST and MCP
  http.ts         the REST request cycle: route, authenticate, rate-limit, run, answer
  router.ts       path matching (pure)
  auth.ts         API key → actor
  key-format.ts   key generation, hashing and parsing (pure)
  openapi.ts      the OpenAPI document (pure)
  docs.ts         field tables and curl examples for /developers (pure)
src/lib/mcp/
  protocol.ts     JSON-RPC handling and tools from operations (pure)
  server.ts       the /api/mcp request cycle
src/lib/crm/service/
  records.ts, clients.ts, activities.ts   every record change, taking an Actor
src/app/api/v1/[...path]/route.ts         one catch-all route for the REST API
src/app/api/mcp/route.ts
src/app/developers/page.tsx               the docs page (public, static)
```

- **One operation list.** Routing, validation, the OpenAPI document, the docs page and the MCP tool list are all generated from `operations.ts`, so they can't drift apart. Adding an endpoint is an entry there and a handler in `handlers.ts`; TypeScript refuses a missing handler.
- **One service layer.** The server actions (the browser), the API and MCP all change records through `src/lib/crm/service/*`. Each function takes an `Actor` (a teammate, a teammate through a key, or a workspace key), checks its permission and writes history in the same step. Server actions are thin wrappers that add `refresh()`.
- **History knows the key.** `events.api_key_id` and `activities.api_key_id` record which key made a change, alongside `user_id` for personal keys.
- **No new dependencies.** OpenAPI comes from zod 4's `toJSONSchema`; MCP is a few JSON-RPC methods; the docs page is a server component.

## Behavior worth knowing

- `DELETE` on people, organizations and clients archives (soft-deletes) them; `POST …/restore` brings them back. Tasks, notes and other activity are deleted. Email sent or received through the CRM can't be deleted.
- Lists are keyset-paged by `(created_at, id)` (open tasks by due date), up to 100 per page, so pages stay stable while records are added. `updatedSince` supports syncing.
- Tasks created without `dueAt` are due today (date only), so they show as open in the CRM.
- Tasks and notes can stand alone. Calls, emails, texts and meetings need a link to a person, organization or client.
- Bodies accept the rich-text HTML the app uses (sanitized by the same allow-list) or plain text, where blank lines start paragraphs.
- Duplicates (a person's email, an organization's name) return 409 with `existingId`.
- Each key can make 300 requests a minute across the API and MCP (`src/lib/api/limits.ts`), counted in Postgres. Every tool call in an MCP batch counts as a request, batches hold at most 20 messages and run one at a time.
- Request bodies are capped at 1 MB, counted in bytes as they stream in (a missing or wrong Content-Length doesn't get around it).
- Changing an activity's `type` needs its author or an admin, even for tasks, so retyping can't be used to unlock editing someone else's activity.
