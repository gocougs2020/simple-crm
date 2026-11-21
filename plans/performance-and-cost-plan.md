# Implementation prompt: performance and cost

You are working in the `simple-crm` repository (Next.js 16 App Router with Cache Components, React 19, Drizzle, Neon Postgres over the `neon-http` driver, Vercel). An audit found the issues below. Your job is to fix them, one work package at a time, without removing or changing any functionality a user can see, except where a package says the behavior should change.

The goal has two halves, and both matter:

- **Faster**: less JavaScript on first load, fewer database round trips per render, instant feedback on common actions.
- **Cheaper**: fewer function invocations, fewer queries, fewer LLM tokens, and a database that can sleep when nobody is working.

Freshness is a hard requirement. The app shows a teammate's change, an agent's work and incoming mail without a reload, within the current poll interval. Nothing you do may make a page show stale data for longer than it does today.

## Ground rules

1. Read `AGENTS.md` and `docs/ARCHITECTURE.md` before writing code. Follow every convention in `AGENTS.md` (server actions, `recordEvent`, the service layer and `Actor`, theme tokens, copy style).
2. This Next.js version is newer than your training data. Before using or changing any Next.js API (`'use cache'`, `cacheLife`, `cacheTag`, `updateTag`, `refresh()`, `next/dynamic`, `connection()`, prefetching), read the matching guide in `node_modules/next/dist/docs/`. For the agent worker in `agent/`, read `node_modules/eve/docs/` first. For AI SDK options, check the types in `node_modules/ai` and `node_modules/@ai-sdk/gateway`.
3. File paths and line numbers below come from the audit and may have drifted. Open each file and confirm the code matches the description before changing it. If it doesn't match, search for the described code; if you still can't find it, skip that item and say so in your report.
4. One work package per branch and pull request, in the order given. Do not mix packages. Keep each diff to what the package names.
5. Before each commit run `pnpm lint && pnpm typecheck && pnpm test && pnpm build`. All four must pass.
6. Schema changes: edit `src/db/schema.ts`, then `pnpm db:generate --name <what-changed>`, and commit the generated migration. Never hand-edit an existing migration. Local development uses PGlite (`src/db/index.ts`), so every migration must also apply there: start `pnpm dev` once against a fresh `.data/` directory and load a page.
7. UI changes need a real pass in the browser (`pnpm dev`, port 3200, Settings → Workspace → Add sample data), not only a compile. State in the pull request what you clicked through.
8. Never weaken an auth, permission or signature check to save a query. Where a package touches auth, it says what must be preserved.
9. Do not change the agent's safety rules (`runMayUse` in `src/lib/agent/run-rules.ts`) or the confirmation behavior of chat tools (`needsConfirmation`).
10. When a package says "measure", record the before and after numbers in the pull request description.
11. If something is ambiguous or a fix would change visible behavior beyond what the package describes, stop that item, finish the rest, and list the open question in your report.

## What is already good: leave it alone

- `getUser`, `getAppData` and `getWorkspace` are wrapped in React `cache()`.
- The agent panel, Twilio Voice SDK, `read-excel-file` and `papaparse` already load on demand.
- The board drag is already optimistic with rollback (`src/components/clients/board.tsx`).
- People and Organizations tables page 100 rows at a time (`usePagedRows`).
- API key auth is one joined query, with `lastUsedAt` throttled and deferred with `after()`.
- Polling stops when the tab is hidden or idle. Keep that rule.
- The proxy (`src/proxy.ts`) only checks for the cookie. Keep it free of database work.
- Background runs already defer tools, cache prompts and compact (eve handles it).

---

## Package 1: indexes

**Why.** Several hot queries can't use an index. The worst: the timeline and feed query looks up `inbox_messages` by `activity_id` twice per row, and that column has no index.

**Do.**

