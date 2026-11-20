# Theming

The app's structure (type scale, spacing, radii, shadows, table and board patterns) follows one design system; its **colors** all come from CSS variables. There are two ways to change them:

- **Per deployment, with environment variables.** No code change, so a fork stays identical to upstream and one repo can serve several differently branded deployments. Start here.
- **In the code** (`src/styles/theme.css`). Use this to change the defaults for every deployment of your fork.

## Per deployment: environment variables

Set these on the Vercel project (Settings → Environment Variables), then redeploy. Locally, put them in `.env.local` and restart `pnpm dev`.

```bash
# The simplest rebrand: one color. Hover, tint and tint-text shades are derived from it.
NEXT_PUBLIC_BRAND_COLOR="#2f629f"
NEXT_PUBLIC_APP_NAME="Acme CRM"

# Anything else in app.config.ts, as JSON. Only the keys you set change.
# For example, to record opens and clicks: NEXT_PUBLIC_APP_CONFIG='{"email":{"trackOpens":true,"trackClicks":true}}'

NEXT_PUBLIC_APP_CONFIG='{"theme":{"brandForeground":"#ffffff","tokens":{"canvas":"#f7f5f0","accent-hover":"#1f4677"}},"layout":{"defaultClientsView":"table"}}'
```

In `.env.local`, keep the quotes: unquoted, `#` starts a comment, so `#2f629f` would load as an empty value and the JSON would be cut off at its first color. In the Vercel dashboard, paste the value without the surrounding quotes.

What [`app.config.ts`](../app.config.ts) controls:

