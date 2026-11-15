# Architecture

One Next.js app. Server components read the database directly; server actions change it through a shared service layer; a handful of route handlers cover files, cron and unsubscribe. The REST API (`/api/v1`), the MCP server (`/api/mcp`) and the in-app assistant (`/api/agent`) go through the same service layer, so the browser, integrations and agents follow the same rules and write the same history (see [API.md](API.md) and [AGENT.md](AGENT.md)).

## Layout

```
src/
  app/
    (auth)/          sign-in, setup, forgot, reset/[token], invite/[token]
    (app)/           everything behind the login: home, clients, people, organizations,
                     activities, files, email (inbox, campaigns, audiences, templates), settings
    api/             files (upload token, local upload, download), brand logo, cron
                     (campaigns, inbox, email-status, notifications), the Resend webhook, the REST API
                     (v1/[...path]), MCP (mcp) and the assistant (agent: chat, transcribe, voice)
    manifest.ts, icon.tsx, apple-icon.tsx   the installable app: manifest and generated icons
    developers/      the public API and MCP docs, generated from the operation list
    unsubscribe/     the campaign unsubscribe page and RFC 8058 one-click endpoint
  actions/           server actions, one file per area ("use server")
  components/        UI, grouped by feature; ui/ holds the primitives; agent/ is the assistant panel
  db/                schema.ts (every table) and the connection
  emails/            React Email templates (layout, invite, reset, direct, campaign)
  lib/               server logic: auth, permissions, email (and the inbox sync), Stripe,
                     files, formatting, queries (lib/crm), record changes (lib/crm/service),
                     the REST API (lib/api), MCP (lib/mcp), the assistant (lib/agent) and push (lib/push)
  styles/theme.css   every color the app uses
public/sw.js         the service worker: shows push notifications, opens the page they point to
drizzle/             SQL migrations generated from schema.ts
app.config.ts        product defaults (name, theme, layout), overridable per deployment
                     with NEXT_PUBLIC_APP_CONFIG (src/lib/config-overrides.ts)
```

## Data model

| Table | Holds |
| --- | --- |
| `users`, `sessions`, `auth_tokens`, `rate_limits` | Team, signed-in browsers, invite/reset links, sign-in and API throttling |
| `api_keys` | Workspace keys (full access, REST only), personal keys and connected apps (act as one teammate; REST and MCP). Only a hash is stored. Each teammate's assistant has an `assistant` row too, with no usable token, so history can say "via Assistant" |
| `agent_threads` | A teammate's conversations with the assistant: title and messages (AI SDK UI messages, as JSON). Private to them |
| `push_subscriptions`, `notifications` | Devices that get push notifications (one per browser or installed app, each with its own alert types), and every notification sent, deduplicated by key |
| `workspace` | One row: name, currency, time zone, email brand kit |
| `organizations`, `people`, `clients` | The records. Each has an owner, `custom` JSON for custom fields, `last_activity_at`, and `archived_at` (soft delete) |
| `pipelines`, `stages` | Each pipeline belongs to a client category. Stages carry a win probability (prospects) and a "needs attention" threshold in days |
| `services`, `client_services` | What the workspace sells (Settings → Services), and which ones each client uses or used, at what price, from when to when |
| `client_metrics` | Performance numbers logged over time per client ("Leads", "Days to fill") |
| `activities` | Notes, calls, emails, texts, meetings and tasks in one table. Links to a person, organization and/or client |
| `events` | Change history: who changed what, from what, to what, and through which API key |
| `files` | Metadata; the bytes live in private Vercel Blob. A file added to a note, call or other activity keeps its `activity_id` and takes that activity's links |
| `custom_fields` | Field definitions per record type. Values live on the record, keyed by a stable `key` |
| `email_templates`, `campaigns`, `audiences`, `outbound_emails` | Email. `audiences` are saved campaign filters. `outbound_emails` records every message sent, with its reply-to, attachments and Resend delivery status |
| `inbox_threads`, `inbox_messages` | A mirror of the workspace's Resend inboxes, linked to people, organizations and clients |
| `people_imports` | What each spreadsheet import created and changed, so it can be undone |
| `external_ids` | Which record here came from which record in Pipedrive, so the [Pipedrive import](PIPEDRIVE-IMPORT.md) can run again without duplicating and be removed cleanly |

