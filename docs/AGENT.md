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
- **Archive, delete and merge wait for a button,** and so does saving a [skill](#skills) or a [scheduled job](#scheduled-jobs). In text chat they pause with a confirm card (the AI SDK's tool approval). Voice chat doesn't offer them at all.
- **It knows the context:** who's asking, their role and user id ("assign it to me"), today's date in the workspace's time zone, and the page open behind the panel ("summarize this client").
- **It can't send email or texts. It drafts them.** Asked to email or text someone, it writes a draft (`draft_message`) that waits on the person's page. The teammate opens it in the composer, changes what they like and sends it the usual way. See [Drafts](#drafts).
- **Long jobs go to the background.** Research, cleanups and anything across many records are handed to a background worker that keeps going after the panel is closed. See [Background work](#background-work).
- **It answers briefly.** Teammates often read its answers between other things, or through another agent, so its instructions ask for the answer first, in a few sentences: the facts that matter to the question, never a whole timeline or every field of a record. It goes long when asked to, and it doesn't drop anything the teammate needs to act on. The background worker's report and the MCP server's instructions say the same. See [Answer length](#answer-length).
- **It reads files you attach.** Spreadsheets, Word documents and text files, to add or update people, organizations and clients from. See [Attachments](#attachments).
- **It follows skills and runs scheduled jobs.** Instructions saved for it, and work it does on a cadence, per teammate and shared by admins. See [Skills](#skills) and [Scheduled jobs](#scheduled-jobs).
- **It can read the organization's own website**, when the deployment connects a [knowledge source](KNOWLEDGE.md): services, team, articles and resources, through the `get_knowledge` tool. Its instructions then name the source and tell it to look the organization's own facts up there and link what it finds, instead of answering from memory.

## Answer length

The agent is told to be direct in all three places it writes:

- **Chat** (`agentInstructions` in `src/lib/agent/prompt.ts`): answer what was asked first; one to three sentences or up to five bullets is the normal size; give the names, dates, amounts and next step that matter and leave out the rest; no preamble, recap, closing offer or account of the steps it took. "Everything", "the full history" or "in detail" gets the long version.
- **Background work** (`agent/instructions.md`): the report starts with the outcome, then one line per record changed, then what's left for the teammate. No log of what it searched or read.
- **MCP** (`src/lib/mcp/server.ts`): the server's instructions ask connected agents to report back in a few sentences and to ask for only what they need (`limit`, the list filters). The timeline tools' description suggests 5 to 10 entries unless the whole history is needed.

Nothing is cut from tool results: an agent that needs the full timeline still gets it by asking.

## Attachments

The paperclip in the composer (or dropping a file on it) attaches up to 3 files to a message.

| | |
| --- | --- |
| What can be attached | CSV and TSV, Excel (`.xlsx`), Word (`.docx`), and text (`.txt`, `.md`, `.json`) |
| What can't | Anything else. Older Office files (`.xls`, `.doc`), files with macros (`.xlsm`, `.docm`) and PDFs get a sentence saying what to do instead |
| Size | 5 MB per file. The agent gets up to 40,000 characters of each; a longer file is cut at a line and marked, and the agent says so |

- **The file never leaves the browser.** It's read there (`src/components/agent/read-attachment.ts`) and only its text is sent: a spreadsheet as CSV, a Word document's body as plain text (`src/lib/agent/docx.ts` opens only `word/document.xml` and caps its size as it inflates). Nothing that can run (a macro, a script, an embedded object) is uploaded, stored or opened.
- **The server checks it again** (`cleanAttachments` in `src/lib/agent/attachments.ts`): allowed extensions only, names and text cleaned of control characters and capped.
- **The text is data.** It rides on the teammate's message (`metadata.files`) and reaches the model after that message inside `<file>` tags, marked as data from the teammate, not instructions. The panel shows a file as a chip with its name; the text isn't sent back to the browser when a thread is reopened. Editing a message keeps its files.
- **What it does with a spreadsheet:** reads the headings, matches columns to fields, searches before creating so nothing is added twice, and for more than about 20 rows says what it will do and waits for a yes. For a long list of people it points to People › Import, which handles a whole file with column mapping and undo.
- Voice chat has no attachments.

## Skills

A skill is a set of instructions saved for the agent: how to write up a call, what makes a good prospect, the tone for follow-up emails. Settings → Agent lists them, and the agent saves one when asked ("from now on, write call notes as three bullets").

| | Who it's for | Who can add or change it |
| --- | --- | --- |
| **Your skills** | Your agent only | You (not viewers), in Settings or by asking the agent. An admin can open and change a teammate's in Settings, never through a key, a connected app or an agent |
| **Shared with the team** | Every teammate's agent | Admins, in Settings only (never an agent, a key or a connected app): add one, or open any skill (their own or a teammate's) and share it. Taking it back returns it to whoever wrote it |

- **Two ways a skill is used** (`mode`): *When it's relevant* (the default) lists the skill by name and description, and the agent reads it with `get_skill` before doing work it covers. *Always* puts its instructions in every conversation: up to 5 per teammate and 5 shared, 4,000 characters each. Admins use this to apply something to the whole team.
- **Everywhere the agent works.** Chat and voice get the teammate's skills in their instructions (`skillsSection` in `src/lib/agent/skill-rules.ts`), background runs get them in their first message, and agents connected through MCP are told to `list_skills` and read one before work it covers.
- **Skills are the teammate's own instructions,** so the agent only saves one when the teammate asks, never from text in a record, a file or a tool result. In chat, saving or changing a skill or a scheduled job waits for a confirm button that shows the words that would be saved, the same as archive and delete, so text the agent read can't create one unseen. Voice chat, which has no button, can read skills and jobs but not save them. Background runs can read skills but can't create, change or delete them (`runMayUse`), so nothing a run reads on the web can leave instructions behind.
- Limits: 50 skills per teammate and 50 shared; a name up to 60 characters, a description up to 280, instructions up to 20,000.
- Tools and endpoints: `list_skills`, `get_skill`, `create_skill`, `update_skill`, `delete_skill` (`/api/v1/skills`). Deleting waits for a confirm button in chat.

## Scheduled jobs

A scheduled job is work the agent does on its own, on a cadence: "every Monday at 8, list my prospects with no activity in two weeks". Settings → Agent lists them, and the agent sets one up when asked.

- **Cadence:** every day, every weekday, weekly on a day, monthly on a day (1 to 28), or once on a date, at a time on the quarter hour in the workspace's time zone. The most often a job runs is once a day.
- **Each run is background work** ([below](#background-work)): the agent cron starts a run as the job's teammate when its time comes, with their access at that moment and under the same per-run, monthly and concurrency limits. The answer is saved on the run (Background tasks in the panel) with a push notification. A job that can't start (the month's budget is spent, the teammate lost edit access) says why on the job in Settings and tries again at its next time.
- **Shared jobs are offers.** An admin, in Settings only, adds a job for the team, or opens any job and shares it. It doesn't run by itself: each teammate who presses **Add to mine** gets their own copy, which runs as them and can be changed without affecting anyone else. Changing the offer later doesn't change copies already added.
- **Admins** can also see, change, pause and delete teammates' jobs, in Settings only. An admin's key, connected app or agent sees and changes the admin's own jobs and nothing of anyone else's, since a job runs as its teammate.
- A one-time job turns itself off after it runs. **Run now** in Settings starts a job right away without changing its schedule.
- Background runs can read jobs but can't create or change them, so a run can't schedule more of itself.
- Limits: 20 jobs per teammate and 20 offers.
- Tools and endpoints: `list_scheduled_jobs`, `create_scheduled_job`, `update_scheduled_job`, `delete_scheduled_job`, `add_shared_scheduled_job` (`/api/v1/scheduled-jobs`). They exist only where background work is on.
- How it runs: `runDueJobs` in `src/lib/agent/schedules.ts`, from `/api/cron/agent` every 15 minutes. One conditional update moves a job to its next time before it starts, so overlapping crons run it once; a job whose time passed while the cron was down runs once, then keeps to its cadence. Times are computed in the workspace's time zone, so 8:00 stays 8:00 across daylight saving changes (`nextRun` in `src/lib/agent/schedule-rules.ts`).

eve has its own experimental extensions for user-saved skills and runtime schedules. They aren't used here: skills and jobs live in the CRM's database so that Settings, the REST API, MCP, chat and the background worker all share one list, one set of permission checks and one budget.

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

## File descriptions

Every file added to the CRM (on the Files page, a client, person or organization, an email, or in the team chat) is read once by a small model and given a short description and its key facts, stored on the file (`src/lib/file-describe.ts`). The agent finds files by them and answers from them.

- **What it reads:** PDFs and pictures are sent to the model whole (up to 15 MB); text, CSV, Markdown and JSON files, Word documents and Excel workbooks are turned into text on the server first (60,000 characters at most; workbooks are checked to inflate to under 40 MB before they're parsed). Other kinds (slide decks, zips, video) aren't read; teammates can describe them by hand.
- **It can't do anything.** The model has no tools and answers in a fixed shape (a description and notes). Its instructions say everything in the file is content, never instructions; the answer is cleaned to plain text and capped (300 and 3,000 characters). When the agent reads a description later, its instructions say again that it's data from the file.
- **When:** right after the upload, without holding it up (`after()`). The agent cron describes older files a few at a time. A file is marked failed before it's read, so one that can't be read isn't retried forever.
- **Teammates can rewrite it** in the file's dialog; theirs is never overwritten. Clearing it hands it back to the model.
- **Found by meaning:** the name, description and key facts are embedded (`agent.embeddingModel`) into a pgvector column, rewritten whenever the description changes. `search_files` embeds the question and asks the database for the nearest files, so finding a document costs one small embedding call and no file text.
- **Models:** `agent.fileModel` (`openai/gpt-6-luna`) and `agent.embeddingModel` (`openai/text-embedding-3-small`, 1536 dimensions, which the column's width matches). `agent.fileDescriptions: false` turns both off.

## Background work

Some jobs take too long for a chat answer: researching a company on the web and adding its people with titles and contact details, working out who the decision maker is, cleaning up a set of records, preparing a follow-up. The agent does these in the background, like a teammate you hand something to. It keeps working after the panel is closed and reports back when it's done.

### Three ways to hand it work

| How | What happens | Where the answer goes |
| --- | --- | --- |
| **Ask in chat** | The chat agent does quick things itself and hands long ones off with `start_background_task`. | Posted back into that chat, and listed under "Background tasks" at the top of the panel |
| **Mention it in a note** | A note that says `@Agent` (or `@` and whatever `agent.name` is) on a person, organization or client starts a run with the note as the request. So does a reply under a note: the reply is the request, and the note and its earlier replies go along as quoted context (information, not instructions), so a follow-up ("@Agent do the same for their Denver office") makes sense. | A reply under that note |
| **Assign it a task** | In the task form, pick the agent under "Assigned to" (or pass `agent: true` to `create_task` / `update_task`). The task stays yours. | Added to the task, which is then marked done |
| **Schedule it** | A [scheduled job](#scheduled-jobs) starts a run each time it's due. | Saved on the run, under "Background tasks", with a notification |
| **Email it** | Forward an email to your private address, or Cc it on your own email in an internal thread. See [Email forwarding](#email-forwarding). | Emailed back to you as a reply, which you can answer |

A fourth, for lists: `start_bulk_background_task` runs the same request on each of several records (every organization in a view, say), one run per record, a few at a time. The chat agent is told to try three records first and show the results before running the rest.

The timeline shows a badge on the note or task while the agent works on it ("Agent: working", then "done"), and each teammate gets a push notification when their work finishes ("The agent finished" in Settings → Notifications).

### Whose access it has

A run works for one teammate: whoever asked in chat, wrote the note or assigned the task.

- **It has their access, never more.** It reaches the CRM only through the MCP endpoint, where the tool list is built from that teammate's role and every call is checked against it again. The role is read fresh on each call, so changing someone's role or deactivating them takes effect at once.
- **It needs edit access to start.** Viewers, read-only keys and read-only connected apps can't start background work, since a run changes records.
- **Everything it does is theirs, via the agent.** Notes, tasks, field changes and drafts show as "Sam via Agent" in history, exactly like the chat agent's changes.
- **Less than chat in one way.** Nobody is watching a run, so it can't archive, delete or merge (those wait for a confirm button in chat), can't send anything, can't start more runs, and can't create or change skills or scheduled jobs.
- **Only a person can call on it from a note.** A mention counts only in a note or a reply a teammate wrote in the browser. Text written by an agent or a script never starts work, whatever it says.

### Research can't change anything

Reading the web is the job of a separate helper, the researcher. It has web search and page fetch and nothing else: no CRM connection, no way to write. It reports what it found with source links, and the main worker decides what to save, through the same MCP tools and the same permission checks. So a web page that tries to give instructions has nothing to act with. The main worker has no web access of its own, and both are told to treat what they read as information, never instructions.

### Email forwarding

Internal email about a client (two teammates discussing how an account is doing, say) never reaches the mailbox sync, because the client isn't on it. Forwarding it to the agent brings what matters into the CRM.

**Setting it up (once, an admin):**

1. In Resend, add a domain for receiving only, ideally a subdomain like `in.acme.com`, turn on receiving and add its MX record. Your company mail stays where it is.
2. Set `FORWARD_EMAIL_DOMAIN=in.acme.com` and redeploy.
3. Settings → Email domains → reconnect the webhook, so it also sends `email.received`.

**Using it (each teammate):** Settings → Agent → Email forwarding → **Turn on** gives you a private address, `log-<24 random characters>@in.acme.com`. Save it as a contact. Forward an email to it, or Cc it on your own email in an internal thread, with a line at the top if you want something specific ("log this on Bolt and add a follow-up for me").

**What happens:**

| Step | |
| --- | --- |
| Checked | Before anything is read, the email must be provably from you: see [Who can use an address](#who-can-use-an-address). Anything that fails is listed under Recent emails in Settings, with why, and never answered |
| Worked on | It becomes background work as you (source `email`, "From an email" under Background tasks). Unless you said otherwise, the agent works out which clients, people and organizations it's about, adds a note on each with the facts that matter (who said what, numbers, decisions, concerns, dated), logs performance numbers as client metrics, turns agreed follow-ups into tasks, and changes a field only when the email states the new value. History shows "Sam via Agent" |
| Answered | The CRM emails the agent's answer back to you, threaded under your email, with links to each record it changed |
| Unsure? | The agent saves what it's sure of and ends with one short question ("Bolt Denver or Bolt Austin?"). Reply to its email to answer. The reply address carries the conversation, so the next round gets the earlier emails and answers, and the agent adds only what's new. A conversation goes back and forth up to `agent.forwarding.maxRounds` (8) times |

What it reads: the email's text (the plain-text part, or the HTML as text), up to `agent.forwarding.maxChars` (40,000 characters), with the newest email kept whole and earlier rounds shortened to fit. Replies are read without the quoted email below them. Attachments aren't read; forward a file to a record from the Files page instead.

#### Who can use an address

Three things must all hold, checked in this order (`processForward` in `src/lib/forwarding/inbound.ts`, rules in `src/lib/forwarding/rules.ts` and `dkim.ts`):

1. **The address.** The 24 random characters (120 bits) name one teammate. **New address** replaces it at once (and stops replies to earlier emails); **Turn off** stops it. Deactivated teammates' addresses stop working.
2. **The From line** names exactly one address, and it's that teammate's sign-in email. A teammate's reply-all to your Cc'd address is ignored; forward the thread instead.
3. **The sender's domain signed it.** The CRM downloads the raw message from Resend and checks its DKIM signatures itself, looking the key up in DNS (rsa-sha256 and ed25519-sha256; signatures over part of the body, `l=`, are refused). One must come from the From domain or a domain aligned with it. Microsoft 365 and Google Workspace sign with your domain once DKIM is turned on for it; Settings shows which signatures were found when an email is refused. A receiver's own verdict counts only when the deployment lists it in `FORWARD_AUTHSERV_IDS`: then `dmarc=pass` for the From domain in that receiver's Authentication-Results line is enough. Lines from any other receiver are ignored, since a sender can write their own.

Then: the teammate needs edit access, out-of-office replies and bounces are ignored (so the agent's own replies, marked `Auto-Submitted: auto-replied`, can't start a loop), and each address takes `agent.forwarding.perHour` (20) emails an hour. The webhook's signature is verified and the email is fetched back from Resend by id, so nothing in the webhook's body is trusted.

#### What the agent can do with it

Exactly what any background run can, as you: no archiving, deleting, merging or sending (it writes drafts). The email's content is marked as data from the email, never instructions; only your own words at the top say what to do. The agent's replies go only to you. Forwarded text is kept on `email_forwards` for 30 days (yours alone, in Settings), then cleared; the notes the agent wrote stay. As with any background run, the request (here the email) is also on the run, which you and admins can open.

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
| `agent.forwarding.enabled` | `true` | [Email forwarding](#email-forwarding). Also needs `FORWARD_EMAIL_DOMAIN` |
| `agent.forwarding.perHour` | `20` | The most emails one teammate's address accepts in an hour |
| `agent.forwarding.maxRounds` | `8` | How many times one forwarded conversation can go back and forth |
| `agent.forwarding.maxChars` | `40000` | How much of a conversation the agent reads |

- Spend is what AI Gateway reports for each run's model calls, the researcher's included, saved on the run (`agent_runs.cost_micro_usd`). The month is the calendar month in UTC.
- Web searches are billed by AI Gateway per search (about a cent each) and aren't part of that figure. The researcher is told to keep to a handful per question, and the per-run token limit bounds it.
- The `AI_GATEWAY_API_KEY` budget in the Vercel dashboard is still the outer ceiling for all AI spend, background work included.

### Drafts

A draft email can carry files (`attachmentFileIds`): the agent finds a brochure or price sheet with `search_files` and attaches it, and the composer opens with the files on it.

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
- A cron (`/api/cron/agent`, every 15 minutes) starts scheduled jobs that are due, cancels runs that have gone past `maxRunMinutes` and starts any left waiting.
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
| `agent.fileDescriptions` | `true` | AI descriptions and search vectors for uploaded files. `false` stops writing new ones; search falls back to words |
| `agent.fileModel` | `"openai/gpt-6-luna"` | Reads each uploaded file once and describes it |
| `agent.embeddingModel` | `"openai/text-embedding-3-small"` | File search vectors. It must make 1536-dimension vectors; another width needs a migration |
| `agent.voiceModel` | `"spacexai/grok-voice-3.0"` | Voice chat (a realtime model with tool use) |
| `agent.transcriptionModel` | `"spacexai/grok-stt"` | Dictation |
| `agent.suggestions` | 4 prompts | Suggested actions on a new chat. A prompt ending in `…` fills the composer instead of sending |
| `agent.viewerSuggestions` | 4 prompts | The same, for read-only teammates |

## Limits

- 40 requests a minute and 2,000 a day per teammate across chat, dictation and voice tools (`src/lib/agent/http.ts`, counted in Postgres). A voice session counts as 5.
- 12 tool steps per answer, 16,000 output tokens (reasoning included).
- A tool result over 40,000 characters is trimmed to fewer list items, and the agent is told to narrow its request.
- One typed message is at most 8,000 characters; a dictation clip at most 4 MB.
- Up to 3 attached files per message, 5 MB each, 40,000 characters of text from each ([Attachments](#attachments)).
- Skills and scheduled jobs: 50 skills and 20 jobs per teammate, the same again shared ([Skills](#skills), [Scheduled jobs](#scheduled-jobs)).

- Background work: `maxRunUsd` per run, `monthlyBudgetUsd` per month, `maxRunMinutes` per run, `maxConcurrentPerUser` at once and `maxBulkRecords` per bulk request ([Models and cost](#models-and-cost)).

## How it's built

```
agent/              the background worker, an eve agent (its own service, at /eve/v1)
  agent.ts          model, no shell or web tools, the per-run spending limit
  instructions.md   how it works: look first, change only what was asked, a short report at the end
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
  skills.ts       skills: who sees and changes which, and the ones an agent works with
  skill-rules.ts  their limits, and how they appear in the agent's instructions (pure)
  schedules.ts    scheduled jobs: saving, sharing, and starting the ones that are due
  schedule-rules.ts  their cadence: validation, the next run, the cadence in words (pure)
src/lib/forwarding/
  inbound.ts      email forwarding: the address, receiving, the checks, starting the run, the reply
  rules.ts        the address format, the sender check, auto-reply spotting, what the agent reads (pure)
  dkim.ts         DKIM signature checks from the raw message (pure, apart from the key lookup)
  attachments.ts  files attached in chat: what's allowed, limits, how the model reads them (pure)
  docx.ts         the text of a Word document, without a library (pure)
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
src/actions/agent-settings.ts  Settings → Agent: skills and scheduled jobs
src/components/agent/   the button, panel, messages, attachments, dictation and voice components
src/components/settings/agent.tsx  the skills and scheduled jobs page
```

The panel (threads menu, suggestions, dictation, voice stage, copy, feedback and edit) is styled with this app's theme tokens. It loads the first time someone opens it, so pages don't carry its code. Every `/api/agent` route checks the session cookie and refuses requests from other sites' pages.
