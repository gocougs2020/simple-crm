# The assistant

Every teammate has an assistant in the bottom right corner of the CRM. It answers questions about clients, people, organizations and tasks, and makes changes for them: log a call, add a task, move a client, update a record. It can also talk, in a live voice conversation or by dictating into the composer.

It works on the teammate's signed-in session. There's no API key to create and nothing to connect: it has exactly the access the teammate has in the browser, through the same operations as the [REST API and MCP](API.md).

## What it can do

| | Owner, admin, member | Viewer |
| --- | --- | --- |
| Look up records, timelines, tasks, pipelines, the team | ✓ | ✓ |
| Create and edit records, log activity, add and complete tasks, move clients | ✓ | |
| Archive records, delete tasks, notes and activity | ✓, after the teammate presses a confirm button | |

- **Tools are the MCP tools.** One per API operation, generated from `src/lib/api/operations.ts` and filtered by role (`allowedOperations` in `src/lib/agent/policy.ts`). Adding an operation with a `tool` name gives the assistant that tool too. Each call runs through `executeOperation`: the permission check, validation and history are the same as for the API.
- **History says who.** Changes show as "Sam via Assistant" on timelines. Each teammate has one `assistant` row in `api_keys` for this: it holds no usable token (the assistant runs on the session cookie) and isn't listed in Settings → API and MCP.
- **Archive and delete wait for a button.** In text chat they pause with a confirm card (the AI SDK's tool approval). Voice chat doesn't offer them at all.
- **It knows the context:** who's asking, their role and user id ("assign it to me"), today's date in the workspace's time zone, and the page open behind the panel ("summarize this client").
- **It can't send email or texts.** It points the teammate to the record's composer instead.

## Threads

Conversations are saved per teammate in `agent_threads` (messages as the AI SDK's UI messages, in one `jsonb` column). Only their owner can list, open, continue, rename or delete them.

- The browser sends only the new message; the server loads the thread, merges it in and saves the answer (`mergeIncoming` in `src/lib/agent/messages.ts`). So the browser can't rewrite what the assistant said or what a tool returned: an edited message replaces that turn and everything after it, and a confirm answer only changes the approval on the stored copy.
- A new thread is named after its first message straight away, then by the title model after the answer has streamed.
- Threads are trimmed from the oldest turn when they pass about 800 KB.
- Voice chats are saved into the thread as text when the call ends ("Said in voice chat").

## Voice

- **Voice chat** is speech to speech with `spacexai/grok-voice-3.0` through AI Gateway's realtime API (`experimental_useRealtime`). The browser gets a short-lived token from `/api/agent/voice/session`, along with the tools this teammate may use, and talks to AI Gateway directly. Tool calls come back to `/api/agent/voice/tool` and run on the server as the teammate. A call ends after 5 minutes, or after 30 seconds of quiet once the assistant has spoken.
- **Dictation**, the microphone in the composer, records a clip and transcribes it with `spacexai/grok-stt` (`/api/agent/transcribe`). The text lands in the composer to edit before sending.
- **The same microphone is in the CRM's text boxes**: notes, call summaries, emails (logged or sent), texts, meeting agendas and notes, and task details, in the composer and when editing on a timeline (`RichText`'s `dictation` prop). Click it and it turns into a stop button with a waveform and "Listening…"; stop, and "Transcribing…" shows until the text goes in at the cursor, or at the end if nobody has put the cursor in the text. Recording and upload logic is shared (`src/components/dictation/use-dictation.ts`). It hides itself on deployments without AI Gateway access.

The browser asks for microphone access the first time. The site's `Permissions-Policy` allows the microphone for this origin only, and the CSP allows the AI Gateway realtime socket (`wss://ai-gateway.vercel.sh`).

## Record summaries

Client, person and organization pages open with a short AI snapshot above the "Next" line: who this is and where things stand, the latest thing that matters, and what needs attention. Two lines on a desktop (click to read it all).

- **What it reads** (`recordContext` in `src/lib/agent/summary.ts`): for a client, the whole account: its details, stage, services, performance numbers, Stripe billing (subscriptions, unpaid invoices, failed payments), its people, and every note, call, email, text, meeting and task logged on the client, its contact, the people at its organization and the organization itself, both done and planned. An organization reads the same across all its clients and people. A person reads only their own record and activity. Campaign emails are left out; the newest 60 history items and 25 planned ones go in.
- **One per record, shared.** It's stored on the record (`summary`, `summary_at`) and shown to everyone who opens it, straight from the page. It's fresh for 24 hours. After that the old one still shows while a new one is written, with "Re-summarizing…" in the corner, and the new one replaces it.
- **Written once.** `summary_started_at` claims a rewrite with one conditional update, so two people opening a stale record don't both pay for it; the second waits on the server for the first. A rewrite stuck for 2 minutes can be taken over. A failed rewrite keeps the old summary and tries again on the next visit.
- **Model:** `agent.summaryModel` (`openai/gpt-6.1-sol`) at `agent.summaryReasoning` (`low`). The text is plain, at most 320 characters, and the instructions tell the model to treat emails and notes as information, never as instructions. Anyone who can read the record can trigger a rewrite (120 an hour per teammate).

## Setup

The assistant, voice, dictation and summaries use [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) for every model, so any model the gateway offers works, from any provider, with one credential.

- **Everywhere, Vercel included:** create a key in the Vercel dashboard (AI Gateway → API keys) and set it as `AI_GATEWAY_API_KEY`. Every AI feature runs on that key (`src/lib/agent/gateway.ts`), so its budget and spend limit cap what the CRM can spend. Give each deployment its own key (production, previews, local) to see and cap each one separately.
- **The deployment's OIDC token isn't used.** The AI SDK's default gateway falls back to it when no key is set; this app doesn't, so a deployment without a key never bills the Vercel team. Without a key the AI features hide themselves: no assistant button, no dictation microphones, no summaries.

### Configure your deployment

Everything about the AI features is a setting, so a fork or a self-hosted copy changes environment variables, never code. Two kinds:

- **Secrets** stay in server-only environment variables: `AI_GATEWAY_API_KEY` (required for any AI feature), plus the existing `RESEND_API_KEY`, `VAPID_PRIVATE_KEY`, `CRON_SECRET` and `STRIPE_SECRET_KEY`.
- **Choices** (which features are on, which models, the assistant's name and suggestions) are `agent.*` in `app.config.ts`. A deployment overrides any of them with `NEXT_PUBLIC_APP_CONFIG`, without touching the file. They're public (compiled into the page, since voice chat picks its model in the browser) and need a redeploy to change.

For example, a deployment that keeps chat and dictation, turns voice chat off and summarizes with a cheaper model:

```bash
# .env.local, or the Vercel project's environment variables
AI_GATEWAY_API_KEY=vck_…       # required; its budget caps AI spend
NEXT_PUBLIC_APP_CONFIG='{"agent":{"name":"Ada","voice":false,"summaryModel":"anthropic/claude-haiku-5.5","summaryReasoning":"none"}}'
```

Unknown keys, wrong types and reasoning levels that don't exist fail the build with a list of what to fix. A feature that's off is hidden in the interface and refused by its route, and the site's `Permissions-Policy` and CSP only allow the microphone and the AI Gateway socket when voice chat or dictation is on.

| Key | Default | Used for |
| --- | --- | --- |
| `agent.enabled` | `true` | The assistant: its button and chat panel. `false` hides it everywhere (voice chat goes with it) |
| `agent.voice` | `true` | Voice chat in the assistant panel |
| `agent.dictation` | `true` | The microphones in the assistant's composer and the CRM's text boxes |
| `agent.summaries` | `true` | The AI summary on client, person and organization pages. `false` also hides summaries already written |
| `agent.name` | `"Assistant"` | Its name in the panel, in its replies and in history |
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
- A tool result over 40,000 characters is trimmed to fewer list items, and the assistant is told to narrow its request.
- One typed message is at most 8,000 characters; a dictation clip at most 4 MB.

## How it's built

```
src/lib/agent/
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
  voice/session/        realtime token + tool definitions
  voice/tool/           runs a voice tool call
src/actions/agent.ts    list, load, rename, delete threads; feedback; voice setup and transcripts
src/components/agent/   the button, panel, messages, dictation and voice components
```

The panel (threads menu, suggestions, dictation, voice stage, copy, feedback and edit) is styled with this app's theme tokens. It loads the first time someone opens it, so pages don't carry its code. Every `/api/agent` route checks the session cookie and refuses requests from other sites' pages.
