# Simple CRM

A light, fast CRM for small B2B teams (two to a few dozen people). People, organizations and clients (prospective, current and past); pipeline boards and tables; one place to log calls, emails, texts, meetings, notes and tasks; files; custom fields; and branded email, from one-off messages to campaigns.

It's built to cover the 80% of CRM work a small team does every day, and to stay out of the way while doing it.

**Stack:** Next.js 16 (App Router, Cache Components) · React 19 · TypeScript · Tailwind CSS 4 · Neon Postgres + Drizzle ORM · Resend + React Email · Vercel Blob · Vercel.

## What it does

- **Clients in three buckets.** Prospective, current and past, each with its own pipelines and stages, and a record page that fits: potential value for prospects; health, services, monthly revenue, Stripe billing, performance numbers and how long since anyone talked to them for current clients; what they had, why they left and whether they'd come back for past clients. Signing, leaving and winning back are one step each.
- **Services** you sell are set up once in Settings and picked per client, with their own price and dates.
- **People, organizations, clients.** Every record has a details panel you edit in place, custom fields, related records and files, and one timeline.
- **One timeline per record.** Notes, calls, emails, texts, meetings and tasks, plus every change (stage moves, owner changes, field edits) and every file, each attributed to the teammate who did it. Logged on a client, an activity also shows on the client's contact and organization, and received email lands there by itself.
- **A composer that's fast to use.** Pick a tab, write a sentence, ⌘↵. Calls take a direction and an outcome; anything that happened can schedule a follow-up in the same step.
- **Next steps are never lost.** Prospects and current clients with nothing planned are flagged on the board, at the top of their page and on the home page; checking off their last task asks what's next.
- **Board or table, per person.** Drag clients between stages (or onto Signed, Left or Won back); switch to a sortable table. Each teammate's choice is remembered.
- **Email built in.** Add your domains and team inboxes (sales@, support@) in Settings, powered by Resend. Incoming mail lands in a shared inbox and on the timeline of the person, organization and client it's about; reply from the CRM. Send from any record through an inbox, with templates and merge fields. Campaigns go to filtered audiences (past clients open to coming back, say) with a live preview, test sends, scheduling and one-click unsubscribe. A brand kit (logo, color, address, signature) wraps every email.
- **Import** people from CSV or Excel: match columns, merge by email, undo.
- **Move from Pipedrive** with `pnpm import:pipedrive`: people, organizations, deals collapsed into one client per organization, products as services, notes, activities and email. See [docs/PIPEDRIVE-IMPORT.md](docs/PIPEDRIVE-IMPORT.md).
- **Files** attach to a record or to a note, call or meeting, and each record's Files card gathers them all, along with attachments on its email. They live in a private store and only stream to signed-in teammates.
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
| Email | Printed to the terminal (invite and reset links included). The inbox needs Resend |
| Stripe | The billing card explains how to connect |
| Files | Saved to `.data/uploads/` |

Settings → Workspace has **Add sample data** (local development only) to fill an empty workspace with realistic records.

## Deploy to Vercel

See [docs/DEPLOYING.md](docs/DEPLOYING.md). In short: fork the repo (or import it directly), connect Neon and a **private** Blob store from the Vercel Marketplace, set `AUTH_SECRET`, `RESEND_API_KEY`, `RESEND_FROM` and `CRON_SECRET`, and deploy. Migrations run in the build. Optionally set `NEXT_PUBLIC_APP_NAME` and `NEXT_PUBLIC_BRAND_COLOR` to brand it.

## Make it yours

Every deployment can look and behave like its own product **without changing the code**, so you can fork it (or deploy this repo as is) and still pull upstream changes cleanly.

| What | Where | Needs a deploy? |
| --- | --- | --- |
| Product name, brand color, theme tokens, layout defaults | Environment variables on the Vercel project ([below](#per-deployment-config)) | Redeploy |
| Workspace name, email brand kit (logo, color, address, signature) | Settings → Workspace, Settings → Email and brand | No |
| Pipelines (per client category), stages, services, custom fields | Settings | No |
| Defaults for every deployment of your fork | [`app.config.ts`](app.config.ts) and [`src/styles/theme.css`](src/styles/theme.css) | Commit |

### Per-deployment config

[`app.config.ts`](app.config.ts) holds the defaults. A deployment overrides them with environment variables:

| Variable | Overrides | Example |
| --- | --- | --- |
| `NEXT_PUBLIC_APP_NAME` | `brand.name` (browser tab, installed-app name) | `Acme CRM` |
| `NEXT_PUBLIC_BRAND_COLOR` | `theme.brandColor`: buttons, focus rings and selected states, with hover and tint shades derived from it | `#2f629f` |
| `NEXT_PUBLIC_APP_CONFIG` | Any key in `app.config.ts`, as JSON, deep-merged | `{"layout":{"defaultClientsView":"table"},"theme":{"tokens":{"canvas":"#f7f5f0"}}}` |

Unknown keys, wrong types, invalid JSON and unsafe CSS values fail the build with a list of what to fix, so a typo never ships. These values are public (they're compiled into the page): never put secrets in them. See [docs/THEMING.md](docs/THEMING.md) for every option.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the code is organized and why
- [docs/SECURITY.md](docs/SECURITY.md): authentication, sessions, files, and what keeps a public repo safe to deploy
- [docs/THEMING.md](docs/THEMING.md): changing the design
- [docs/DEPLOYING.md](docs/DEPLOYING.md): production setup
- [docs/PIPEDRIVE-IMPORT.md](docs/PIPEDRIVE-IMPORT.md): importing from Pipedrive
- [docs/BUILD-LOG.md](docs/BUILD-LOG.md): decisions made while building it

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Dev server on port 3200 |
| `pnpm build` | Production build |
| `pnpm lint` / `pnpm typecheck` | ESLint / TypeScript |
| `pnpm test` | Unit tests (`src/**/*.test.ts`) |
| `pnpm db:generate` | Create a migration from `src/db/schema.ts` changes |
| `pnpm db:migrate` | Apply migrations to `DATABASE_URL` (runs in the Vercel build) |
| `pnpm email:dev` | Preview the email templates in `src/emails` |
| `pnpm import:pipedrive` | Import a Pipedrive account ([how it maps](docs/PIPEDRIVE-IMPORT.md)) |

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately ([SECURITY.md](SECURITY.md)).

## License

[MIT](LICENSE)
