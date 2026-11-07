# Contributing

Thanks for wanting to help. Be decent; see the [code of conduct](CODE_OF_CONDUCT.md).

## Before you write code

1. Open an issue and describe the change. Please don't send a surprise refactor.
2. Keep the diff to the bug or feature you named.
3. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The conventions that matter most:
   - Every export in a `"use server"` file is a public endpoint: call `actionUser()` / `actionAdmin()` first, validate with zod, return through `run()`.
   - Record changes write an `events` row in the same action (`recordEvent`).
   - Colors come only from `src/styles/theme.css` tokens; never hard-code hex in components.
   - Copy is sentence case, says what happened and what to do next, no exclamation marks.
4. Anything a deployment might want to change (product name, colors, a layout default) belongs in [`app.config.ts`](app.config.ts), so it can be overridden per deployment with `NEXT_PUBLIC_APP_CONFIG`. Don't hard-code it in a component. Secrets go in environment variables and `.env.example`. Workspace data (name, brand kit, pipelines) belongs in the database and Settings.

## How to work

```bash
pnpm install
pnpm dev        # http://localhost:3200, no environment variables needed
```

Before you open a pull request:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

UI changes need a real pass in the browser, not only a compile. Schema changes: edit `src/db/schema.ts`, then `pnpm db:generate --name <what-changed>`, and commit the migration.

## Please don't

- Commit `.env*` files (other than `.env.example`) or `.data/`
- Commit a deployment's branding: put it in `NEXT_PUBLIC_APP_CONFIG` on that deployment instead
- Reformat unrelated files

## Pull requests

One problem per pull request. Say what you changed and how you checked it.
