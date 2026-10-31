# Simple CRM

A light, fast CRM for small B2B teams (two to a few dozen people). People, organizations and deals; a pipeline board and tables; one place to log calls, emails, texts, meetings, notes and tasks; files; custom fields; and branded email, from one-off messages to campaigns.

It's built to cover the 80% of CRM work a small team does every day, and to stay out of the way while doing it.

**Stack:** Next.js 16 (App Router, Cache Components) · React 19 · TypeScript · Tailwind CSS 4 · Neon Postgres + Drizzle ORM · Resend + React Email · Vercel Blob · Vercel.

## What it does

- **People, organizations, deals.** Every record has a details panel you edit in place, custom fields, related records and files, and one timeline.
- **One timeline per record.** Notes, calls, emails, texts, meetings and tasks, plus every change (stage moves, owner changes, field edits) and every file, each attributed to the teammate who did it. Logged on a deal, an activity also shows on the deal's person and organization.
- **A composer that's fast to use.** Pick a tab, write a sentence, ⌘↵. Calls take a direction and an outcome; anything that happened can schedule a follow-up in the same step.
- **Next steps are never lost.** Open deals with nothing planned are flagged on the board, the deal page and the home page; checking off a deal's last task asks what's next.
- **Board or table, per person.** Drag deals between stages (or onto Won/Lost); switch to a sortable table. Each teammate's choice is remembered.
- **Email built in.** Send from any record as yourself (replies come to your inbox) with templates and merge fields; send campaigns to filtered audiences with a live preview, test sends, scheduling and one-click unsubscribe. A brand kit (logo, color, address, signature) wraps every email.
- **Import** people from CSV or Excel: match columns, merge by email, undo.
- **Files** live in a private store and only stream to signed-in teammates.
- **Team** is invite-only with email-and-password sign-in, roles (owner, admin, member) and deactivation that keeps history intact.

## Run it locally

```bash
pnpm install
pnpm dev
```

Open http://localhost:3200 and create the owner account. With no environment variables set, everything still works:

| Service | Locally, without configuration |
| --- | --- |
| Database | An embedded Postgres (PGlite) in `.data/`, migrated on first use |
| Email | Printed to the terminal (invite and reset links included) |
| Files | Saved to `.data/uploads/` |

Settings → Workspace has **Add sample data** (local development only) to fill an empty workspace with realistic records.

## Deploy to Vercel

See [docs/DEPLOYING.md](docs/DEPLOYING.md). In short: connect Neon and a **private** Blob store from the Vercel Marketplace, set `AUTH_SECRET`, `RESEND_API_KEY`, `RESEND_FROM` and `CRON_SECRET`, and deploy. Migrations run in the build.

## Make it yours

- **Look and feel:** every color comes from one file, [`src/styles/theme.css`](src/styles/theme.css). See [docs/THEMING.md](docs/THEMING.md).
- **Emails:** the brand kit in Settings → Email and brand. No code needed.
- **Pipelines, stages and custom fields:** Settings.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the code is organized and why
- [docs/SECURITY.md](docs/SECURITY.md): authentication, sessions, files, and what keeps a public repo safe to deploy
- [docs/THEMING.md](docs/THEMING.md): changing the design
- [docs/DEPLOYING.md](docs/DEPLOYING.md): production setup
- [docs/BUILD-LOG.md](docs/BUILD-LOG.md): decisions made while building it

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Dev server on port 3200 |
| `pnpm build` | Production build |
| `pnpm lint` / `pnpm typecheck` | ESLint / TypeScript |
| `pnpm db:generate` | Create a migration from `src/db/schema.ts` changes |
| `pnpm db:migrate` | Apply migrations to `DATABASE_URL` (runs in the Vercel build) |
| `pnpm email:dev` | Preview the email templates in `src/emails` |

## License

MIT
