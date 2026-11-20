# API and MCP

The CRM has a REST API for integrations and scripts, and an MCP server so each teammate's AI agent can work in it. Both cover people, organizations, clients, tasks, notes and every other kind of activity, and both write the same history the app does.

The full reference (every endpoint, field, model and tool, with curl examples) is generated from the code and served by each deployment at **`/developers`**, and as one Markdown document at **`/developers.md`** (the page's "Copy as Markdown" button copies it: authorization, the Zapier guide, every endpoint, model and tool). The OpenAPI 3.1 document is at **`/api/v1/openapi.json`**. This page covers how the pieces fit.

## Zapier, Make and scheduling tools

`/developers#integrations` walks through connecting a no-code tool, with Calendly as the example: an admin makes a workspace key named after the tool, the tool sends `POST` requests with it as a bearer token, `POST /people?ifExists=return` finds or creates the person (a duplicate email returns the existing person instead of a 409, so a Zap doesn't stop), and `POST /activities` logs the booking as a planned meeting. The guide's text is data in `src/lib/api/integrations.ts`, so the page and the Markdown say the same thing. Tools whose webhooks can't send an Authorization header (Calendly's own) go through Zapier, Make or a small function.

## Keys

Keys are made in **Settings → API and MCP**. Only a SHA-256 hash is stored; the key is shown once.

| | Connected app (OAuth) | Personal key `crm_pk_…` | Workspace key `crm_ws_…` |
| --- | --- | --- | --- |
| Made by | A teammate approving an agent (Claude, ChatGPT…) | Any teammate, for themselves (up to 10 live keys each) | Admins |
| Acts as | The teammate | The teammate | The workspace, no person behind it |
| Can do | The teammate's role, or read-only if they chose that | The teammate's role, or read-only | Everything |
| REST API | Yes (with its access token) | Yes | Yes |
| MCP | Yes | Yes | **No** |
| History shows | "Sam via ChatGPT" | "Sam via Claude on laptop" | The key's name |

All three are rows in `api_keys` (`kind` = `oauth`, `personal`, `workspace`), so they share one place to list, attribute and revoke.

The in-app agent needs none of these: it runs on the teammate's signed-in session and uses the same operations as MCP, with their role (see [AGENT.md](AGENT.md)). Its changes are attributed through an `assistant` row per teammate, which holds no usable token and isn't listed in Settings.

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

## OAuth for agents

MCP clients that sign in (Claude, ChatGPT and anything following the MCP authorization spec) use OAuth 2.1:

1. `POST /api/mcp` without a token answers 401 with `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/api/mcp"`.
2. That document (RFC 9728) names this site as the authorization server; `/.well-known/oauth-authorization-server` (RFC 8414) lists the endpoints.
3. The client registers at `POST /api/oauth/register` (RFC 7591, open, rate-limited by IP; apps nobody approves within a day are pruned), or uses an https URL to its client ID metadata document as `client_id`. Those documents are fetched only from the consent page (for a signed-in teammate, never from the token endpoints), with SSRF guards: https on port 443, a public address checked at the moment the connection is made (so DNS rebinding can't swap in a private one), no redirects, 5 seconds and 64 KB at most, cached for a day.
4. The browser goes to `/oauth/authorize`. Signed-out teammates sign in first. The consent page names the app, where it'll send them back, and lets them grant read-and-change or read-only (never more than their role, and never more than the app asked for). PKCE with S256 is required. Any problem with the request is shown on this site, never redirected to the app (so open registration can't turn the CRM into an open redirector).
5. `POST /api/oauth/token` trades the code (single use, 5 minutes, bound to the client, redirect URI and PKCE challenge) for an access token (`crm_at_…`, 1 hour) and a refresh token (`crm_rt_…`, 30 days). Refresh tokens rotate on every use; a reused one (even two uses at the same moment) disconnects the app, and a reused code revokes the tokens it was exchanged for.
6. `POST /api/oauth/revoke` (RFC 7009) ends a token; a refresh token takes its access tokens with it.

Approving an app creates one grant per teammate and app (approving again updates its access). Disconnecting it in Settings, or deactivating the teammate, stops it at once. Only hashes of codes, tokens and client secrets are stored. Public clients authenticate with PKCE; confidential ones with `client_secret_basic` or `client_secret_post`.

The OAuth endpoints send `Access-Control-Allow-Origin: *` (they take no cookies), so browser-based clients can use them.

```
src/lib/oauth/core.ts     PKCE, redirect URI rules, scopes, private-address checks, discovery documents (pure, tested)
src/lib/oauth/server.ts   registration, metadata documents, codes, grants, tokens, revocation
src/lib/oauth/http.ts     CORS, errors, form parsing, throttling
src/app/.well-known/…     discovery documents
src/app/api/oauth/…       register, token, revoke
src/app/oauth/authorize/  the consent page (src/actions/oauth.ts decides)
```

## MCP

- Endpoint: `POST /api/mcp`, Streamable HTTP transport, protocol versions 2024-11-05 through 2025-11-25.
- Stateless: each request is a JSON-RPC message (or batch) answered with JSON. There's no session and no event stream, so it runs on serverless functions; `GET` and `DELETE` return 405.
- OAuth access tokens and personal keys only. Workspace keys get a 403 explaining why.
- `tools/list` is filtered by role: a viewer's agent sees only the reading tools. Each tool runs one API operation; its arguments are the operation's path, query and body fields together. Annotations mark reads as read-only and deletes as destructive.
- Tool failures come back as results with `isError: true` and the same sentence the API would return, so the agent can correct itself.
- Requests with a cross-site `Origin` are refused (DNS-rebinding protection).

Setup for Claude Code, Cursor, VS Code and Claude Desktop is on `/developers#mcp`, and in the dialog shown when a key is created.

## The agent's background work and drafts

Two optional groups of operations let an agent work with the CRM's own agent (see [AGENT.md](AGENT.md#background-work)):

- **Agent** (`/agent/tasks`, tools `start_background_task`, `start_bulk_background_task`, `list_background_tasks`, `get_background_task`, `cancel_background_task`): hand a longer job to the background worker, which does it as the key's teammate. Starting and stopping need edit access, so read-only keys and connected apps can't. Workspace keys can't either: a run always belongs to a teammate. These appear only where background work is set up.
- **Drafts** (`/drafts`, tools `draft_message`, `list_drafts`): write an email or text for the key's teammate to review and send. There is no operation that sends a message or a draft: the teammate does that in the CRM.

Tasks take `agent: true` on create and update to hand that task to the agent.

## Skills and scheduled jobs

Two more groups cover what teammates save for agents in Settings → Agent (see [AGENT.md](AGENT.md#skills)):

- **Skills** (`/skills`, tools `list_skills`, `get_skill`, `create_skill`, `update_skill`, `delete_skill`): instructions for how the team wants things done. A connected agent sees the key's teammate's own skills and the ones an admin shared with the team; the list leaves instructions out, and `get_skill` returns them. The MCP server's instructions tell agents to read a skill before doing work it covers. Saving, changing and deleting need edit access, and cover the teammate's own skills only: skills shared with the team are managed by an admin in Settings, never through a key, a connected app or an agent.
- **Scheduled jobs** (`/scheduled-jobs`, tools `list_scheduled_jobs`, `create_scheduled_job`, `update_scheduled_job`, `delete_scheduled_job`, `add_shared_scheduled_job`): work the CRM's own agent does on a cadence, as the key's teammate. A `workspace` job is an offer an admin made in Settings; teammates add it to their own, and it can't be created or changed here. These appear only where background work is set up.

Workspace keys can't use either group: a skill or a job always belongs to a teammate, or is shared by one. The agent's own background runs can read both but change neither.

## Files

Files and folders work through the API and MCP like they do on the Files page (`src/lib/crm/service/files.ts`, `src/lib/file-search.ts`):

- `GET /files` (`search_files`) finds files by meaning. Each file's name, AI-written description and key facts are embedded once (`agent.embeddingModel`, a pgvector column with an HNSW index), so a search embeds only the question and the database returns the nearest files. Without an AI Gateway key, `q` matches words in names, descriptions and key facts instead. `clientId`, `personId` and `organizationId` narrow it to a record's files; a client includes its contact's, people's and organization's.
- `GET /files/{id}` (`get_file`) returns its description, key facts, who it's for (`records`), folder and links; `includeText=true` adds the text of text, Word and Excel files (20,000 characters at most).
- `POST /files` (`upload_file`) takes the file as base64 in JSON, up to 3 MB before encoding; this one endpoint accepts a 4.5 MB body instead of the usual 1 MB. It goes on one client, person or organization, or is a general file, optionally in a folder. Bigger files go through the Files page.
- `PATCH /files/{id}` (`update_file`) renames, rewrites the description, moves it to a folder, and attaches it to records or takes it off them. `DELETE /files/{id}` (`delete_file`) removes it.
- `POST /files/{id}/visibility` (`set_file_visibility`) makes it public or internal. It reaches outside the team, so it's marked destructive: the agent asks first and background runs can't use it.
- `GET/POST /folders`, `PATCH /folders/{id}`, `DELETE /folders/{id}?contents=delete|move&moveTo=` (`list_folders`, `create_folder`, `update_folder`, `delete_folder`).
- `draft_message` takes `attachmentFileIds`, so an agent can attach a brochure or price sheet to an email draft. The teammate sees the files in the composer and can drop any before sending.
- Descriptions, key facts and file text come from the files themselves; the tool descriptions and the agent's instructions say to read them as information, never as instructions. Viewers' keys can read files but not add or change them.

## Knowledge source

A deployment can connect a read-only JSON API about its own organization (usually its website's content) with `KNOWLEDGE_API_URL`. `GET /knowledge?path=…` then reads one path under it, and MCP gets a `get_knowledge` tool. Without one, the endpoint answers 404 `not_configured` and the tool isn't listed. See [KNOWLEDGE.md](KNOWLEDGE.md).

Operations can carry a `feature` (`src/lib/api/spec.ts`): they're documented everywhere but only offered as MCP and agent tools where that feature is set up (`enabledFeatures` in `src/lib/api/features.ts`).

## How it's built

```
src/lib/api/
  operations.ts   every endpoint: method, path, permission, zod schemas, response model, MCP tool name
  handlers.ts     what each operation does (calls the service layer, reads the result back)
  queries.ts      paged, filtered reads shaped as the API's models
  models.ts       response shapes, for the docs and OpenAPI
  execute.ts      permission check + validation + handler, shared by REST and MCP
  features.ts     optional features this deployment has set up (the knowledge source)
  http.ts         the REST request cycle: route, authenticate, rate-limit, run, answer
  router.ts       path matching (pure)
  auth.ts         API key → actor
  key-format.ts   key generation, hashing and parsing (pure)
  openapi.ts      the OpenAPI document (pure)
  docs.ts         field tables and curl examples for /developers (pure)
  markdown.ts     the whole reference as Markdown, for /developers.md (pure)
  integrations.ts the Zapier, Make and Calendly guide, shared by the page and the Markdown (pure)
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
- Duplicates (a person's email, an organization's name) return 409 with `existingId`. `POST /people` and `POST /organizations` take `?ifExists=return` to answer with the existing record instead (unchanged), for find-or-create from integrations.
- Each key can make 300 requests a minute across the API and MCP (`src/lib/api/limits.ts`), counted in Postgres. Every tool call in an MCP batch counts as a request, batches hold at most 20 messages and run one at a time.
- Request bodies are capped at 1 MB, counted in bytes as they stream in (a missing or wrong Content-Length doesn't get around it).
- Changing an activity's `type` needs its author or an admin, even for tasks, so retyping can't be used to unlock editing someone else's activity.