Choices worth knowing:

- **Clients are one table, in three categories.** A client is prospective, current or past. The category decides which pipelines it moves through (each pipeline has a `category`) and what its page shows: potential value and expected close for prospects; health, services and Stripe billing (one card), performance and time since last contact for current clients; what they had, why they left and whether they'd come back for past clients. Moving between categories (`changeClientCategory`) records dates, the reason and a history entry, and ends or starts services in the same step. Deals were renamed to clients in place (migration `0001`), so ids, links and history carried over; won deals became current clients, lost ones prospects in a "Not now" stage.
- **Monthly revenue is derived, never stored.** It's the sum of a client's open `client_services`, normalized to a month, so changing a price or ending a service is the only thing to keep up to date.
- **Activities are one table.** "Log a call" and "add a task" are the same gesture with different fields, and a record's timeline is one query. An open activity with a `due_at` is planned; one with `completed_at` or no `due_at` is history.
- **Links roll up.** Logging on a client fills in its contact and organization; logging on a person fills in their organization. The organization page is the whole story without joins across clients.
- **Money is integer cents** (`bigint`), so sums never drift.
- **Board order uses fractional ranks** (`src/lib/rank.ts`): moving a card writes only that card.
- **Custom field keys never change.** Renaming a field keeps its data; archiving hides it without deleting values.
- **History is written by the server**, next to each change, in the same action. Nothing in the UI can forge it.

## Requests

- **Pages** are server components wrapped in `<Suspense>`. With Cache Components the static shell (sidebar, headers) streams instantly and data fills in. `getDb()` calls `connection()`, so anything that touches the database is per-request by construction.
- **App-wide data** (team, pipelines, custom field definitions, workspace settings) loads once in the `(app)` layout and reaches client components through `AppProvider`, so pickers and menus open with no round trip.
- **Record changes live in `src/lib/crm/service/`.** Each function takes an `Actor` (`src/lib/crm/actor.ts`): a teammate in the browser, a teammate through their personal key, or a workspace key. It checks the actor's permission (`src/lib/permissions.ts`), validates with the shared schemas (`src/lib/crm/schemas.ts`), and writes history. Server actions wrap these and call `refresh()`; the API and MCP call them directly.
- **Roles** are one table in `src/lib/permissions.ts`: owners and admins can do everything, members work records, viewers only read. The interface hides what a role can't do; the server refuses it regardless.
- **Server actions** return `Result<T>` (`{ ok, data }` or `{ ok: false, error }`) through `run()` in `src/lib/action.ts`. Errors meant for people are `ActionError`s with a sentence that says what to do; anything else is logged and reported generically.
- **List state lives in the URL** (`?q=&owner=&sort=`), so views are shareable and survive reloads. View preferences that should follow a person across devices (board vs table, pipeline) are saved on `users.prefs`.

## Email

