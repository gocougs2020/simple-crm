# Architecture

One Next.js app, plus a small background agent beside it (`agent/`, see [AGENT.md](AGENT.md#background-work)). Server components read the database directly; server actions change it through a shared service layer; a handful of route handlers cover files, cron and unsubscribe. The REST API (`/api/v1`), the MCP server (`/api/mcp`) and the in-app agent (`/api/agent`) go through the same service layer, so the browser, integrations and agents follow the same rules and write the same history (see [API.md](API.md) and [AGENT.md](AGENT.md)).

## Layout

```
src/
  app/
    (auth)/          sign-in, setup, forgot, reset/[token], invite/[token]
    (app)/           everything behind the login: home, clients, people, organizations,
                     activities, calendar, files, email (inbox, campaigns, audiences, templates),
                     messages (text conversations), chat (the team chat), settings
    api/             files (upload token, local upload, download), brand logo, cron
                     (campaigns, inbox, email-status, notifications, microsoft), the Resend and Twilio
                     webhooks, Microsoft sign-in (integrations/microsoft), the REST API
                     (v1/[...path]), MCP (mcp) and the agent (agent: chat, transcribe, voice)
    manifest.ts, icon.tsx, apple-icon.tsx   the installable app: manifest and generated icons
    developers/      the public API and MCP docs, generated from the operation list
    unsubscribe/     the campaign unsubscribe page and RFC 8058 one-click endpoint
    share/           public file links: the page and the file, no sign-in
  actions/           server actions, one file per area ("use server")
  components/        UI, grouped by feature; ui/ holds the primitives; agent/ is the agent panel;
                     phone/ is the call panel, call buttons and the text composer
  db/                schema.ts (every table) and the connection
  emails/            React Email templates (layout, invite, reset, direct, campaign)
  lib/               server logic: auth, permissions, email (and the inbox sync), Stripe,
                     files, formatting, queries (lib/crm), record changes (lib/crm/service),
                     the REST API (lib/api), MCP (lib/mcp), the agent (lib/agent), push (lib/push),
                     Microsoft 365 (lib/microsoft), Twilio (lib/twilio), phone-number rules (lib/phone)
                     and the optional knowledge source (lib/knowledge)
  styles/theme.css   every color the app uses
public/sw.js         the service worker: shows push notifications, opens the page they point to
agent/               the agent's background worker: an eve agent, its own service at /eve/v1 (docs/AGENT.md)
drizzle/             SQL migrations generated from schema.ts
app.config.ts        product defaults (name, theme, layout), overridable per deployment
                     with NEXT_PUBLIC_APP_CONFIG (src/lib/config-overrides.ts)
```

## Data model

| Table | Holds |
| --- | --- |
| `users`, `sessions`, `auth_tokens`, `rate_limits` | Team, signed-in browsers, invite/reset links, sign-in and API throttling |
| `api_keys` | Workspace keys (full access, REST only), personal keys and connected apps (act as one teammate; REST and MCP). Only a hash is stored. Each teammate's agent has an `assistant` row too, with no usable token, so history can say "via Agent" |
| `agent_threads` | A teammate's conversations with the agent: title and messages (AI SDK UI messages, as JSON). Private to them |
| `agent_runs` | Work the agent does in the background for a teammate: who asked, how (chat, a mention, an assigned task, a bulk request, the API), the request, its status, its answer and what it cost. An activity it was handed points at its run (`activities.agent_run_id`) |
| `agent_skills` | Instructions saved for the agent: a teammate's own (`personal`) or shared with everyone by an admin (`workspace`), always on or read when relevant. See [AGENT.md](AGENT.md#skills) |
| `agent_schedules` | Scheduled jobs: work the agent does on a cadence as one teammate. A `workspace` row is an offer from an admin; a teammate who adds it gets their own copy (`from_id`). A run a job started points back at it (`agent_runs.schedule_id`). See [AGENT.md](AGENT.md#scheduled-jobs) |
| `agent_drafts` | Emails and texts the agent wrote for a teammate to review and send. Private to that teammate; sending happens in the composer, never here |
| `push_subscriptions`, `notifications` | Devices that get push notifications (one per browser or installed app, each with its own alert types), and every notification sent, deduplicated by key |
| `workspace` | One row: name, currency, time zone, email brand kit. The time zone is the clock background work keeps (agendas, reminders, scheduled jobs, the agent); on screen each teammate sees times in their own browser's zone (`src/lib/time-zone.ts`) |
| `organizations`, `people`, `clients` | The records. Each has an owner, `custom` JSON for custom fields, `last_activity_at`, `archived_at` (soft delete), and an AI summary (`summary`, `summary_at`, `summary_started_at`) refreshed daily ([AGENT.md](AGENT.md#record-summaries)) |
| `client_people` | People on a client besides its contact, added by hand on its page |
| `activity_people` | Everyone else on an activity besides its own person: a meeting's other attendees, the other recipients of an email |
| `labels` | What each label means: a name (the string in a record's `tags`), a description and whether the app shows it. People, organizations and clients carry labels in `tags` |
| `pipelines`, `stages` | Each pipeline belongs to a client category. Stages carry a win probability (prospects) and a "needs attention" threshold in days |
| `services`, `service_plans`, `client_services` | What the workspace sells and the plans each service comes in (Settings → Services), and which service and plan each client uses or used, at what price, from when to when |
| `client_metrics` | Performance numbers logged over time per client ("Leads", "Days to fill") |
| `activities` | Notes, calls, emails, texts, meetings and tasks in one table. Links to a person, organization and/or client |
| `note_replies` | Replies under a note, oldest first: teammates answering each other, and the agent answering a note that called on it |
| `events` | Change history: who changed what, from what, to what, and through which API key |
| `files` | Metadata; the bytes live in private Vercel Blob (one row per stored file: `url` is unique). It's on the one record it was added on (`person_id`, `organization_id` or `client_id`; a file added to a note or email keeps its `activity_id`). `folder_id` is its folder on the Files page, `public_token` is set while it's public, `origin`/`chat_message_id` mark a team chat attachment, `description`/`content_notes` are what the model (or a teammate, `description_by`) wrote about it, and `embedding` is their pgvector for search |
| `file_links` | Records a file was attached to after it was uploaded, one per row, besides the ones it was uploaded on (`files.person_id` and the rest) |
| `file_folders` | Folders on the Files page, nested by `parent_id` |
| `chat_messages` | The team chat: one thread for everyone. Plain text, who it mentions, edited and deleted times. `users.chat_read_at` is how far each teammate has read |
| `custom_fields` | Field definitions per record type. Values live on the record, keyed by a stable `key` |
| `email_templates`, `campaigns`, `audiences`, `outbound_emails` | Email. `audiences` are saved campaign filters. `outbound_emails` records every message sent, with its reply-to, attachments and Resend delivery status |
| `inbox_threads`, `inbox_messages` | A mirror of the workspace's Resend inboxes, linked to people, organizations and clients |
| `inbox_sends` | Who sent each email from the inbox page, by Resend's id, so the sync credits them however the send and the webhook race |
| `people_imports` | What each spreadsheet import created and changed, so it can be undone |
| `person_organizations` | Organizations a person is also at, besides their main one. Merging duplicates, by hand or with the script ([DEDUPE.md](DEDUPE.md)), keeps every organization they were at here. People also have `other_emails` and `other_phones`, which mail, call and text matching use |
| `external_ids` | Which record here came from which record in Pipedrive, so the [Pipedrive import](PIPEDRIVE-IMPORT.md) can run again without duplicating and be removed cleanly |
| `connected_accounts`, `synced_emails` | Each teammate's connected Microsoft 365 mailbox and calendar (tokens encrypted), and every message the mailbox sync looked at: shared, private (with its content, for that teammate alone) or kept out, why, and the screen's probability. See [MICROSOFT.md](MICROSOFT.md) |
| `phone_numbers`, `phone_number_users`, `phone_calls`, `text_messages` | The Twilio numbers the team uses and who may use each, and every call and text through them. Each call and text is also an activity on the record it matched. See [PHONE.md](PHONE.md) |
| `text_threads` | Text conversations for the Messages page: one per pair of our number and theirs, with its links and one read flag. Every text belongs to one (`text_messages.thread_id`) |

Choices worth knowing:

- **Clients are one table, in three categories.** A client is prospective, current or past. The category decides which pipelines it moves through (each pipeline has a `category`) and what its page shows: potential value and expected close for prospects; health, services and Stripe billing (one card), performance and time since last contact for current clients; what they had, why they left and whether they'd come back for past clients. Moving between categories (`changeClientCategory`) records dates, the reason and a history entry, and ends or starts services in the same step. Deals were renamed to clients in place (migration `0001`), so ids, links and history carried over; won deals became current clients, lost ones prospects in a "Not now" stage.
- **Monthly revenue is derived, never stored.** It's the sum of a client's open `client_services`, normalized to a month (`monthlyFactor` and its SQL twin `monthlyPriceSql` in `src/lib/constants.ts`; billing every 4 weeks is 13 payments a year), so changing a price or ending a service is the only thing to keep up to date.
- **Plans are defaults, not prices.** A service can come in plans (`service_plans`), each with a usual price, billing and description. Adding a service to a client picks a plan and copies those onto the client's row (the description as the note), where they can be changed for that client. Editing a plan later never changes what existing clients pay. A service with no plans is sold at its own price.
- **Activities are one table.** "Log a call" and "add a task" are the same gesture with different fields, and a record's timeline is one query. An open activity with a `due_at` is planned; one with `completed_at` or no `due_at` is history.
- **Notes are threads.** A reply (`note_replies`) stays under the note it answers instead of becoming another note, so a conversation is one entry on the timeline, in the Activities page and in the API (`replies` on the note). Replying bumps the note's `updated_at` (so open pages pick it up) and counts as contact on its records. `@` and a teammate's name in a note or reply sends them the "Mentioned in a note" push (`mentionedTeammates` in `src/lib/crm/mentions.ts`: the full name, or a first name nobody shares); a reply also tells the note's author and everyone who already replied. The agent's answer to a mention is a reply too, and a reply can call on it again.
- **Links roll up.** Logging on a client fills in its contact and organization; logging on a person fills in their organization. The organization page is the whole story without joins across clients.
- **A client has people, not one person.** Its People card and the composer on its page offer its contact (`clients.person_id`), people added to it by hand (`client_people`) and everyone at its organization (`clientPeople` in `src/lib/crm/records.ts`, each person once, in that order). Calls, emails and texts from the page start on the contact and can go to any of them. Changing the contact keeps the old one on the client.
- **An activity can be with several people.** `activities.person_id` is still the one it's mainly with; `activity_people` holds the rest (`personIds` on the activity input). A meeting on a client needs nobody named, and can name any number of the client's people; an email to several people records everyone on its To and Cc lines who is in the CRM. It shows on each person's timeline and counts as contact with each.
- **Messages land on people.** Mail (Resend inboxes and synced Microsoft 365 mailboxes), calls and texts are matched to a person by address or phone number (`src/lib/crm/match.ts`), else to an organization by website domain or main line, and roll up from there like anything logged by hand.
- **Decision makers are a star.** `people.decision_maker` marks the people at an organization who make or sign off on the decision; they sort first in the organization's people and are an audience filter. What the star is called is a setting (`records.keyContactLabel`).
- **Parent organizations are one level.** `organizations.is_parent` marks an organization others can be part of (a franchisor and its franchises); `parent_id` is the parent an organization is part of. Only a marked organization can be picked, and a parent has no parent of its own, so there are no chains or cycles to walk (`assertParentRules` in `src/lib/crm/service/records.ts`). "At this organization" then means the organization or one that is part of it (`inOrganizations` in `src/lib/crm/records.ts`): the People list's parent filter, a campaign audience's "Part of" filter and `GET /people?organizationId=` all use it, so a group is one choice instead of every franchise. The parents load with the app-wide data, so the picker opens with no round trip. Timelines don't roll up to the parent.
- **Labels are strings with a definition.** A record's labels are the lowercase strings in its `tags` (people, organizations, clients), so audiences, imports and the API keep working on plain names. `labels` gives a name its description and a hidden flag (Settings → Labels, admins). Anything that puts a label on a record (`ensureLabels` in `src/lib/crm/labels.ts`: the services, the bulk action, an import) gives it a definition if it has none, and Settings also lists labels in use that nobody has described. Renaming one rewrites every record, saved audience and unsent campaign (`rewriteLabel`). Deleting one takes it off every record, and is refused while an audience or unsent campaign filters on it, since dropping a filter would widen who it reaches. Hidden labels stay on their records and in the API; the app doesn't show or offer them. The definitions load with the app-wide data: chips explain themselves on hover and focus, and record pages pick labels from a dropdown (`src/components/records/labels.tsx`). The agent gets the definitions in its prompt, in a background run's first message and from `list_labels`.
- **An organization's labels carry to its people.** A person has a label when they or their organization has it (`effectiveTags`): the People list's label filter, a campaign audience's "Labeled" and "Not labeled" filters and `GET /people?tag=` all match that way, a person's page shows the carried ones dashed, and the API returns them as `organizationTags`. They aren't copied onto the person, so taking a label off the organization takes it off everyone. Labels don't carry from a parent organization to the organizations that are part of it, or from an organization to its clients. Adding a label to a parent organization on its page asks whether to copy it onto the organizations that are part of it (`addLabelsToChildOrganizations`), which is a one-time copy, not a link.
- **Labels are added in bulk from a selection.** The People, Organizations and Clients tables offer "Add labels" on selected rows (`addLabels` in `src/lib/crm/service/records.ts`): the picked labels are added to what each record has, and each record that changed gets a history entry.
- **Money is integer cents** (`bigint`), so sums never drift.
- **Board order uses fractional ranks** (`src/lib/rank.ts`): moving a card writes only that card.
- **Custom field keys never change.** Renaming a field keeps its data; archiving hides it without deleting values.
- **History is written by the server**, next to each change, in the same action. Nothing in the UI can forge it.
- **Files are scoped to their record, and reach a client from below.** A file is on the record it was added on, without rolling down (`uploadLinks`): added on a client (its page, or a note or email there), it's on that client only, not its contact or organization; added on a person or an organization, on them only. It can be attached to more records later (`file_links`). A client's Files card and timeline also show its contact's, its people's and its organization's files, marked "From …" (`inRecordView` in `src/lib/crm/files.ts`); nothing travels from a client down. `recordsFor` reads both kinds of link, so the Files page, the API and the dialog agree. The file dialog sets the whole list at once (`setFileRecords`), and each record that gains or loses the file gets a history entry. Merging records moves their links.
- **The Files page is four lists.** All files is every file in the CRM, with what it's on. General files are a lightweight shared drive: folders nest, a folder holds whatever is put in it, and the top level shows files on no record and not from chat. "On records" lists every file on a client, person or organization; "From chat" lists team chat attachments. Search in General looks through every folder. Files and folders move by drag and drop (onto a folder or a breadcrumb) or with Move. Deleting a folder first shows what's in it, then either moves it all to another folder or deletes it with the folder (which needs an admin when someone else uploaded a file or made a folder inside). Two folders in one place can't share a name. New folder is offered on All files too: the folder is made at the top of General files and opened.
- **Files describe themselves.** A small model reads each new file once and writes a short description and its key facts; they're embedded for search by meaning, and the agent, the API and MCP find and quote files by them. See [AGENT.md](AGENT.md#file-descriptions) and [API.md](API.md#files).
- **Files are internal or public.** Internal files open only for signed-in teammates (`/api/files/[id]`). Making one public gives it a random token and `/share/<token>` opens it for anyone, with a page that shows its name, a preview for pictures and a download; making it internal again clears the token, so links already sent stop working. See [SECURITY.md](SECURITY.md#files).
- **The team chat is one thread.** Everyone who can sign in reads and posts; viewers can't attach files (`src/lib/chat/service.ts`). Messages are plain text with links picked out; `@` and a teammate's name mentions them (the same rule as notes) and sends the "Mentioned in team chat" push, linking to the message; teammates who chose "Every team chat message" hear about the rest. Attachments are files uploaded with `origin: "chat"` and claimed by the message they're posted with; deleting a message removes its files unless someone has since filed, attached or shared them. The sidebar counts messages since the teammate last had the chat open, and mentions in red. The chat isn't in the API or MCP yet.
- **Anything on a timeline can be deleted**, for everyone: notes, tasks, meetings, and calls, texts and emails sent or received through the CRM (a sensitive email that got through, say). Admins can delete anything; everyone else what they sent or logged themselves, plus mail copied from their own mailbox (`deleteActivity` in `src/lib/crm/service/activities.ts`). What was behind it stays as a tombstone, emptied of content, so a later sync or webhook never brings it back; the history says something was deleted, without an email's or text's subject.

## Requests

- **Pages** are server components wrapped in `<Suspense>`. With Cache Components the static shell (sidebar, headers) streams instantly and data fills in. `getDb()` calls `connection()`, so anything that touches the database is per-request by construction.
- **App-wide data** (team, pipelines, custom field definitions, workspace settings) loads once in the `(app)` layout and reaches client components through `AppProvider`, so pickers and menus open with no round trip.
- **Record changes live in `src/lib/crm/service/`.** Each function takes an `Actor` (`src/lib/crm/actor.ts`): a teammate in the browser, a teammate through their personal key, or a workspace key. It checks the actor's permission (`src/lib/permissions.ts`), validates with the shared schemas (`src/lib/crm/schemas.ts`), and writes history. Server actions wrap these and call `refresh()`; the API and MCP call them directly.
- **Roles** are one table in `src/lib/permissions.ts`: owners and admins can do everything, members work records, viewers only read. The interface hides what a role can't do; the server refuses it regardless.
- **Server actions** return `Result<T>` (`{ ok, data }` or `{ ok: false, error }`) through `run()` in `src/lib/action.ts`. Errors meant for people are `ActionError`s with a sentence that says what to do; anything else is logged and reported generically.
- **List state lives in the URL** (`?q=&owner=&sort=`), so views are shareable and survive reloads. The People and Organizations tables render their first 100 rows and the total, then load 100 more as you near the bottom (`usePagedRows`, `src/components/table/use-paged-rows.ts`). Each page picks its ids first (filter, sort, offset on the one table) and only then works out organizations, clients and next activity for those rows, so deep pages stay cheap; the total is counted once per view, not per page. View preferences that should follow a person across devices (board vs table, pipeline) are saved on `users.prefs`.

## Email

- `src/lib/email.ts` wraps Resend. Without `RESEND_API_KEY` it prints to the terminal.
- One-off emails (`src/actions/email.ts`) send from a person's or client's page as the teammate (their name in From) and are logged as an `email` activity. Reply-To is the teammate's own address unless they change it for that email. Sending from a Resend inbox skips Reply-To: replies come back to that inbox.
- From a client's page one email can go to several of its people: one message with everyone on To and Cc, so they can reply to all. To and Cc together hold 10 addresses at most (`MAX_EMAIL_RECIPIENTS`, well under Resend's 50 per line), checked in the composer and again on the server. `planRecipients` (`src/lib/email/recipients.ts`) keeps each address once, on To when it's on both lines; a blind copy to the sender doesn't count. Merge tags fill in for the first person on To. The `outbound_emails` row keeps both lines comma-separated and gets one delivery status for the whole email; a bounce or complaint flags only the addresses Resend's report names.
- **Attachments** are ordinary CRM files (`src/lib/email/attachments.ts`). The composer uploads them to the record first, so they also show in its Files; the email stores the list (`EmailAttachment[]`) and the bytes are read from Blob at send time. Up to 10 files and 20 MB per email. Templates and campaigns can carry attachments too.
- Campaigns render their HTML on every save with the current brand kit, keep merge tags as `{{tags}}`, and fill them per recipient at send time. Sending claims the campaign with one conditional `UPDATE`, sends in batches of 100 through Resend's batch endpoint with idempotency keys, records each recipient, and the cron resumes interrupted sends. A send can be retried safely at any point. Resend's batch endpoint can't carry attachments, so a campaign with files sends the same groups one email at a time (idempotency key per recipient), which is slower.
- Each campaign recipient also gets an `email` activity linked to the person, their organization and the client they matched, so campaign emails are on every timeline. They don't count as contact: `notCampaignEmail` (`src/lib/crm/activities.ts`) keeps them out of "last contacted", the Activities page and the home feed, and they don't move `last_activity_at`. Instead they set `people.last_campaign_at`, shown as "Last campaign" on the person and in the People table, and usable as an audience filter ("no campaign in the last N days"). Last contact is personal outreach only: anything logged by hand, and one-off emails from a person's, organization's or client's page.
- Reply-To for campaigns starts as the email of whoever set the campaign up, and can be changed on the campaign. A blank one falls back to the creator at send time. Duplicating a campaign keeps a shared reply-to (sales@…) but swaps the original author's own address for yours. There is no workspace-wide reply-to.
- Merge tags (`src/lib/email/merge-tags.ts`): `{{first_name}}`, `{{email}}`, `{{job_title}}`, `{{company}}`, `{{client_name}}`, `{{owner_name}}`, a person's custom fields as `{{custom.<key>}}`, and a fallback after a bar (`{{company|your team}}`).
- **Audiences** (`src/lib/email/campaigns.ts`, `audienceWhere`): labels (any or all; the person's own or their organization's), excluded labels, owner, parent organization (everyone at it and at the organizations that are part of it), contacted or not contacted in N days, no campaign in N days, person custom fields (select, multi-select, checkbox), and client filters: category, pipeline, stage, service, client tag, churn reason and "open to coming back". A person matches a client filter when they're a matching client's contact or work at its organization. Filters are saved on the campaign or as a named audience (`audiences`, Email → Audiences) that campaigns reference; a campaign using one reads its filters when it sends and keeps a copy in case it's deleted. People without an email, archived, unsubscribed or whose address bounced are never included.

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
- Every email sent is credited to a teammate (the activity's `user_id`), shown as their initials in the conversation: one-off emails and inbox replies to whoever sent them, campaign emails to whoever created the campaign, labeled as a campaign and styled apart. Inbox replies and new emails record the sender in `inbox_sends` the moment Resend accepts them, and the sync credits the email from there whichever syncs it first: the send or Resend's webhook.
- Unread follows the record's owner, the same as text conversations (see [Unread](#unread-email-and-texts)). The thread's `read` flag is Resend's, kept in step both ways.

## Unread (email and texts)

Email threads and text conversations share one rule (`src/lib/conversations/read-rules.ts`, the SQL twin in `read-state.ts`):

- A conversation's unread belongs to whoever owns the record it's about: the linked person's owner, else (no person linked) the organization's. A deactivated owner counts as nobody.
- Owned: it's unread only for the owner, and only the owner opening it, or marking it read or unread, changes it. Everyone else still sees the conversation, not bold, with a line saying whose unread it is.
- Nobody's (no record, or no owner): it's unread for everyone, and the first teammate to open it marks it read for everyone.
- There's one `read` flag per conversation, not one per teammate, so when the record changes hands an unread conversation becomes the new owner's unread with nothing to copy.
- The sidebar's Email and Messages counts, the per-inbox counts and the Unread filters all count what's unread for the viewer. Email counts only the inbox folder from the last 90 days, as before.
- Open pages catch up on their own ([Live updates](#live-updates)); the Messages page also fetches what's new when the tab comes back into view, and push alerts cover the rest.
- Freshness: the Resend webhook (`/api/webhooks/resend`, signature-verified) syncs a thread as soon as mail arrives; a cron every 15 minutes and the "Sync now" button catch anything missed. Syncing is idempotent.
- Received HTML goes through the same allow-list sanitizer as notes. The plain-text part is preferred when present, because sanitized marketing HTML reads poorly.

## Microsoft 365

Each teammate connects their own mailbox and calendar (Settings → Email and calendar, OAuth with PKCE, tokens encrypted with `src/lib/crypto.ts`). Email from records can go out through it (Graph, saved in their Sent Items); a quarter-hour cron syncs mail that has a person in the CRM from outside the organization on it (From, To or Cc), minus each teammate's block list, from Inbox and Sent Items or the folders they picked. Outlook's sensitivity label and a decision model (Jev, a yes/no probability) sort each one: on the record for the team, private to the teammate whose mailbox it came from (kept on `synced_emails`, never an activity), or not stored (marked with a category in Outlook); planned meetings assigned to them are kept in step on their calendar; and Calendar shows teammates' Outlook events live, as much as each shares. Email → My Outlook lists what was copied from the viewer's own mailbox, for them alone; owners can see who's connected and disconnect a teammate (Settings), never read their mail. See [MICROSOFT.md](MICROSOFT.md).

## Calling and texting

Twilio numbers, managed in Settings → Phone numbers. Calls are placed from the browser with the Twilio Voice SDK through a TwiML app whose webhook only dials calls the teammate prepared; incoming calls are forwarded to a cell phone, logged on the caller, and leave a write-up task. Texts both ways are activities, and every text joins a conversation on the Messages page; STOP opts a person out. Text campaigns share the email campaigns' audiences and claim-and-resume sending. Every Twilio webhook is signature-checked and idempotent. See [PHONE.md](PHONE.md).

## The agent

Record pages open with an AI summary of the record, shared by the team and rewritten once a day. A chat panel in the bottom right corner that reads and changes records as the signed-in teammate, with their role, through the same operations as MCP. Threads are saved per teammate; it can talk (speech to speech) and take dictation. Longer jobs (web research, adding an organization's people, cleanups across a list) run in the background on an eve agent in `agent/`, started from chat, by mentioning the agent in a note, by assigning it a task or by a scheduled job. Teammates attach spreadsheets, Word documents and text files in chat (read in the browser; only the text is sent), and save skills and scheduled jobs for it in Settings → Agent, where admins share some with the whole team. A run acts as the teammate who asked, through the same MCP tools and role checks, and its changes read "Sam via Agent". It never sends email or texts: it writes drafts the teammate reviews and sends. Everything runs through Vercel AI Gateway. See [AGENT.md](AGENT.md).

## Phone app and notifications

- **Installable.** `src/app/manifest.ts` and the generated icons (`icon.tsx`, `apple-icon.tsx`, from `app.config.ts`'s `pwa` settings and brand color) make the CRM installable from the browser: Add to Home Screen on iPhone and iPad, Install app on Android and desktop. It opens full screen and respects the notch (`viewport-fit=cover`, safe-area padding in the shell and the agent). The proxy lets the manifest, icons and service worker through without a session, since phones fetch them before anyone signs in.
- **The service worker** (`public/sw.js`, always served fresh) shows notifications and, when one is tapped, focuses an open CRM window and navigates it, or opens one. It doesn't cache pages: everything is behind a login and changes constantly.
- **Push** is Web Push with VAPID keys (`src/lib/push/vapid.ts`; locally a pair is made in `.data/vapid.json`, deployed it needs `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`). Settings → Notifications turns it on per device and picks that device's alerts. iPhones and iPads need the app installed to the Home Screen first; the page says so.
- **What notifies** (`src/lib/push/triggers.ts`, called from the service layer, so the browser, API, MCP and the agent all notify the same way, and nobody hears about their own change). Each device picks its own:

  | Push alert | When |
  | --- | --- |
  | Tasks assigned to me | Someone else creates or reassigns a task, or a planned call or meeting, to you |
  | Tasks with a time | On the day, 15 minutes before a task or planned call with a time is due |
  | Today's tasks, in the morning | One summary of today's tasks with no time, from `notifications.morningHour` (7 AM) workspace time |
  | Meetings | 15 minutes before each of your meetings |
  | Mentioned in a note | A teammate mentions you in a note or a reply |
  | Replies to my notes | Someone replies to a note you wrote or already replied to |
  | Mentioned in team chat | A teammate mentions you in the team chat |
  | Every team chat message | Anyone posts in the team chat. Off on new devices |
  | Records assigned to me | Someone else makes you the owner of a client, person or organization |
  | Notes and activity on my records | Someone else adds a note, reply, call, email, text, meeting or task on a client, person or organization you own, through the app, the API, MCP or the agent (`logActivity`, `replyToNote`). Synced mail, texts and calls don't count: they have their own alerts |
  | Stage changes on my clients | Someone else moves a client you own to another stage, or signs, loses or wins it back |
  | Replies from my contacts | Mail arrives in a connected inbox from a record you own (received in the last day, so a first sync doesn't flood you) |
  | Texts from my contacts | Someone you own texts one of the team's numbers, or a number you look after |
  | The agent finished | Background work you gave the agent is done, has a draft for you, or couldn't finish |

  One event sends each device one alert: the first it wants, most specific first (`notifyEach` in `src/lib/push/notify.ts`, the order in `src/lib/push/routing.ts`). A note on your client that mentions you is "mentioned you" on a device that wants mentions, else "added a note on Acme" on one that wants activity on your records. A new device gets every alert but every team chat message (`defaultNotificationKinds`).

  The scheduled ones run on the quarter-hour notifications cron (`src/lib/push/due.ts`, rules in `src/lib/notifications/schedule.ts`), so a reminder lands 0–15 minutes before its time: exactly 15 for meetings on the quarter hour.
- **Agenda emails** (`src/lib/notifications/agenda.ts`, template `src/emails/agenda.tsx`), chosen per teammate (`users.prefs.emailDigests`), off until turned on:
  - **Daily**, every weekday morning: today's meetings, tasks due today and anything overdue.
  - **Weekly**, every Monday morning: this week's meetings, tasks due today or overdue, and tasks coming up later in the week. On a Monday with both on, only the weekly one goes out.
  - Sent from `notifications.morningHour` in the workspace's time zone by the same cron, once per teammate per day (claimed in `notifications` before sending, released if the send fails), and skipped when there's nothing on the agenda. Settings → Notifications can send a preview.
- **Sending** happens after the response (`after()`), so a slow push service never slows the change. Each notification is a row in `notifications` with a dedupe key, so a retried webhook or overlapping crons send it once. A device the push service reports gone (404/410) is deleted; one that fails 5 times in a row is dropped.

## Background jobs

Vercel Cron, all on the same quarter-hour blocks so the database can scale to zero between them (Neon suspends after a few idle minutes): the campaign cron (email and text campaigns), the agent cron (scheduled jobs that are due, and the safety net for background runs), the inbox sync, the Microsoft 365 mailbox sync (which skips the blocks that don't fit `microsoft.syncEveryMinutes`) and the notifications cron (meeting and task pushes, morning summaries and agenda emails) run at :00, :15, :30 and :45, and the delivery check runs at :00. Nothing runs more often than every 15 minutes. The browser's only repeated request is the live-update check below, which stops when no one is using the page. Scheduled campaigns are rounded up to the next quarter hour, so they go out exactly when the cron runs. Work someone starts by hand ("Send now", "Sync now") runs right away.

## Live updates

Open pages show changes without a reload: a task the agent just added, a call that came in, a teammate's edit.

- **How:** `LiveUpdates` (`src/components/live-updates.tsx`, in the `(app)` layout) asks `/api/live` for the newest change's version: the latest `events.created_at`, `activities.updated_at` or `chat_messages.updated_at` (`src/lib/live.ts`, three index lookups). When it moved, `router.refresh()` re-renders the page and the sidebar counts on the server. What's typed, open or scrolled in the browser stays as it was.
- **When it asks:** right away after each agent tool call (chat and voice, `checkForChanges()`), when the tab comes back into view or the window regains focus, and every `live.pollSeconds` (30) while the tab is visible and someone clicked or typed in the last `live.idleMinutes` (10). The team chat page asks every `live.chatPollSeconds` (5) instead, under the same idle rule, so messages show up within seconds. Hidden or idle tabs don't ask, so a CRM left open overnight lets Neon suspend.
- **Cost:** a check is one small function call and one indexed query. A dozen people working 8 hours a day is about 250,000 checks a month, well within Vercel Pro's included invocations, and the database is awake during working hours anyway. Raise `live.pollSeconds` to ask less often, or set it to `0` to rely on focus and agent checks alone.
- **Why not sockets:** a push service (Pusher, Ably) or Neon's logical replication would add a vendor or keep the database from sleeping, for a difference of a few seconds. `activities.updated_at`, set by Drizzle on every update (`$onUpdate` in `schema.ts`), keeps the check honest for edits that don't set it by hand.

## Knowledge source

- `src/lib/knowledge/` reads one deployment-configured JSON API about the organization (usually its website's content) with `KNOWLEDGE_API_URL` / `KNOWLEDGE_API_KEY`, for the REST API, MCP and the agent (`get_knowledge`). Read-only, confined to the base URL, no redirects, 10 seconds and 2 MB at most. See [KNOWLEDGE.md](KNOWLEDGE.md).

## Stripe

- `src/lib/stripe.ts` reads a linked customer's subscriptions, invoices, payments and balance live from the Stripe REST API (no SDK) with `STRIPE_SECRET_KEY`. A restricted, read-only key is enough; the CRM never writes to Stripe. The billing card renders in its own `<Suspense>` boundary so a slow Stripe never holds up the client page.

## Local fallbacks

Every external service is optional in development (see the README). The fallbacks refuse to run on Vercel, so production can't silently use them.
