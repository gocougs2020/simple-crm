# Build log

Decisions made while building this, newest at the top, so the history reads as documentation.

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
- Email open and click tracking (Resend webhooks), and logging replies automatically (inbound email).
- Saved views and filters per teammate beyond owner, tag and search.
- Reports (won/lost by month, stage conversion, activity by teammate).
- Merging duplicate people and organizations.
- Two-way calendar sync for meetings.
