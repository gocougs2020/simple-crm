# Architecture

One Next.js app. Server components read the database directly; server actions change it; a handful of route handlers cover files, cron and unsubscribe. There's no separate API layer.

## Layout

```
src/
  app/
    (auth)/          sign-in, setup, forgot, reset/[token], invite/[token]
    (app)/           everything behind the login: home, clients, people, organizations,
                     activities, files, email (inbox, campaigns, templates), settings
    api/             files (upload token, local upload, download), brand logo, cron,
                     the Resend webhook
    unsubscribe/     the campaign unsubscribe page and RFC 8058 one-click endpoint
  actions/           server actions, one file per area ("use server")
  components/        UI, grouped by feature; ui/ holds the primitives
  db/                schema.ts (every table) and the connection
  emails/            React Email templates (layout, invite, reset, direct, campaign)
  lib/               server logic: auth, email (and the inbox sync), Stripe, files,
                     formatting, queries (lib/crm)
  styles/theme.css   every color the app uses
drizzle/             SQL migrations generated from schema.ts
```

## Data model

| Table | Holds |
| --- | --- |
| `users`, `sessions`, `auth_tokens`, `rate_limits` | Team, signed-in browsers, invite/reset links, sign-in throttling |
| `workspace` | One row: name, currency, time zone, email brand kit |
| `organizations`, `people`, `clients` | The records. Each has an owner, `custom` JSON for custom fields, `last_activity_at`, and `archived_at` (soft delete) |
| `pipelines`, `stages` | Each pipeline belongs to a client category. Stages carry a win probability (prospects) and a "needs attention" threshold in days |
| `services`, `client_services` | What the workspace sells (Settings → Services), and which ones each client uses or used, at what price, from when to when |
| `client_metrics` | Performance numbers logged over time per client ("Leads", "Days to fill") |
| `activities` | Notes, calls, emails, texts, meetings and tasks in one table. Links to a person, organization and/or client |
| `events` | Change history: who changed what, from what, to what |
| `files` | Metadata; the bytes live in private Vercel Blob |
| `custom_fields` | Field definitions per record type. Values live on the record, keyed by a stable `key` |
| `email_templates`, `campaigns`, `outbound_emails` | Email. `outbound_emails` records every message sent |
| `inbox_threads`, `inbox_messages` | A mirror of the workspace's Resend inboxes, linked to people, organizations and clients |
| `people_imports` | What each spreadsheet import created and changed, so it can be undone |
| `external_ids` | Which record here came from which record in Pipedrive, so the [Pipedrive import](PIPEDRIVE-IMPORT.md) can run again without duplicating and be removed cleanly |

Choices worth knowing:

- **Clients are one table, in three categories.** A client is prospective, current or past. The category decides which pipelines it moves through (each pipeline has a `category`) and what its page shows: potential value and expected close for prospects; health, services, Stripe billing, performance and contact frequency for current clients; what they had, why they left and whether they'd come back for past clients. Moving between categories (`changeClientCategory`) records dates, the reason and a history entry, and ends or starts services in the same step. Deals were renamed to clients in place (migration `0001`), so ids, links and history carried over; won deals became current clients, lost ones prospects in a "Not now" stage.
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
- **Server actions** return `Result<T>` (`{ ok, data }` or `{ ok: false, error }`) through `run()` in `src/lib/action.ts`. Errors meant for people are `ActionError`s with a sentence that says what to do; anything else is logged and reported generically.
- **List state lives in the URL** (`?q=&owner=&sort=`), so views are shareable and survive reloads. View preferences that should follow a person across devices (board vs table, pipeline) are saved on `users.prefs`.

## Email

- `src/lib/email.ts` wraps Resend. Without `RESEND_API_KEY` it prints to the terminal.
- One-off emails (`src/actions/email.ts`) send as the teammate (their name in From, their address in Reply-To) and are logged as an `email` activity.
- Campaigns render their HTML on every save with the current brand kit, keep merge tags as `{{tags}}`, and fill them per recipient at send time. Sending claims the campaign with one conditional `UPDATE`, sends in batches of 100 with idempotency keys, records each recipient, and the cron resumes interrupted sends. A send can be retried safely at any point.
- Merge tags (`src/lib/email/merge-tags.ts`): `{{first_name}}`, `{{company|your team}}` (with a fallback), and so on.
- Campaign audiences can target clients: by category, stage, service, client tag, churn reason and "open to coming back". A person matches when they're a matching client's contact or work at its organization.

## Inbox (Resend)

- Domains and inboxes are managed through the Resend API from Settings → Email domains (admins). Resend stays the source of truth; nothing about a domain is stored here.
- `src/lib/email/inbox.ts` mirrors threads into `inbox_threads` / `inbox_messages`. Each message becomes an `email` activity, so it shows on the timelines of the thread's person, organization and client. An email sent from a record (which already logged an activity) is matched by its Resend id and reused, so nothing shows twice.
- Links come from addresses: the first participant who is a person in the CRM, else an organization whose website matches the domain; the client is the one tied to that person or organization (current first). Linking a thread by hand sets `linked_by_hand`, and later syncs keep it.
- Freshness: the Resend webhook (`/api/webhooks/resend`, signature-verified) syncs a thread as soon as mail arrives; a cron every 15 minutes and the "Sync now" button catch anything missed. Syncing is idempotent.
- Received HTML goes through the same allow-list sanitizer as notes. The plain-text part is preferred when present, because sanitized marketing HTML reads poorly.

## Stripe

- `src/lib/stripe.ts` reads a linked customer's subscriptions, invoices, payments and balance live from the Stripe REST API (no SDK) with `STRIPE_SECRET_KEY`. A restricted, read-only key is enough; the CRM never writes to Stripe. The billing card renders in its own `<Suspense>` boundary so a slow Stripe never holds up the client page.

## Local fallbacks

Every external service is optional in development (see the README). The fallbacks refuse to run on Vercel, so production can't silently use them.