1. `inbox_messages(activity_id)`: add an index (`src/db/schema.ts`, the `inboxMessages` table, near line 1232).
2. In `src/lib/crm/activities.ts` (near lines 57-58), the two correlated subqueries `inboxFrom` and `inboxTo` each scan `inbox_messages`. Fold them into one lookup (a lateral join or a single subquery returning both values) that is only evaluated when `activities.inbox_thread_id is not null`. The returned shape must not change.
3. Home feed: `teamFeed` in `src/lib/crm/activities.ts` (near lines 22 and 290-295) orders by `coalesce(occurred_at, completed_at, created_at)`. Add a descending expression index on `activities` for exactly that expression, written so the query's `ORDER BY` matches it textually.
4. Planned work: add partial indexes on `activities (client_id, due_at)` and `activities (person_id, due_at)` with `where completed_at is null and due_at is not null`. These serve `nextActivity` (`src/lib/crm/records.ts` near 15-22), `clientsWithoutNextStep` and `myDueCounts`. Check each query's predicate and make the index predicate match it.
5. Unread counts: read the sidebar unread queries in `src/lib/conversations/read-state.ts` and add indexes that match their filters on `inbox_threads` and `text_threads` (the existing `inbox_threads_inbox_idx` leads with `resend_inbox_id`, which those counts don't filter on first).
6. Foreign keys with no index on `activities`: `email_id`, `inbox_thread_id`, `synced_email_id`, `agent_run_id`. Add one index each.
7. `outbound_emails(created_at)`: used by `reconcileDeliveryStatuses` (`src/lib/email/delivery.ts` near 240-253). Add an index, partial on non-final statuses if the query's predicate allows.
8. `rate_limits(window_start)`: add an index (the cleanup filters on it; see package 7).
9. Search and labels:
   - Search uses `ILIKE '%q%'` (`src/lib/crm/records.ts` near 54-57, 283-285, 476-499). Add `pg_trgm` GIN indexes on the exact name expressions and on email. This needs `create extension if not exists pg_trgm` in the migration. Look at how the existing migrations enable `vector` and mirror that. For PGlite, load the `pg_trgm` extension from the PGlite package in `src/db/index.ts` the same way `vector` is loaded (check the PGlite package for its contrib export). If PGlite can't load it, stop this item and report; do not ship a migration that breaks `pnpm dev`.
   - Label filters use `jsonb ?` on `tags` (`records.ts` near 61, 276, 281). Add GIN indexes on `people.tags`, `organizations.tags` and `clients.tags`.
   - The default People sort is `lower(first || ' ' || last)`. Add an expression index that matches the sort expression exactly.

**Verify.** Migrations apply on a fresh PGlite database and the app loads. If you have a Neon branch available, run `EXPLAIN` on the timeline query, the feed query and a People search and paste the plans in the pull request. Otherwise say plans were not measured.

**Don't.** Don't drop any existing index. Don't change query results.

---

## Package 2: stop shipping the rich text editor on every page

**Why.** About 180 kB (gzipped) of Tiptap and ProseMirror is in the `(app)` layout's JavaScript, so every signed-in page pays for it, including Settings. Two static import chains cause it:

- `src/components/shell/app-shell.tsx` → `activity/next-step-dialog.tsx` → `schedule-next.tsx` → `composer.tsx` → `ui/rich-text.tsx`
- `src/app/(app)/layout.tsx` → `phone/call-panel.tsx` → `ui/rich-text.tsx`

**Do.**

1. Record the baseline: run `pnpm build` and note the first-load JavaScript for `/`, `/people`, `/settings` and a client record page.
2. Make the editor load on demand. Preferred: keep `src/components/ui/rich-text.tsx` as a thin wrapper with the same props that loads the real editor (move it to `rich-text-editor.tsx`) with `next/dynamic` and `ssr: false`. Follow the pattern already used in `src/components/agent/agent-launcher.tsx`. This fixes every import chain at once.
3. The loading placeholder must reserve the editor's height and look like the empty editor (same border, padding and placeholder text, theme tokens only), so nothing jumps when it arrives.
4. Preload it so people never wait: call the dynamic import when a composer, note or call panel is about to open (pointer enter or focus on the control that opens it), and once when the browser is idle after first paint (`requestIdleCallback` with a timeout fallback).
5. Nothing typed may be lost: if the wrapper receives an initial value before the editor has loaded, the editor must mount with it.
6. Also load on demand the parts of `NextStepDialog` and the active-call panel that only render when open, if they still pull heavy code after step 2. Check the build output instead of guessing.
7. People and Organizations import `BulkButton` from `src/components/clients/clients-view.tsx`, which drags in the board, `@dnd-kit` and the composer. Move `BulkButton` into its own leaf module and update imports.
8. Load the clients board (`board.tsx`, `@dnd-kit`) with `next/dynamic` only when the view is "board". The table view must not load it.
9. `src/components/activity/email-composer.tsx` imports `MAX_EMAIL_RECIPIENTS` from `src/lib/crm/schemas`, pulling zod into the client. Move the constant to a module with no zod import (for example `src/lib/constants.ts`) and re-export it from `schemas` so server code is unchanged.
10. Check for unused dependencies: `react-day-picker` and `@tiptap/core` had no direct imports. Remove one only if `pnpm build` and `pnpm typecheck` still pass and it is not a peer dependency of something in use.

**Verify.** Rebuild and report the same four routes. `/settings` should drop by roughly the editor's size. In the browser: open a composer on a client, write a note with formatting, save it; start the next-step dialog; open the email composer; if Twilio is not configured, confirm the call panel code path still compiles.

---

## Package 3: fewer round trips per render, and a sidebar that paints first

**Why.** Each query is its own HTTPS request. The `(app)` layout runs about 18 queries in four sequential waves on every render and every refresh, and the whole shell waits behind them, so a hard load is blank until all of it finishes.

**Do.**

1. `src/app/(app)/layout.tsx` (near lines 21-39): start `getAppData()` at the same time as the user lookup instead of after it. The redirect for a signed-out user must still happen before any data is sent to the browser.
2. The sidebar badge counts (due, unread email, unread texts, comms, unread chat) should not block the shell. Pass them down as promises and read them with `use()` inside their own `<Suspense>` with a fallback that shows no badge, so the sidebar and page frame paint after one round trip. `AppShell` is a client component, so pass the promises as props from the server layout.
3. Merge those sidebar counts into a single SQL statement (several scalar subqueries in one `select`) so they cost one round trip, not five or more.
4. `unreadChat` (`src/lib/chat/service.ts` near 200-208) reads the user's `chatReadAt` in one query and counts in a second. The user row is already loaded: take `chatReadAt` from it.
5. Wrap `getClient`, `getPerson` and `getOrganization` (`src/lib/crm/records.ts`) and `myDueCounts` in React `cache()`. Record pages call the getter once in `generateMetadata` and again in the page; the home page repeats `myDueCounts` from the layout. `cache()` keys on arguments, so make sure they are primitives.
6. `/api/live` (`src/app/api/live/route.ts`, `src/lib/live.ts`): if it makes more than one HTTP query per poll, combine them into one statement.
7. `src/app/(app)/email/page.tsx`: it awaits `listInboxes()` (a Resend API call) and then about five sequential database awaits. Run the independent ones with `Promise.all`.
8. Cache `listInboxes()` (`src/lib/email/inbox.ts` near 87-98). It makes no database call, so it is a safe `'use cache'` candidate: give it a tag, a `cacheLife` of a few minutes, and invalidate the tag from every settings action that adds, changes or removes an inbox or domain. Read the Cache Components docs first; note what they say about cache hit rate on serverless and choose the cache kind accordingly.
9. Over-fetching, where it is safe:
   - `getAppData` (`src/lib/crm/context.ts` near 31) selects full `users` rows, including `passwordHash`. Select only the columns the app context needs. Confirm nothing downstream reads the hash from that list.
   - Every `select()` on `files` drags the 1,536-dimension `embedding` (`src/lib/crm/service/files.ts` near 36, 177, 443; `src/app/api/files/[id]/route.ts` near 18). Select explicit columns without `embedding` wherever the embedding isn't used.
10. Do not put app-wide data (pipelines, fields, labels) behind `'use cache'` in this package. `getDb()` calls `connection()`, which cached functions can't use, and package 4 removes most of the repeated work. Leave a short note in the pull request if you think it is still worth doing afterwards.

**Verify.** Add temporary logging or count by reading: report queries per render before and after for the home page, the People list and a client page. On a hard reload with network throttling, the sidebar should appear before the page's data. Signed-out users must still be redirected.

---

## Package 4: refresh only what changed, once, and make common actions feel instant

**Why.** Every server action calls `refresh()`. The write also moves the workspace-wide live version (`src/lib/live.ts`), and the browser's `LiveUpdates` (`src/components/live-updates.tsx` near 86-90) doesn't know its own action caused that, so the next poll calls `router.refresh()` a second time. And because there is one version for the whole workspace, a chat message, a synced email or a cron write re-renders every open tab on every page. Each re-render repeats the layout's queries, and scrolled tables refetch every loaded row (`src/components/table/use-paged-rows.ts` near 42-60).

**Freshness rules you must keep.** A teammate's edit, the agent's work and incoming mail still appear on an open page within the same poll interval as today. Your own change appears immediately. The glow on what changed (`live-highlight.ts`) keeps working. Hidden and idle tabs still don't poll.

**Do.**

1. **No double refresh after your own action.** After a server action succeeds and refreshes, the client must adopt the new version without refreshing again. The simplest safe way: after any action completes, have `LiveUpdates` re-read `/api/live` and store the value as its baseline without triggering a refresh (expose a small function next to the existing `checkForChanges()`), and call it from the shared place actions return through on the client. If another change landed in the same window, the poll after that still catches it, so nothing is missed. Do not try to compute the version inside each of the 136 action call sites.
2. **Scoped versions.** Change `/api/live` to return several versions in one response and one query: at least `records` (events and activities), `chat` (chat messages) and `mail` (inbox and text threads, if those tables have a usable `updated_at`; check the schema). Each page declares which scopes it shows. `LiveUpdates` refreshes only when a scope the current page cares about moved. The sidebar badges care about `chat` and `mail`, so when only those move on a page that doesn't otherwise show them, refresh just the badges (see step 3) instead of the page.
3. **Badges without a full refresh.** Give the sidebar counts their own small server action or route that returns the counts in one query (the merged statement from package 3), and have the shell update them from that when `chat` or `mail` moves. The page tree is not re-rendered for a badge.
4. **Chat page.** It polls every `live.chatPollSeconds` (5) and each new message triggers a full layout refresh. Fetch only messages newer than the last one shown and append them; keep the read marker behavior.
5. **Scrolled tables.** When a refresh lands, `usePagedRows` refetches every loaded page. Keep the rows already loaded and refetch only the first page plus the total, unless the filter or sort changed. A row that changed further down is refetched when the user next scrolls or interacts with it; say so in the pull request, and stop and report instead if you find a case where this would show wrong data for long.
6. **Optimistic UI.** There is no `useOptimistic` in the repo. Add it for the three highest-traffic interactions in `src/components/activity/timeline.tsx`: completing a task (near 297-303, the checkbox is disabled until the server answers), pinning, and adding a reply. Show the result immediately, roll back and show the error if the action returns `ok: false`. The "what's next" dialog after completing a client's last task depends on the server's answer: keep that part waiting for the result.
7. **Task panel polling.** `src/components/agent/agent-tasks.tsx` (near 14, 131, 144-149) polls every 4 seconds while a run is active, two requests each time. Back off to 10-15 seconds after the first minute of a run, and return the live versions from `listAgentTasks` so the separate `/api/live` call isn't needed.
8. **Context re-renders.** `AppProvider` (`src/components/app-context.tsx`) rebuilds its value on every refresh and re-renders its roughly 127 consumers. Memoize the context value so it keeps the same identity when the data is deep-equal, or split rarely-changing data (pipelines, fields, labels, team) from per-request data. Profile with React DevTools before and after; skip this step if the profile shows no meaningful gain.
9. **Prefetch record routes.** Table rows navigate with `router.push` (`src/components/table/data-table.tsx` near 138-143), so nothing is prefetched. Call `router.prefetch` for the row's route on pointer enter or focus, once per row.

**Verify.** With two browsers signed in as different teammates:
- Add a note in one. It appears in the other within the poll interval, with the glow.
- In the first browser, the network tab shows one refresh for the action, not two.
- Post a chat message. A tab on a client page updates its chat badge without re-rendering the page.
- Complete a task: the checkbox responds at once; force a failure (for example, sign the user out in another tab) and confirm it rolls back with a message.
- Leave a tab hidden: no polling.

---

## Package 5: timelines that send less

**Why.** A record timeline loads up to about 600 items (100 planned, 300 done, 200 history events, plus up to 500 files) and re-sends them all on every render and refresh, with full HTML bodies, into one 1,161-line client component.

**Do.**

1. Send the first 50 timeline entries and load more as the user nears the bottom, using the same approach as `usePagedRows`. Planned (open) items always load in full, since they are few and matter most.
2. Filter chips that show counts need a server count: add one grouped count query instead of counting in the browser.
3. In list contexts (the Activities page, the home feed), don't select the full HTML body; select a truncated plain-text preview. The record timeline still needs bodies for the entries it shows.
4. Add `content-visibility: auto` with a sensible `contain-intrinsic-size` to timeline entries.
5. `listClients` returns up to 1,000 full client rows with four subqueries each (`src/lib/crm/records.ts` near 310-329). Select only the columns the board and table use. If a category can hold hundreds of clients, page the table view the same way People is paged; leave the board loading all cards in view, since drag order needs them.
6. Split `timeline.tsx` only as far as this work needs (for example, one file per entry type). Don't refactor beyond that.

**Verify.** On a record with more than 50 entries (create them with sample data or a script against local PGlite): the first 50 show, scrolling loads more, filters and their counts are right, live updates still add a new note at the top with the glow, search within the timeline (if present) still finds older entries.

---

## Package 6: batch writes

**Why.** A typical change is 5-10 sequential round trips, and bulk actions insert one history row per record in a loop of up to 500.

**Do.**

1. Bulk archive and bulk label (`src/lib/crm/service/records.ts` near 258 and 278) and the file equivalents (`src/lib/crm/service/files.ts` near 84-85, 183, 466): replace per-record `recordEvent` calls in a loop with one multi-row insert. Add a `recordEvents` (plural) helper next to `recordEvent` so the row shape stays in one place. Every record that changed still gets its own history row, with the same content as today.
2. `touch` per extra attendee (`src/lib/crm/service/activities.ts` near 128 and 302): one update with `inArray`.
3. `labelRelations` (`src/lib/crm/events.ts` near 20-24) does serial lookups: run them together.
4. Where a record update and its history row are written back to back, send them in one round trip with the driver's batch call so they are also atomic. `db.batch` exists on the neon-http driver but not on PGlite: add a small helper in `src/db/` that uses `batch` on Neon and runs the statements in order inside a transaction on PGlite. Start with `updateOrganization`, `updatePerson` and `updateClient`; don't convert every action.
5. Do not move hot paths onto `withTransaction` (`src/db/transaction.ts`): it opens a new WebSocket pool per call and is meant for rare merges.
6. Agent threads (`src/lib/agent/threads.ts` near 45-58): the thread's full JSON (up to 800 KB) is written twice per chat turn. If the save before streaming exists only to persist the user's message, write it once after the turn, or append instead of rewriting. A message must never be lost if the stream fails: keep the earlier save if you can't guarantee that.

**Verify.** Unit tests for the new helpers. In the browser: bulk-add a label to 20 people and confirm each person's history shows the entry; edit an organization and confirm one history entry.

---

## Package 7: crons that do nothing cheaply, and cleanup

**Why.** Five cron functions fire every 15 minutes around the clock. Each wakes the database, and several write even when there is nothing to do, which stops Neon from sleeping overnight and at weekends.

**Do.**

1. **Inbox sync** (`src/lib/email/inbox.ts` near 310-315): it issues one `UPDATE` per thread whether or not anything changed, up to 25 per inbox, in sequence. Read `folder` and `read` in the lookup it already does and update only rows that differ.
2. **Agent cron** (`src/app/api/cron/agent/route.ts` near 21-36): `pruneForwards` (`src/lib/forwarding/inbound.ts` near 435-444) runs a `DELETE` and an `UPDATE` on every tick. Run pruning once a day (see step 6). Combine the remaining "is anything due?" reads so an idle tick is one or two queries.
3. **Notifications cron** (`src/lib/push/due.ts` near 39-41): it runs three near-identical `usersWanting` queries. Make it one.
4. **Microsoft cron** (`src/lib/microsoft/mail.ts` near 185-187): the team and mailbox lookup repeats per mailbox. Hoist it out of the loop.
5. **One dispatcher.** Replace the five quarter-hour entries in `vercel.json` with one route (for example `/api/cron/tick`) that runs a single cheap query answering "is anything due for campaigns, the agent, notifications?" and calls only the jobs that have work, each wrapped so one failure doesn't stop the others. Keep the existing routes working (they are also called by hand and documented), keep `cronAuthorized` on every one, and keep `maxDuration` sufficient for the combined work. The inbox and Microsoft syncs are safety nets behind webhooks and delta sync: run the inbox sync hourly from the dispatcher instead of every 15 minutes; leave Microsoft on its `microsoft.syncEveryMinutes` setting.
6. **A daily prune**, run from the dispatcher once a day: `notifications` older than 90 days, expired `auth_tokens`, expired `sessions`, expired `rate_limits` windows, the forwards prune from step 2, and finished `agent_runs` whose `hide_at` passed more than 90 days ago (clear the prompt and result text; keep the row and its cost, since history refers to it). Make each age a constant with a comment. **Do not prune `events`**: history is a product feature.
7. **Rate limit cleanup** (`src/lib/rate-limit.ts` near 25-37): remove the `DELETE` that runs after every request; the daily prune covers it. The limit check itself must behave exactly as before. `src/lib/agent/http.ts` (near 31-34) makes two upserts per chat message: combine into one statement if both limits can be checked together without changing either limit.
8. Update `docs/ARCHITECTURE.md` (Background jobs) and `docs/DEPLOYING.md` to describe the new schedule. Both currently list five crons while `vercel.json` has seven; make them accurate.

**Verify.** Call the dispatcher locally with nothing due and confirm from logs that it makes one or two queries and no writes. Schedule a campaign for the next quarter hour and confirm the dispatcher sends it. Confirm an unauthenticated request to the dispatcher is refused when `CRON_SECRET` is set.

**For the maintainer, outside the code:** check the autosuspend delay on the Neon project. With a 5-minute delay, the old schedule kept the database awake at least 8 hours a day with nobody working.

---

## Package 8: the agent's token bill, and API and MCP overhead

**Why.** The chat agent sends all 77 tools (about 17k tokens of definitions) on each of up to 12 steps per turn, with no prompt caching, and a minute-precise clock near the top of the system prompt that would break a cached prefix anyway. The whole stored thread is replayed every turn, including old tool results of up to 40k characters each.

**Do.**

1. **Stable prefix.** In `src/lib/agent/prompt.ts` (near 177), move the current time and the "page the teammate is on" note out of the top of the system prompt to the very end (or into a trailing message), so everything before it is identical between turns. Keep the time's precision if any instruction depends on it; otherwise use the date and the hour.
2. **Turn on caching.** In `src/app/api/agent/chat/route.ts` (near 70-91) set the gateway's caching provider option. Confirm the exact option name and shape in the installed `@ai-sdk/gateway` types before using it; the audit saw a `caching: "auto"` option there. Log cached versus uncached input tokens from the usage the SDK reports, if it reports them, so the saving can be seen.
3. **Trim tool definitions.** In `src/lib/agent/tools.ts` and `src/lib/api/operations.ts`: shorten property descriptions that restate the property name, drop `maxLength` from schemas sent to the model where the server validates anyway (keep the server validation), and simplify nullable `anyOf` shapes where an optional property says the same thing. Tool names, required parameters and behavior must not change, and the public REST and MCP docs generated from the same list must still be correct. Report the size of the definitions before and after.
4. **Prune history sent to the model, not stored history.** In the chat route (near line 85), before `convertToModelMessages`: replace tool outputs older than the last 3 turns with a short stub ("result omitted; call the tool again if needed") and cap the model-side history at a character budget, dropping oldest turns first. Storage (`src/lib/agent/messages.ts`) is unchanged. Parts that are waiting for the teammate's approval must never be pruned or stubbed.
5. **Timeline reads for tools.** `src/lib/api/queries.ts` (near 487-498) calls the UI's `timeline()`, which loads up to 300 done activities, 100 planned, 200 events, 500 files and 200 inbox rows and then slices to `limit`. Give the API its own queries that apply `limit` in SQL. `planned` currently ignores `limit`: make it respect it.
6. **Smaller tool results.** For agent and MCP tool results only (not the REST API, whose consumers may rely on both), drop the HTML `body` when `bodyText` is present (`queries.ts` near 391-392, 411). Lower the default list limit for tools to 20; an explicit `limit` still works as before.
7. **MCP results.** `src/lib/mcp/server.ts` (near 71) returns the JSON twice (as text and as `structuredContent`) with no cap. Apply the same `capResult` the in-app chat uses, and check the MCP spec version the server declares before deciding whether the text copy can be shortened; if clients need both, keep both and only cap.
8. **MCP schema building.** `src/lib/mcp/server.ts` (near 57-64) and `protocol.ts` (near 68-85) rebuild every tool schema on every request. Memoize per operation at module scope and filter per actor.
9. **Background-run auth.** Each MCP call from a run does three sequential queries (`src/lib/agent/run-actor.ts` near 21-31, `src/lib/agent/actor.ts` near 19-34). Make it one join across `agent_runs`, `users` and `api_keys`. This is the auth path: the result must still refuse a run that isn't running and a deactivated user, exactly as now. Add a unit test for both refusals.
10. **File tools.** `src/lib/api/handlers.ts` (near 361-364) loads the whole app context (10 queries) to get uploader names. Join `users` in the file query instead.
11. **Chat start-up.** The chat route makes about 10 round trips before streaming: `ensureThread` inserts then selects (use `returning`), and `listLabels` is awaited on its own (near line 80). Run the independent reads together.

**Verify.** Run a chat turn that reads a client, logs a note and asks a follow-up. Confirm tools still work, confirmations still appear for the actions that need them, and report input tokens for the same conversation before and after. Run one background task end to end. Run `pnpm test` (the operation list has tests).

---

## Package 9: summaries, Stripe and the rest

**Do.**

1. **Record summaries** (`src/lib/agent/summary.ts` near 48-53, `summary-prompt.ts` near 5 and 13): a summary is rewritten on any view once it is 24 hours old, even if nothing changed. Skip the rewrite when the record's `updated_at` and `last_activity_at` are not newer than `summary_at` and no planned item has come due since. Keep a hard limit of 7 days so relative phrases ("in 3 days") don't go stale.
2. **Summary model** (`app.config.ts` near 330): `summaryModel` defaults to the chat model. Default it to the cheaper tier already used for file descriptions. It stays overridable per deployment; note the change in `docs/AGENT.md`.
3. **Summary billing lines** (`summary.ts` near 277-280): they call Stripe live, up to 4 customers and 6 requests each, in sequence. Build them from the synced `stripe_customers` and `stripe_subscriptions` tables and the `clients.stripe_*` columns instead.
4. **Client page billing card** (`src/lib/stripe/client-billing.ts` near 73, `src/lib/stripe/index.ts` near 51): six Stripe calls per customer on every view, uncached. Cache per customer for 2 minutes, and bypass the cache for "Check Stripe now". Follow the Cache Components docs; the function must not touch the database inside the cached scope.
5. **Knowledge fetches** (`src/lib/knowledge/core.ts` near 242): cache responses for a short time (1-5 minutes), keyed by the full path and query.
6. **Resend webhook** (`src/app/api/webhooks/resend/route.ts`, `src/lib/email/inbox.ts` near 134-197): a full thread sync per event makes four serial Resend calls. Run the independent reads together and merge the two status selects. Signature verification must stay first and unchanged.
7. **Microsoft sync** (`src/lib/microsoft/mail.ts` near 106, 137-146; `src/app/api/cron/microsoft/route.ts` near 36): sync 3 mailboxes at a time instead of one. Moving the default folders to delta queries is a larger change: only do it if the delta path for user-picked folders can be reused as is, and keep the screening order (sensitivity label, then the decision model) exactly as it is. Otherwise leave it and say so.
8. **Function region.** Nothing pins the function region. Add a short section to `docs/DEPLOYING.md` telling deployers to put Vercel functions in the same region as their Neon database, and why it matters with an HTTP driver. Don't hard-code a region in the repo.
9. **Analytics.** `src/app/layout.tsx` (near 43-48) always loads Vercel Analytics and Speed Insights in production. Add `app.config.ts` knobs for each (on by default, with a sample rate for Speed Insights) and document them in `docs/THEMING.md`, per `AGENTS.md`.

**Verify.** View a client twice a day apart in test (or by setting `summary_at` back): unchanged record keeps its summary; add a note and it rewrites. The billing card still loads, and "Check Stripe now" still fetches live.

---

## Your report

When you finish (or stop), report per package: what changed, the before and after numbers the package asked for, what you verified in the browser, anything skipped and why, and open questions. Be exact about what was measured and what was only read.
