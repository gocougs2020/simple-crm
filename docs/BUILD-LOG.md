# Build log

Decisions made while building this, newest at the top, so the history reads as documentation.

## 2026-11-16 · Twilio API keys instead of the auth token

**Goal.** Follow Twilio's advice: keep the account's auth token, which can do anything to the account, off the deployment.

- **One Standard API key for everything.** Every REST call authenticates with `TWILIO_API_KEY_SID`/`SECRET` (the account SID stays in the URL), and the same key signs browser-call tokens. Restricted keys were considered, but Twilio doesn't let them sign access tokens, and a second, Standard key on the same server would cancel out what restricting the first one buys. A Standard key still can't touch the account, subaccounts or keys, and is revoked on its own.
- **Webhooks signed with a signing key.** Twilio's webhook configuration API can sign webhooks with a SharedKey instead of the auth token. The CRM checks those with `TWILIO_WEBHOOK_SECRET` (several, comma-separated, for rotation), using the algorithm Twilio names in `X-Twilio-Webhooks-Signature-Settings`, and checks unmarked ones with the auth token if it's set. The rule is set up by hand (docs/PHONE.md): it's a one-time step, and doing it from Settings would mean polling Twilio's operations API from a request.
- **The auth token keeps working.** Deployments that already use it carry on, and keep it until their signing-key rule is live; Settings says when the auth token is in use, and when nothing can verify webhooks.

## 2026-11-16 · Microsoft 365, calling and texting, decision makers, text campaigns

**Goal.** Let each teammate work from their own Outlook and calendar inside the CRM, call and text from records, and reach the right people at an organization, the way Pipedrive's mail and calendar sync and its calling add-ons do, while staying configurable per deployment for an open-source project.

