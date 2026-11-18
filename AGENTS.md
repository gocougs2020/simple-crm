<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Working in this repo

- Read `docs/ARCHITECTURE.md` first. Conventions that matter:
  - Every export in a `"use server"` file is a public endpoint: call `actionUser()` / `actionAdmin()` first, validate with zod, return through `run()`.
  - Record changes write an `events` row in the same action (`recordEvent`), so history stays complete.
  - Record changes (people, organizations, clients, activities) live in `src/lib/crm/service/*` and take an `Actor`; server actions, the REST API and MCP all call them. Check permissions with `assertCan` (`src/lib/permissions.ts` is the role table). Mutating actions elsewhere use `actionEditor()` so viewers are refused.
  - API endpoints and MCP tools come from one list: add an entry to `src/lib/api/operations.ts` and its handler in `src/lib/api/handlers.ts` (see `docs/API.md`).
  - The agent's background worker is an eve agent in `agent/` (docs/AGENT.md). It changes the CRM only through MCP, as the teammate a run works for, so new abilities are new operations, not new agent tools. eve's docs are in `node_modules/eve/docs/`; read them before changing `agent/`. A run never sends, archives, deletes or merges (`runMayUse` in `src/lib/agent/run-rules.ts`).
  - Colors come only from `src/styles/theme.css` tokens; never hard-code hex in components.
  - Deployment-specific product defaults (name, theme, layout defaults) live in `app.config.ts`, overridable per deployment with `NEXT_PUBLIC_APP_CONFIG` / `NEXT_PUBLIC_APP_NAME` / `NEXT_PUBLIC_BRAND_COLOR` (`src/lib/config-overrides.ts`). Add new knobs there, not in components, and document them in `docs/THEMING.md`.
  - Copy is sentence case, says what happened and what to do next, no exclamation marks.
- `pnpm dev` (port 3200) works with no environment variables. `.claude/launch.json` starts it.
- Before committing: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
- Schema change: edit `src/db/schema.ts`, then `pnpm db:generate --name <what-changed>`.
