<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Working in this repo

- Read `docs/ARCHITECTURE.md` first. Conventions that matter:
  - Every export in a `"use server"` file is a public endpoint: call `actionUser()` / `actionAdmin()` first, validate with zod, return through `run()`.
  - Record changes write an `events` row in the same action (`recordEvent`), so history stays complete.
  - Colors come only from `src/styles/theme.css` tokens; never hard-code hex in components.
  - Copy is sentence case, says what happened and what to do next, no exclamation marks.
- `pnpm dev` (port 3200) works with no environment variables. `.claude/launch.json` starts it.
- Before committing: `pnpm lint && pnpm typecheck && pnpm build`.
- Schema change: edit `src/db/schema.ts`, then `pnpm db:generate --name <what-changed>`.
