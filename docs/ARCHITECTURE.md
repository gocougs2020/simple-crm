# Architecture

One Next.js app. Server components read the database directly; server actions change it; a handful of route handlers cover files, cron and unsubscribe. There's no separate API layer.

## Layout

```
src/
  app/
    (auth)/          sign-in, setup, forgot, reset/[token], invite/[token]
    (app)/           everything behind the login: home, deals, people, organizations,
                     activities, files, email, settings
    api/             files (upload token, local upload, download), brand logo, cron
    unsubscribe/     the campaign unsubscribe page and RFC 8058 one-click endpoint
  actions/           server actions, one file per area ("use server")
  components/        UI, grouped by feature; ui/ holds the primitives
  db/                schema.ts (every table) and the connection
  emails/            React Email templates (layout, invite, reset, direct, campaign)
  lib/               server logic: auth, email, files, formatting, queries (lib/crm)
  styles/theme.css   every color the app uses
drizzle/             SQL migrations generated from schema.ts
```

## Data model

| Table | Holds |
| --- | --- |
| `users`, `sessions`, `auth_tokens`, `rate_limits` | Team, signed-in browsers, invite/reset links, sign-in throttling |
| `workspace` | One row: name, currency, time zone, email brand kit |
| `organizations`, `people`, `deals` | The records. Each has an owner, `custom` JSON for custom fields, `last_activity_at`, and `archived_at` (soft delete) |
| `pipelines`, `stages` | Stages carry a win probability and a "needs attention" threshold in days |
| `activities` | Notes, calls, emails, texts, meetings and tasks in one table. Links to a person, organization and/or deal |
| `events` | Change history: who changed what, from what, to what |
| `files` | Metadata; the bytes live in private Vercel Blob |
| `custom_fields` | Field definitions per record type. Values live on the record, keyed by a stable `key` |
| `email_templates`, `campaigns`, `outbound_emails` | Email. `outbound_emails` records every message sent |
| `people_imports` | What each spreadsheet import created and changed, so it can be undone |

Choices worth knowing:

- **Activities are one table.** "Log a call" and "add a task" are the same gesture with different fields, and a record's timeline is one query. An open activity with a `due_at` is planned; one with `completed_at` or no `due_at` is history.
- **Links roll up.** Logging on a deal fills in its person and organization; logging on a person fills in their organization. The organization page is the whole story without joins across deals.
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

## Local fallbacks

Every external service is optional in development (see the README). The fallbacks refuse to run on Vercel, so production can't silently use them.
