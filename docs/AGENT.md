# The agent

Every teammate has an agent in the bottom right corner of the CRM. It answers questions about clients, people, organizations and tasks, and makes changes for them: log a call, add a task, move a client, update a record. It can also talk, in a live voice conversation or by dictating into the composer.

It works on the teammate's signed-in session. There's no API key to create and nothing to connect: it has exactly the access the teammate has in the browser, through the same operations as the [REST API and MCP](API.md).

## What it can do

| | Owner, admin, member | Viewer |
| --- | --- | --- |
| Look up records, timelines, tasks, pipelines, the team | ✓ | ✓ |
| Create and edit records, log activity, add and complete tasks, move clients | ✓ | |
| Archive records, delete tasks, notes and activity | ✓, after the teammate presses a confirm button | |

- **Tools are the MCP tools.** One per API operation, generated from `src/lib/api/operations.ts` and filtered by role (`allowedOperations` in `src/lib/agent/policy.ts`). Adding an operation with a `tool` name gives the agent that tool too. Each call runs through `executeOperation`: the permission check, validation and history are the same as for the API.
- **History says who.** Changes show as "Sam via Agent" on timelines. Each teammate has one `assistant` row in `api_keys` for this: it holds no usable token (the agent runs on the session cookie) and isn't listed in Settings → API and MCP.
- **Archive and delete wait for a button.** In text chat they pause with a confirm card (the AI SDK's tool approval). Voice chat doesn't offer them at all.
- **It knows the context:** who's asking, their role and user id ("assign it to me"), today's date in the workspace's time zone, and the page open behind the panel ("summarize this client").
- **It can't send email or texts. It drafts them.** Asked to email or text someone, it writes a draft (`draft_message`) that waits on the person's page. The teammate opens it in the composer, changes what they like and sends it the usual way. See [Drafts](#drafts).
- **Long jobs go to the background.** Research, cleanups and anything across many records are handed to a background worker that keeps going after the panel is closed. See [Background work](#background-work).
- **It can read the organization's own website**, when the deployment connects a [knowledge source](KNOWLEDGE.md): services, team, articles and resources, through the `get_knowledge` tool. Its instructions then name the source and tell it to look the organization's own facts up there and link what it finds, instead of answering from memory.

## Threads

Conversations are saved per teammate in `agent_threads` (messages as the AI SDK's UI messages, in one `jsonb` column). Only their owner can list, open, continue, rename or delete them.

- The browser sends only the new message; the server loads the thread, merges it in and saves the answer (`mergeIncoming` in `src/lib/agent/messages.ts`). So the browser can't rewrite what the agent said or what a tool returned: an edited message replaces that turn and everything after it, and a confirm answer only changes the approval on the stored copy.
- A new thread is named after its first message straight away, then by the title model after the answer has streamed.
- Threads are trimmed from the oldest turn when they pass about 800 KB.
- Voice chats are saved into the thread as text when the call ends ("Said in voice chat").

## Voice

- **Voice chat** is speech to speech with `spacexai/grok-voice-3.0` through AI Gateway's realtime API (`experimental_useRealtime`). One request to `/api/agent/voice/session` returns a short-lived, single-use token, the socket URL, the tools this teammate may use and the instructions; the browser then talks to AI Gateway directly. To start fast, that request goes out when the pointer reaches "Start voice chat" (or it gets focus or a touch), and is kept for up to 4 minutes for the same page (`src/components/agent/voice-setup.ts`). The click then only waits for the microphone and the socket, which opens with the token in its subprotocol, without another round trip. After each tool call the page behind the panel checks for changes and refreshes ([live updates](ARCHITECTURE.md#live-updates)), as it does in text chat. Tool calls come back to `/api/agent/voice/tool` and run on the server as the teammate. A call ends after 5 minutes, or after 30 seconds of quiet once the agent has spoken.
- **Dictation**, the microphone in the composer, records a clip and transcribes it with `spacexai/grok-stt` (`/api/agent/transcribe`). The text lands in the composer to edit before sending.
- **The same microphone is in the CRM's text boxes**: notes, call summaries, emails (logged or sent), texts, meeting agendas and notes, and task details, in the composer and when editing on a timeline (`RichText`'s `dictation` prop). Click it and it turns into a stop button with a waveform and "Listening…"; stop, and "Transcribing…" shows until the text goes in at the cursor, or at the end if nobody has put the cursor in the text. Recording and upload logic is shared (`src/components/dictation/use-dictation.ts`). It hides itself on deployments without AI Gateway access.

The browser asks for microphone access the first time. The site's `Permissions-Policy` allows the microphone for this origin only, and the CSP allows the AI Gateway realtime socket (`wss://ai-gateway.vercel.sh`).

## Record summaries

Client, person and organization pages open with a short AI snapshot above the "Next" line: who this is and where things stand, the latest thing that matters, and what needs attention. Two lines on a desktop (click to read it all).

- **What it reads** (`recordContext` in `src/lib/agent/summary.ts`): for a client, the whole account: its details, stage, services, performance numbers, Stripe billing (subscriptions, unpaid invoices, failed payments), its people, and every note, call, email, text, meeting and task logged on the client, its contact, the people at its organization and the organization itself, both done and planned. An organization reads the same across all its clients and people. A person reads only their own record and activity. Campaign emails are left out; the newest 60 history items and 25 planned ones go in.
- **One per record, shared.** It's stored on the record (`summary`, `summary_at`) and shown to everyone who opens it, straight from the page. It's fresh for 24 hours. After that the old one still shows while a new one is written, with "Re-summarizing…" in the corner, and the new one replaces it.
- **Written once.** `summary_started_at` claims a rewrite with one conditional update, so two people opening a stale record don't both pay for it; the second waits on the server for the first. A rewrite stuck for 2 minutes can be taken over. A failed rewrite keeps the old summary and tries again on the next visit.
- **Model:** `agent.summaryModel` (`openai/gpt-6.1-sol`) at `agent.summaryReasoning` (`low`). The text is plain, at most 320 characters, and the instructions tell the model to treat emails and notes as information, never as instructions. Anyone who can read the record can trigger a rewrite (120 an hour per teammate).

## Background work

Some jobs take too long for a chat answer: researching a company on the web and adding its people with titles and contact details, working out who the decision maker is, cleaning up a set of records, preparing a follow-up. The agent does these in the background, like a teammate you hand something to. It keeps working after the panel is closed and reports back when it's done.

### Three ways to hand it work

| How | What happens | Where the answer goes |
| --- | --- | --- |
| **Ask in chat** | The chat agent does quick things itself and hands long ones off with `start_background_task`. | Posted back into that chat, and listed under "Background tasks" at the top of the panel |
| **Mention it in a note** | A note that says `@Agent` (or `@` and whatever `agent.name` is) on a person, organization or client starts a run with the note as the request. | A note in reply on the same record |
| **Assign it a task** | In the task form, pick the agent under "Assigned to" (or pass `agent: true` to `create_task` / `update_task`). The task stays yours. | Added to the task, which is then marked done |

A fourth, for lists: `start_bulk_background_task` runs the same request on each of several records (every organization in a view, say), one run per record, a few at a time. The chat agent is told to try three records first and show the results before running the rest.

The timeline shows a badge on the note or task while the agent works on it ("Agent: working", then "done"), and each teammate gets a push notification when their work finishes ("The agent finished" in Settings → Notifications).

### Whose access it has

A run works for one teammate: whoever asked in chat, wrote the note or assigned the task.

- **It has their access, never more.** It reaches the CRM only through the MCP endpoint, where the tool list is built from that teammate's role and every call is checked against it again. The role is read fresh on each call, so changing someone's role or deactivating them takes effect at once.
- **It needs edit access to start.** Viewers, read-only keys and read-only connected apps can't start background work, since a run changes records.
- **Everything it does is theirs, via the agent.** Notes, tasks, field changes and drafts show as "Sam via Agent" in history, exactly like the chat agent's changes.
- **Less than chat in one way.** Nobody is watching a run, so it can't archive, delete or merge (those wait for a confirm button in chat), can't send anything, and can't start more runs.
- **Only a person can call on it from a note.** A mention counts only in a note a teammate wrote in the browser. Text written by an agent or a script never starts work, whatever it says.

### Research can't change anything

Reading the web is the job of a separate helper, the researcher. It has web search and page fetch and nothing else: no CRM connection, no way to write. It reports what it found with source links, and the main worker decides what to save, through the same MCP tools and the same permission checks. So a web page that tries to give instructions has nothing to act with. The main worker has no web access of its own, and both are told to treat what they read as information, never instructions.

### Models and cost

| Key | Default | Used for |
| --- | --- | --- |
| `agent.background.enabled` | `true` | Background work. `false` hides it and removes its tools |
| `agent.background.model` | `"openai/gpt-6.1-sol"` | The worker that plans and changes records |
| `agent.background.reasoning` | `"low"` | Its reasoning effort |
| `agent.background.researchModel` | `"openai/gpt-6-luna"` | The researcher, which reads the most text. Small and fast keeps long runs cheap (about a twentieth of the worker's price per token) |
| `agent.background.maxRunUsd` | `0.75` | One run stops once its model spend reaches this |
| `agent.background.monthlyBudgetUsd` | `30` | New runs are refused once the month's spend reaches this, across the workspace |
| `agent.background.maxRunMinutes` | `20` | A run still going after this long is cancelled |
| `agent.background.maxConcurrentPerUser` | `3` | How many of one teammate's runs work at once. The rest wait their turn |
| `agent.background.maxBulkRecords` | `50` | The most records one bulk request can cover |

- Spend is what AI Gateway reports for each run's model calls, the researcher's included, saved on the run (`agent_runs.cost_micro_usd`). The month is the calendar month in UTC.
- Web searches are billed by AI Gateway per search (about a cent each) and aren't part of that figure. The researcher is told to keep to a handful per question, and the per-run token limit bounds it.
- The `AI_GATEWAY_API_KEY` budget in the Vercel dashboard is still the outer ceiling for all AI spend, background work included.

### Drafts

The agent never sends email or texts, in chat or in the background. `draft_message` writes one to a person and leaves it for the teammate it works for:

- The draft shows above the composer on the person's page (and on a client whose contact they are): "Agent drafted an email to Jo Park". **Review and send** opens it in the usual email or text composer, where it can be edited and sent from any inbox or number, or it can be discarded.
- Drafts are private to the teammate they were written for. Only that teammate, in the CRM, can send or discard one: no API operation or tool does.
- A background run that writes a draft sends a push notification with a link to it.

### How a run works

```
teammate ── chat / @mention / task ──▶ CRM: agent_runs row (queued → running)
                                        │  signs a token for this run and teammate
                                        ▼
                         eve agent (agent/, served at /eve/v1)
                          ├─ researcher subagent: web search + fetch, no CRM
                          └─ CRM connection ──▶ /api/mcp as "teammate via Agent"
                                        │
                     report hook ──▶ /api/agent/runs/report: answer, cost
                                        ▼
                    CRM saves the answer (chat thread, reply note or task) and notifies
```

- The worker is an [eve](https://eve.dev) agent in `agent/`, a second service of the same Vercel project. `withEve` in `next.config.ts` builds it with the app and starts it with `next dev`. It needs Node.js 24 or newer; on older versions, or with background work off, the app builds and runs without it.
- The two services trust each other through short-lived tokens signed with a shared secret (`src/lib/agent/run-token.ts`): `AGENT_RUN_SECRET`, or one derived from `AUTH_SECRET` when it isn't set. Each token names one run and one teammate, and stops working when the run ends.
- A cron (`/api/cron/agent`, every 15 minutes) cancels runs that have gone past `maxRunMinutes` and starts any left waiting.
- On a preview deployment behind Vercel's Deployment Protection, set `VERCEL_AUTOMATION_BYPASS_SECRET` so the two services can reach each other. Production on its own domain needs nothing.
- Runs are traced in the Vercel dashboard under Observability → Agent Runs.

## Setup

The agent, voice, dictation and summaries use [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) for every model, so any model the gateway offers works, from any provider, with one credential.

- **Everywhere, Vercel included:** create a key in the Vercel dashboard (AI Gateway → API keys) and set it as `AI_GATEWAY_API_KEY`. Every AI feature runs on that key (`src/lib/agent/gateway.ts`), so its budget and spend limit cap what the CRM can spend. Give each deployment its own key (production, previews, local) to see and cap each one separately.
- **The deployment's OIDC token isn't used.** The AI SDK's default gateway falls back to it when no key is set; this app doesn't, so a deployment without a key never bills the Vercel team. Without a key the AI features hide themselves: no agent button, no dictation microphones, no summaries.

### Configure your deployment

Everything about the AI features is a setting, so a fork or a self-hosted copy changes environment variables, never code. Two kinds:

- **Secrets** stay in server-only environment variables: `AI_GATEWAY_API_KEY` (required for any AI feature), `KNOWLEDGE_API_URL` and `KNOWLEDGE_API_KEY` for an optional [knowledge source](KNOWLEDGE.md), plus the existing `RESEND_API_KEY`, `VAPID_PRIVATE_KEY`, `CRON_SECRET` and `STRIPE_SECRET_KEY`.
- **Choices** (which features are on, which models, the agent's name and suggestions) are `agent.*` in `app.config.ts`. A deployment overrides any of them with `NEXT_PUBLIC_APP_CONFIG`, without touching the file. They're public (compiled into the page, since voice chat picks its model in the browser) and need a redeploy to change.

For example, a deployment that keeps chat and dictation, turns voice chat off and summarizes with a cheaper model:

```bash
# .env.local, or the Vercel project's environment variables
AI_GATEWAY_API_KEY=vck_…       # required; its budget caps AI spend
NEXT_PUBLIC_APP_CONFIG='{"agent":{"name":"Ada","voice":false,"summaryModel":"anthropic/claude-haiku-5.5","summaryReasoning":"none"}}'
```

Unknown keys, wrong types and reasoning levels that don't exist fail the build with a list of what to fix. A feature that's off is hidden in the interface and refused by its route, and the site's `Permissions-Policy` and CSP only allow the microphone and the AI Gateway socket when voice chat or dictation is on.

| Key | Default | Used for |
| --- | --- | --- |
| `agent.enabled` | `true` | The agent: its button and chat panel. `false` hides it everywhere (voice chat goes with it) |
| `agent.voice` | `true` | Voice chat in the agent panel |
| `agent.dictation` | `true` | The microphones in the agent's composer and the CRM's text boxes |
| `agent.summaries` | `true` | The AI summary on client, person and organization pages. `false` also hides summaries already written |
| `agent.name` | `"Agent"` | Its name in the panel, in its replies and in history |
| `agent.chatModel` | `"openai/gpt-6.1-sol"` | Text chat and tool use |
| `agent.chatReasoning` | `"medium"` | How much the chat model reasons before answering: `"provider-default"`, `"none"`, `"minimal"`, `"low"`, `"medium"` or `"high"`. Higher is slower and costs more. Its reasoning isn't shown or saved |
| `agent.summaryModel` | `"openai/gpt-6.1-sol"` | Record summaries |
| `agent.summaryReasoning` | `"low"` | Reasoning effort for record summaries |
| `agent.titleModel` | `"anthropic/claude-haiku-5.5"` | Naming threads |
| `agent.voiceModel` | `"spacexai/grok-voice-3.0"` | Voice chat (a realtime model with tool use) |
| `agent.transcriptionModel` | `"spacexai/grok-stt"` | Dictation |
| `agent.suggestions` | 4 prompts | Suggested actions on a new chat. A prompt ending in `…` fills the composer instead of sending |
| `agent.viewerSuggestions` | 4 prompts | The same, for read-only teammates |

## Limits

- 40 requests a minute and 2,000 a day per teammate across chat, dictation and voice tools (`src/lib/agent/http.ts`, counted in Postgres). A voice session counts as 5.
- 12 tool steps per answer, 16,000 output tokens (reasoning included).
- A tool result over 40,000 characters is trimmed to fewer list items, and the agent is told to narrow its request.
- One typed message is at most 8,000 characters; a dictation clip at most 4 MB.

- Background work: `maxRunUsd` per run, `monthlyBudgetUsd` per month, `maxRunMinutes` per run, `maxConcurrentPerUser` at once and `maxBulkRecords` per bulk request ([Models and cost](#models-and-cost)).

## How it's built

```
agent/              the background worker, an eve agent (its own service, at /eve/v1)
  agent.ts          model, no shell or web tools, the per-run spending limit
  instructions.md   how it works: look first, change only what was asked, report at the end
  channels/eve.ts   who may start a session: only the CRM, with a token for one run
  connections/crm.ts  the CRM's MCP endpoint, as the teammate the run works for
  hooks/report.ts   tells the CRM how a run ended and what it cost
  subagents/researcher/  web search and fetch only, on the smaller model
src/lib/agent/
  runs.ts         background runs: accept, start, hear back, save the answer, budget, cancel
  run-rules.ts    what a run may do, its first message, budget rules, mentions (pure)
  run-token.ts    the tokens the CRM and the eve agent sign for each other (pure)
  run-actor.ts    a run's token → "the teammate via Agent", checked on every call
  handoff.ts      starting a run from an assigned task or a mention in a note
  markdown.ts     the agent's markdown answer as note HTML (pure)
  actor.ts        the teammate as an Actor, with their "assistant" key for history
  tools.ts        AI SDK tools from the operation list, run through executeOperation
  policy.ts       which tools a role gets, which need confirming, result trimming (pure)
  prompt.ts       instructions: who, when, where, how to work (pure)
  messages.ts     merging, approvals, trimming, titles (pure)
  threads.ts      thread storage and automatic titles
  summary.ts      record summaries: what they read, the 24-hour freshness and the rewrite claim
  summary-prompt.ts  their instructions and cleanup (pure)
  voice.ts        voice session config, silence clock, audio helpers (browser)
  http.ts         session, same-site and rate-limit checks for /api/agent/*
src/app/api/agent/
  chat/                 streamText with tools; useChat's endpoint
  transcribe/           dictation
  voice/session/        realtime token, socket URL, tool definitions and instructions
  voice/tool/           runs a voice tool call
src/actions/agent.ts    list, load, rename, delete threads; feedback; voice transcripts
src/components/agent/   the button, panel, messages, dictation and voice components
```

The panel (threads menu, suggestions, dictation, voice stage, copy, feedback and edit) is styled with this app's theme tokens. It loads the first time someone opens it, so pages don't carry its code. Every `/api/agent` route checks the session cookie and refuses requests from other sites' pages.