- `src/lib/email.ts` wraps Resend. Without `RESEND_API_KEY` it prints to the terminal.
- One-off emails (`src/actions/email.ts`) send from a person's or client's page as the teammate (their name in From) and are logged as an `email` activity. Reply-To is the teammate's own address unless they change it for that email. Sending from a Resend inbox skips Reply-To: replies come back to that inbox.
- **Attachments** are ordinary CRM files (`src/lib/email/attachments.ts`). The composer uploads them to the record first, so they also show in its Files; the email stores the list (`EmailAttachment[]`) and the bytes are read from Blob at send time. Up to 10 files and 20 MB per email. Templates and campaigns can carry attachments too.
- Campaigns render their HTML on every save with the current brand kit, keep merge tags as `{{tags}}`, and fill them per recipient at send time. Sending claims the campaign with one conditional `UPDATE`, sends in batches of 100 through Resend's batch endpoint with idempotency keys, records each recipient, and the cron resumes interrupted sends. A send can be retried safely at any point. Resend's batch endpoint can't carry attachments, so a campaign with files sends the same groups one email at a time (idempotency key per recipient), which is slower.
- Each campaign recipient also gets an `email` activity linked to the person, their organization and the client they matched, so campaign emails are on every timeline. They don't count as contact: `notCampaignEmail` (`src/lib/crm/activities.ts`) keeps them out of "last contacted", the Activities page and the home feed, and they don't move `last_activity_at`. Instead they set `people.last_campaign_at`, shown as "Last campaign" on the person and in the People table, and usable as an audience filter ("no campaign in the last N days"). Last contact is personal outreach only: anything logged by hand, and one-off emails from a person's, organization's or client's page.
- Reply-To for campaigns starts as the email of whoever set the campaign up, and can be changed on the campaign. A blank one falls back to the creator at send time. Duplicating a campaign keeps a shared reply-to (sales@…) but swaps the original author's own address for yours. There is no workspace-wide reply-to.
- Merge tags (`src/lib/email/merge-tags.ts`): `{{first_name}}`, `{{email}}`, `{{job_title}}`, `{{company}}`, `{{client_name}}`, `{{owner_name}}`, a person's custom fields as `{{custom.<key>}}`, and a fallback after a bar (`{{company|your team}}`).
- **Audiences** (`src/lib/email/campaigns.ts`, `audienceWhere`): tags (any or all), excluded tags, owner, organization, contacted or not contacted in N days, no campaign in N days, person custom fields (select, multi-select, checkbox), and client filters: category, pipeline, stage, service, client tag, churn reason and "open to coming back". A person matches a client filter when they're a matching client's contact or work at its organization. Filters are saved on the campaign or as a named audience (`audiences`, Email → Audiences) that campaigns reference; a campaign using one reads its filters when it sends and keeps a copy in case it's deleted. People without an email, archived, unsubscribed or whose address bounced are never included.

## Delivery tracking (Resend)

- Sends carry a `type` tag (`direct`, `campaign`). The Resend webhook (`/api/webhooks/resend`) receives `email.*` reports and `src/lib/email/delivery.ts` moves the matching `outbound_emails` row forward: sent → delayed → delivered → failed/suppressed → bounced → complained. One conditional `UPDATE` keeps a late or repeated report from moving it back. Opens and clicks are off by default (tracking pixels and rewritten links can hurt deliverability). A deployment turns them on with `email.trackOpens` / `email.trackClicks` in `app.config.ts` (or `NEXT_PUBLIC_APP_CONFIG`): the webhook then subscribes to `email.opened` / `email.clicked`, the first time and a count are stored on the row, and the timeline, campaign list and campaign report show them. Events for something that isn't tracked are ignored. Settings asks to reconnect the webhook whenever its events differ from what the deployment needs.
- A report that beats its row (the send is still saving) gets a 503 so Resend retries; a report for email another app sent on the same account matches nothing and is ignored, so it can never flag our people.
- A permanent bounce sets `people.email_bounced_at` (campaigns skip them; changing the address clears it). A spam complaint unsubscribes them. Both write a history entry on the person.
- Safety net: `/api/cron/email-status` runs hourly and asks Resend (`GET /emails/:id`) about emails with no final report after 20 minutes, for a week.
- Where it shows: a status badge on each sent email in the timeline, the delivery rate in the campaign list, and a report with every recipient on a sent campaign (plus opens and clicks when tracked).
- Settings → Email domains → Connect webhook subscribes to inbox and delivery events. A webhook connected before delivery tracking shows a notice to reconnect.

## Inbox (Resend)