- **Configured by environment, not by code.** Credentials are environment variables (`MICROSOFT_*`, `TWILIO_*`); behavior is `app.config.ts` keys (`microsoft.*`, `phone.*`, `records.keyContactLabel`) overridable with `NEXT_PUBLIC_APP_CONFIG`. Without credentials each feature hides itself. Browser-calling plumbing (a TwiML app and an API key) is created from Settings rather than asked for, the same way the Resend webhook is.
- **Each teammate's own mailbox, not a shared one.** Microsoft is connected per person with delegated permissions, so mail goes out as them and nobody's mailbox is readable through anyone else's account. Tokens are encrypted at rest.
- **Only mail with known contacts, and private mail never.** Copying everything would flood timelines and the database. Mail is copied only when a person or organization in the CRM is on the other side, never between teammates. Outlook's own Private/Confidential label is honored without asking a model; everything else is screened by a decision model (TypeSafe's Jev through AI Gateway) that answers "is this sensitive?" with a probability instead of writing text, so screening every email stays fast and nearly free, with a threshold each deployment sets. If the screen is unavailable, mail goes in: the Outlook label is the guarantee and the screen a second net, and holding mail back would make the timelines quietly incomplete. Kept-out mail is marked in Outlook so people can see what happened, and no content of it is stored.
- **Read calendars live, store nothing.** Teammates' Outlook events are fetched when Calendar opens, as much as each shares, so they're always current and cost the database nothing. Only CRM meetings are pushed to calendars, and kept in step.
- **Calls and texts are activities.** A call made or forwarded and a text either way is one row in its own table (Twilio's ids, status, length) plus an activity, so timelines, "last contact" and the assistant see them with no new concepts. Call notes are the activity's body.
- **Incoming calls forward, they don't ring browsers.** Forwarding to a cell phone works with nobody at a desk; the CRM logs who called and gives the person who answers a task to write it up.
- **Consent first for text campaigns.** Text campaigns need a recorded agreement to marketing texts by default, STOP is honored immediately, and every campaign text carries an opt-out line. All three are settings, because the right answer depends on the deployment's country and use.
- **One audience model for both channels.** Text campaigns reuse email campaigns' filters, saved audiences, scheduling and the claim-and-resume sender. New filters (decision makers only, organization industry, organization custom fields) work for both.

## 2026-11-15 · Email: delivery tracking, audiences, attachments, reply-to, quarter-hour jobs

**Goal.** Email that a team can rely on from a person's or deal's page and for campaigns: know whether each email arrived, reuse audiences, send files, and choose where replies go. The delivery-tracking design follows the earlier project (Live Bold Idaho), adapted to people, clients and history here.

- **Delivery status only moves forward.** Resend's reports arrive late, twice and out of order. A rank (sent < delayed < delivered < failed/suppressed < bounced < complained) and one conditional `UPDATE` keep the latest meaningful status. A webhook report that beats its row returns 503 so Resend retries; an hourly check covers reports that never arrive.
- **Only our own email can flag a person.** Bounce and complaint protection runs only when the report matches a row we saved, so a shared Resend account can't unsubscribe our people.
- **Open and click tracking are a deployment setting, off by default.** Tracking pixels and rewritten links can hurt deliverability, and opens are unreliable (some mail apps open everything for privacy), so delivery is what's always tracked. `email.trackOpens` / `email.trackClicks` in `app.config.ts` turn the rest on for deployments that want it, through the same `NEXT_PUBLIC_APP_CONFIG` override as theming, so forks configure it without code changes.
- **Last campaign is separate from last contact.** Last contact means personal outreach (logged activity, one-off emails). Campaigns set `people.last_campaign_at` instead, so a newsletter never hides a neglected relationship, and "no campaign in N days" finds people who haven't heard from you.
- **Campaign emails are on every timeline but aren't contact.** One activity per recipient, linked to the client they matched; excluded from "last contacted", the Activities page and the home feed.
- **Saved audiences are filters, not lists.** A campaign that uses one reads its filters when it sends, so new people are included; it keeps a copy in case the audience is deleted.
- **Attachments are CRM files.** Uploaded to the record first (so they show in its Files), read from Blob at send time. Resend's batch endpoint doesn't take attachments, so a campaign with files sends one email at a time and says so.
- **Replies go to a person, not a shared default.** A one-off email replies to whoever sent it, a campaign to whoever set it up; either can be changed per email or campaign. The brand kit's workspace-wide campaign reply-to was removed.
- **Background jobs run on quarter-hour blocks.** Every cron runs at :00/:15/:30/:45 (or :00 only) so Neon can scale to zero between runs; scheduled campaigns round up to the next block.

## 2026-10-30 · First version

**Goal.** A CRM that does what a small B2B team needs every day (people, organizations, deals, logging what happened, knowing what's next, email) and nothing that makes it feel heavy. Pipedrive's model, without its sprawl.

**Starting point.** The stack and habits of an earlier project (a Next.js 16 site with an admin CRM and email campaigns): Neon + Drizzle with an embedded PGlite fallback, Resend + React Email, Vercel Blob, server-side sessions, rate limits in Postgres, sends that are safe to retry. Every service is optional locally, so `pnpm install && pnpm dev` works on a fresh clone.

### Product decisions

- **Three record types, one timeline each.** People and organizations are who you work with; deals are the work. Everything someone does or plans is an activity on the timeline, attributed to them; every change is a history entry.
- **Activities in one table.** Note, call, email, text, meeting, task. One composer with a tab per type, asking only what that type needs. Defaults are "now, by me", so logging a call is a tab, a sentence and ⌘↵.
- **Links roll up.** Logged on a deal, an activity also appears on the deal's person and organization. The organization page tells the whole story.
- **The next step is the product.** The most valuable idea from Pipedrive: every open deal should have something planned. Deals without one are flagged on the board, on the deal, and on the home page; finishing a deal's last task asks what's next, in place.
- **Board and table are the same data.** Each teammate's choice is remembered on their account, so it follows them across devices. List filters live in the URL.
- **Soft delete.** Records are archived, never destroyed from the UI, with Undo.
- **Email is part of the CRM, not a separate tool.** One-off emails go out as the teammate (replies reach their own inbox) and land on the timeline. Campaigns use simple, explainable audience filters (tags, stage, owner) evaluated at send time. A brand kit in the database wraps every email.
- **Invite-only, email and password.** The first visitor sets up the workspace and becomes the owner. (The earlier project used passwordless links; a team tool people open all day is better served by passwords and a password manager.)

### Technical decisions

- **Cache Components on.** Next 16 makes it the default in the next major. Every page streams a static shell and fills in per-request data inside `<Suspense>`; `getDb()` calls `connection()` so database reads are always request-time.
- **scrypt from Node's standard library** for passwords: no native module to build on Vercel.
- **Fractional ranks** for board order: a drag writes one row.
- **Integer cents** for money.
- **Custom fields as JSON on the record**, defined in `custom_fields` with stable keys. Simple to query, no join per field, and renames are free.
- **Private Blob for files**, streamed through an authenticated route. Browsers upload directly to Blob (no 4.5 MB function limit).
- **Rich text via TipTap, sanitized on the server** with a small allow-list.

### Design

The interface follows the HiringCenter design system for everything except color: Geist and Geist Mono, desktop-dense layouts, flat 1px-bordered surfaces, radius-md controls and radius-xl cards, uppercase table headers with tabular digits, status badges that always carry a word, Heroicons, and sentence-case copy that says what to do next. Colors are a neutral grayscale with a near-black accent, all in `src/styles/theme.css`, so a brand can be applied later in one file.

### Not in this version (candidates for next)

- A block-based campaign editor (sections, columns, buttons) like the earlier project's `@react-email/editor` setup. Campaigns currently use the same rich-text editor as notes, inside the brand layout.
- Email open and click tracking (Resend webhooks).
- Saved views and filters per teammate beyond owner, tag and search.
- Reports (signed and lost by month, churn by reason, stage conversion, activity by teammate).
- Merging duplicate people and organizations.
- Two-way calendar sync for meetings.

## Clients, services, Stripe and the inbox

**Goal.** Deals were limiting: a deal ends at won or lost, but the relationship doesn't. The team wanted to organize everyone they work with as prospective, current or past clients, manage current accounts, and keep past clients reachable for win-back campaigns. Email had to become first-class: real inboxes on the team's own domains, with mail landing on the right records.

- **Deals became clients, renamed in place.** The `deals` table, its links from activities and files, its history and custom fields were renamed rather than copied, so every id and link survived. Won deals became current clients (client since the day they closed); lost ones stayed prospects in a new "Not now" stage, with their reason kept in history.
- **Category, not status.** A client's category (prospective, current, past) decides its pipeline, its page and its board's drop zones (Signed, Left, Won back). Stages stay free-form per pipeline, so each category moves through its own steps.
- **Services instead of a plan field.** A catalog in Settings, linked per client with its own price and dates. Monthly revenue is computed from open services, and a past client's ended services are exactly "what their subscription had been".
- **Performance is numbers over time.** Teams track different things (leads, hires, ad spend), so metrics are free-form labels with a value per period, shown with their trend.
- **Stripe is read live, not synced.** Billing changes constantly and Stripe is the source of truth; a read-only key and one card per client avoid a sync job and stale numbers. (Later: admins can start, change and cancel subscriptions from the card, which needs write access to Subscriptions; see ARCHITECTURE.md.)
- **Inbox: Resend holds the mail, the CRM holds the links.** Threads are mirrored so they can be linked, searched and shown on timelines without a round trip, and every message becomes an email activity. Webhook first, cron as a safety net, a button for impatience.