| Key | Default | What it does |
| --- | --- | --- |
| `brand.name` | `"CRM"` | Browser tab ("Clients · CRM") and installed-app name. The sidebar shows the workspace name from Settings → Workspace |
| `brand.description` | | HTML meta description |
| `theme.brandColor` | `null` | Sets `--accent` and `--ring`, and derives `--accent-hover` (15% darker), `--accent-soft` (10% tint on white) and `--accent-soft-foreground` with `color-mix()` |
| `theme.brandForeground` | `"#ffffff"` | Text on the brand color (`--accent-foreground`). Use a dark color for light brand colors |
| `theme.tokens` | `{}` | Any variable from the table below, without the leading `--`, e.g. `{"canvas":"#f7f5f0"}`. Wins over the derived values |
| `theme.browserColor` | `"#fafafa"` | Browser toolbar and installed-app title bar |
| `layout.defaultClientsView` | `"board"` | How Clients opens for a teammate who hasn't chosen board or table yet (`"board"` or `"table"`). Each person's own choice still wins |
| `email.trackOpens` | `false` | Record and show when people open emails (timeline, campaign report, campaign list). Off by default: tracking pixels can hurt deliverability and opens are approximate. Also turn on open tracking for the sending domain in Resend, then reconnect the webhook in Settings → Email domains |
| `email.trackClicks` | `false` | Record and show link clicks. Same trade-off: Resend rewrites links through its tracking domain. Also turn on click tracking in Resend, then reconnect the webhook |
| `agent.enabled` | `true` | The agent's button in the bottom right corner. See [AGENT.md](AGENT.md#configure-your-deployment) |
| `agent.freshChatMinutes` | `5` | Opening the agent panel this many minutes after the last message or answer starts on a new chat. The old one stays in the chat menu |
| `agent.voice`, `agent.dictation`, `agent.summaries` | `true` | Voice chat, the dictation microphones and record summaries, each on or off. Off hides it and its route refuses it |
| `agent.name` | `"Agent"` | The agent's name in its panel, its replies and history |
| `agent.chatModel`, `agent.titleModel`, `agent.voiceModel`, `agent.transcriptionModel` | GPT-6.1 Sol, Claude Haiku 5.5, Grok Voice 3.0, Grok STT | AI Gateway model ids (`creator/model`) for chat, thread titles, voice chat and dictation |
| `agent.chatReasoning` | `"medium"` | Reasoning effort for chat: `"provider-default"`, `"none"`, `"minimal"`, `"low"`, `"medium"` or `"high"` |
| `agent.summaryModel`, `agent.summaryReasoning` | GPT-6.1 Sol, `"low"` | The model and reasoning effort for the AI summary at the top of client, person and organization pages |
| `agent.fileDescriptions`, `agent.fileModel`, `agent.embeddingModel` | `true`, GPT-6 Luna, text-embedding-3-small | AI descriptions of uploaded files, the model that writes them, and the one that turns them into search vectors (1536 dimensions). See [AGENT.md](AGENT.md#file-descriptions) |
| `agent.background.enabled` | `true` | The agent's background work: jobs handed off from chat, mentions in notes and tasks assigned to it. See [AGENT.md](AGENT.md#background-work) |
| `agent.background.model`, `agent.background.reasoning`, `agent.background.researchModel` | GPT-6.1 Sol, `"low"`, GPT-6 Luna | The model that plans and changes records, its reasoning effort, and the smaller model that reads the web |
| `agent.background.maxRunUsd`, `agent.background.monthlyBudgetUsd` | `0.75`, `30` | Spending limits in US dollars: for one run, and for the workspace per month |
| `agent.background.maxRunMinutes`, `agent.background.maxConcurrentPerUser`, `agent.background.maxBulkRecords` | `20`, `3`, `50` | How long one run may take, how many of a teammate's runs work at once, and the most records one bulk request covers |
| `agent.background.clearAfterMinutes` | `15` | A finished background task leaves the panel's list this long after the teammate's open panel first listed it |
| `agent.forwarding.enabled` | `true` | Email forwarding: the team's one address (the agent's name at `FORWARD_EMAIL_DOMAIN`) that the agent reads and answers. Also needs background work. See [AGENT.md](AGENT.md#email-forwarding) |
| `agent.forwarding.perHour`, `agent.forwarding.maxRounds`, `agent.forwarding.maxChars`, `agent.forwarding.maxAgeDays` | `20`, `8`, `40000`, `3` | The most emails one teammate can send it an hour, how many times one conversation can go back and forth, how many characters of it the agent reads, and how old an email may be by its own date (forwards are dated when sent, so old threads are fine) |
| `agent.suggestions`, `agent.viewerSuggestions` | 4 prompts each | Suggested actions on a new chat, for teammates who can edit and for viewers. A prompt ending in `…` fills the composer instead of sending |
| `notifications.morningHour` | `7` | The hour (0–23, workspace time zone) the morning push summary and the agenda emails go out |
| `live.pollSeconds` | `30` | How often an open page asks whether anything changed (calls, texts and email coming in, teammates' edits) and refreshes if so. Only while the tab is visible and in use. `0` turns it off; pages still catch up when the tab comes back into view and after the agent changes something. See [ARCHITECTURE.md](ARCHITECTURE.md#live-updates) |
| `live.idleMinutes` | `2` | Minutes without a click or key press after which open pages stop asking, so the database can sleep soon after someone steps away. Pages catch up on the next click or when the tab comes back into view |
| `live.chatPollSeconds` | `5` | How often the team chat page asks for new messages while it's open, visible and in use (the same idle rule applies). `0` falls back to `live.pollSeconds` |
| `records.keyContactLabel` | `"Decision maker"` | What a starred person at an organization is called (the star's tooltip, their page and the audience filter) |
| `microsoft.*` | | Microsoft 365: sync frequency, the mail screen (decision model, what counts as sensitive, threshold), the Outlook category for kept-out mail, which activities go on calendars. See [MICROSOFT.md](MICROSOFT.md#settings-per-deployment) |
| `phone.*` | | Calling and texting: default country code, forwarded caller ID, ring time, missed-call message, text campaign consent and footer. See [PHONE.md](PHONE.md#settings-per-deployment) |
| `pwa.shortName` | `null` | Name under the icon on a phone's home screen. Defaults to `brand.name`; keep it to about 12 characters |
| `pwa.iconBackground` | `null` | The app icon's color. Defaults to `theme.brandColor`, then the default accent |
| `pwa.iconForeground` | `"#ffffff"` | The letter on the icon (the first letter of `brand.name`) |
| `pwa.backgroundColor` | `"#fafafa"` | The splash screen while the installed app opens. Match `--canvas` |

`NEXT_PUBLIC_APP_NAME` and `NEXT_PUBLIC_BRAND_COLOR` are shortcuts for `brand.name` and `theme.brandColor`, and win over the same keys in the JSON.

Rules:

- A key that isn't in `app.config.ts`, a wrong type, a value outside a fixed list, invalid JSON, or a CSS value that isn't a plain color **fails the build** with a list of what to fix. On Vercel the previous deployment keeps serving.
- Values are compiled into the page at build time, so they're public and need a redeploy to change. Never put secrets in them.
- With nothing set, no extra CSS is rendered and the app looks exactly like `theme.css`.
- Installed apps keep the icon they were installed with until the phone refreshes it, which can take a day or a reinstall.

## In the code: change the defaults

Edit [`src/styles/theme.css`](../src/styles/theme.css) for every deployment of your fork. Components never use raw hex values, so nothing else needs to change. To make a new setting overridable per deployment, add it to `app.config.ts` (and, for a fixed list of values, to `ENUMS` in `src/lib/config-overrides.ts`).

| Variable | Used for |
| --- | --- |
| `--accent`, `--accent-hover`, `--accent-foreground` | Primary buttons, selected tabs, focus rings, the "mine" marker in tables, filled board stages |
| `--accent-soft`, `--accent-soft-foreground` | Active navigation, selected rows, soft chips |
| `--background`, `--canvas`, `--surface`, `--surface-sunken` | Page, app background, cards, inputs and columns |
| `--text-primary` … `--text-faint` | Titles, body, supporting copy, icons and placeholders |
| `--border`, `--border-strong`, `--ring` | Lines and focus |
| `--success`, `--warning`, `--error`, `--info`, `--neutral` (+ `-surface`, `-border`) | Status badges. Keep their meaning; adjust shades if needed |
| `--note-surface`, `--note-border` | The soft yellow behind a note's icon on a timeline |
| `--toast-success-icon` | The check in a success toast (it sits on a dark background) |
| `--agent-panel-opacity` | How solid the agent's panel is on a desktop (`80%`). `100%` makes it opaque; lower shows more of the page behind it |
| `--live-highlight`, `--live-highlight-ring` | The glow on whatever just appeared or changed on an open page. A tint of the accent by default |

Example: a blue brand.

```css
:root {
  --accent: #2f629f;
  --accent-hover: #28548a;
  --accent-foreground: #ffffff;
  --accent-soft: #eef3fa;
  --accent-soft-foreground: #1f4677;
  --ring: #2f629f;
}
```

Check contrast: text on `--accent` should be at least 4.5:1, and don't fade the accent on hover (use a darker `--accent-hover`).

## Change the fonts

Fonts load in [`src/app/layout.tsx`](../src/app/layout.tsx) with `next/font` and are wired up as `--font-geist` / `--font-geist-mono`. Swap the import (any Google font, or `next/font/local` for your own files) and keep the variable names, or update `--font-sans` in `src/app/globals.css`.

## Change shapes and the type scale

`src/app/globals.css` holds the radii (`--radius-*`), shadows and the type scale utilities (`text-page-title`, `text-section`, `text-label`, `text-fine`, `text-table-header`).

## Emails

Emails don't use the app theme: email clients need inline styles. Their look comes from the **brand kit** in Settings → Email and brand (logo, button color, sender name, address, signature), so it can be changed without a deploy. The layout itself is in [`src/emails/layout.tsx`](../src/emails/layout.tsx).

## Keeping a private brand out of a public fork

Keep the repo neutral and put your brand in the deployment: `NEXT_PUBLIC_APP_NAME`, `NEXT_PUBLIC_BRAND_COLOR` and `NEXT_PUBLIC_APP_CONFIG` on the Vercel project, and the logo, address and signature in Settings (stored in the database). Your production deployment then builds straight from the public `main` branch, with no private branch to keep merged.