- Domains and inboxes are managed through the Resend API from Settings → Email domains (admins). Resend stays the source of truth; nothing about a domain is stored here. `RESEND_DOMAINS` (optional) limits the CRM to some of the account's domains: `inEmailScope` in `src/lib/email.ts` filters `listInboxes`, the settings list and `syncThread` (so webhook events for other inboxes are ignored), and `assertDomainInScope` / `assertInboxInScope` guard every action that changes or sends from one.
- `src/lib/email/inbox.ts` mirrors threads into `inbox_threads` / `inbox_messages`. Each message becomes an `email` activity, so it shows on the timelines of the thread's person, organization and client. An email sent from a record (which already logged an activity) is matched by its Resend id and reused, so nothing shows twice.
- Links come from addresses: the first participant who is a person in the CRM, else an organization whose website matches the domain; the client is the one tied to that person or organization (current first). Linking a thread by hand sets `linked_by_hand`, and later syncs keep it.
- Freshness: the Resend webhook (`/api/webhooks/resend`, signature-verified) syncs a thread as soon as mail arrives; a cron every 15 minutes and the "Sync now" button catch anything missed. Syncing is idempotent.
- Received HTML goes through the same allow-list sanitizer as notes. The plain-text part is preferred when present, because sanitized marketing HTML reads poorly.

## The assistant

A chat panel in the bottom right corner that reads and changes records as the signed-in teammate, with their role, through the same operations as MCP. Threads are saved per teammate; it can talk (speech to speech) and take dictation. Everything runs through Vercel AI Gateway. See [AGENT.md](AGENT.md).

## Phone app and notifications

- **Installable.** `src/app/manifest.ts` and the generated icons (`icon.tsx`, `apple-icon.tsx`, from `app.config.ts`'s `pwa` settings and brand color) make the CRM installable from the browser: Add to Home Screen on iPhone and iPad, Install app on Android and desktop. It opens full screen and respects the notch (`viewport-fit=cover`, safe-area padding in the shell and the assistant). The proxy lets the manifest, icons and service worker through without a session, since phones fetch them before anyone signs in.
- **The service worker** (`public/sw.js`, always served fresh) shows notifications and, when one is tapped, focuses an open CRM window and navigates it, or opens one. It doesn't cache pages: everything is behind a login and changes constantly.
- **Push** is Web Push with VAPID keys (`src/lib/push/vapid.ts`; locally a pair is made in `.data/vapid.json`, deployed it needs `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`). Settings → Notifications turns it on per device and picks that device's alerts. iPhones and iPads need the app installed to the Home Screen first; the page says so.
- **What notifies** (`src/lib/push/triggers.ts`, called from the service layer, so the browser, API, MCP and the assistant all notify the same way, and nobody hears about their own change):

  | Alert | When |
  | --- | --- |
  | Tasks assigned to me | Someone else creates or reassigns a task, or a planned call or meeting, to you |
  | Tasks coming due | 15 minutes before a task with a time; tasks with only a date in one summary from 8 AM workspace time (the notifications cron) |
  | Records assigned to me | Someone else makes you the owner of a client, person or organization |
  | Replies from my contacts | Mail arrives in a connected inbox from a record you own (received in the last day, so a first sync doesn't flood you) |

- **Sending** happens after the response (`after()`), so a slow push service never slows the change. Each notification is a row in `notifications` with a dedupe key, so a retried webhook or overlapping crons send it once. A device the push service reports gone (404/410) is deleted; one that fails 5 times in a row is dropped.

## Background jobs

Vercel Cron, all on the same quarter-hour blocks so the database can scale to zero between them (Neon suspends after a few idle minutes): the campaign cron, the inbox sync and the notifications cron (tasks coming due) run at :00, :15, :30 and :45, and the delivery check runs at :00. Nothing runs more often than every 15 minutes, and nothing in the browser polls. Scheduled campaigns are rounded up to the next quarter hour, so they go out exactly when the cron runs. Work someone starts by hand ("Send now", "Sync now") runs right away.

## Stripe

- `src/lib/stripe.ts` reads a linked customer's subscriptions, invoices, payments and balance live from the Stripe REST API (no SDK) with `STRIPE_SECRET_KEY`. A restricted, read-only key is enough; the CRM never writes to Stripe. The billing card renders in its own `<Suspense>` boundary so a slow Stripe never holds up the client page.

## Local fallbacks

Every external service is optional in development (see the README). The fallbacks refuse to run on Vercel, so production can't silently use them.
