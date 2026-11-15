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

The browser asks for microphone access the first time. The site's `Permissions-Policy` allows the microphone for this origin only, and the CSP allows the AI Gateway realtime socket (`wss://ai-gateway.vercel.sh`).

## Setup

The assistant uses [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) for every model.

- **On Vercel:** nothing to configure. Deployments authenticate to AI Gateway with their OIDC token. Usage is billed to the Vercel team; set a budget in the dashboard (AI Gateway → Settings).
- **Locally, or outside Vercel:** create a key in the Vercel dashboard (AI Gateway → API keys) and set `AI_GATEWAY_API_KEY`. Without one, the panel opens with a note that it isn't set up.

Models are settings in `app.config.ts` (or `NEXT_PUBLIC_APP_CONFIG`), so trying another one is a config change:

| Key | Default | Used for |
| --- | --- | --- |
| `agent.enabled` | `true` | Shows the button. `false` hides it everywhere |
| `agent.name` | `"Assistant"` | Its name in the panel, in its replies and in history |
| `agent.chatModel` | `"anthropic/claude-sonnet-5.5"` | Text chat and tool use |
| `agent.titleModel` | `"anthropic/claude-haiku-5.5"` | Naming threads |
| `agent.voiceModel` | `"spacexai/grok-voice-3.0"` | Voice chat (a realtime model with tool use) |
| `agent.transcriptionModel` | `"spacexai/grok-stt"` | Dictation |
| `agent.suggestions` | 4 prompts | Suggested actions on a new chat. A prompt ending in `…` fills the composer instead of sending |
| `agent.viewerSuggestions` | 4 prompts | The same, for read-only teammates |

## Limits

- 40 requests a minute and 2,000 a day per teammate across chat, dictation and voice tools (`src/lib/agent/http.ts`, counted in Postgres). A voice session counts as 5.
- 12 tool steps per answer, 4,000 output tokens.
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

The panel follows the HiringCenter assistant's layout and behavior (threads menu, suggestions, dictation, voice stage, copy, feedback and edit), styled with this app's theme tokens. It loads the first time someone opens it, so pages don't carry its code. Every `/api/agent` route checks the session cookie and refuses requests from other sites' pages.
