# Knowledge source

A deployment can connect one **knowledge source**: a read-only JSON API about the organization that runs the CRM, usually its own website's content (pages, blog posts, resources, company facts). Once it's connected, the assistant, every teammate's MCP agent and the REST API can look things up there, so answers about "what we offer", "who's on the team" or "what we've written about onboarding" come from the organization's own published material rather than the model's memory.

It's optional and off by default. Nothing in the code is specific to one website: a deployment points it at its own API with environment variables.

## Connect one

Set these on the server (`.env.local`, or the Vercel project's environment variables) and redeploy:

| Variable | Required | What it is |
| --- | --- | --- |
| `KNOWLEDGE_API_URL` | Yes | The API's base URL, like `https://example.com/api/content`. `https://` only (`http://` works for `localhost`). Every request stays under this path: anything else on the same site is out of reach |
| `KNOWLEDGE_API_KEY` | If the API needs one | Sent as `Authorization: Bearer <key>`. Use a **read-only** key. Mark it Sensitive on Vercel |
| `KNOWLEDGE_API_KEY_HEADER` | No | Send the key in another header instead, as is (no `Bearer`), e.g. `X-API-Key` |
| `KNOWLEDGE_NAME` | No | What agents call it, e.g. `Acme website`. Defaults to the URL's host name |
| `KNOWLEDGE_DESCRIPTION` | No | A few sentences for the agents: what the source covers and which paths answer what. This is the most useful setting; see [writing a description](#writing-a-description). Up to 2,000 characters |
| `KNOWLEDGE_FIXED_QUERY` | No | Query parameters the CRM sets on a path, replacing whatever the caller sent, e.g. `/posts?status=live`. Separate several with spaces. See [keeping unpublished content out](#keeping-unpublished-content-out) |
| `KNOWLEDGE_BLOCKED_PATHS` | No | Paths callers can't read, e.g. `/posts/*`. `*` is one segment; a trailing `/*` is everything below. Separate with spaces or commas |

```bash
KNOWLEDGE_API_URL=https://example.com/api/content
KNOWLEDGE_API_KEY=…                 # read-only
KNOWLEDGE_NAME="Acme website"
KNOWLEDGE_DESCRIPTION="Services, team and blog. / lists the endpoints. /pages?path=/about for the team, /posts?q=… to search articles."
```

These are server-only variables: the key never reaches the browser and is never returned in a result or an error. A URL that's set up wrong (not https, a key or query string in it) leaves the source off, logs one warning, and the endpoint's error says what to fix.

## What it adds

| Where | What |
| --- | --- |
| REST API | `GET /api/v1/knowledge?path=<path>` with any API key, the path URL-encoded (`?path=%2Fposts%3Fq%3Donboarding`). Without a source it answers 404 with code `not_configured` |
| MCP | A read-only `get_knowledge` tool, for every role. Its description and the server's instructions name the source and include `KNOWLEDGE_DESCRIPTION`. Not listed when no source is connected |
| The assistant | The same tool, in text and voice chat, and a section in its instructions telling it to look the organization's own facts up there and link what it finds |

The tool takes one argument, `path`: a path under the base with its query string, such as `/`, `/posts?q=onboarding&limit=5` or `/pages?path=/about`. It also accepts the base path repeated (`/api/content/posts`) or a full URL under the base, since APIs often list their own endpoints that way. The result is what the source answered:

```json
{ "data": { "source": "Acme website", "path": "/posts?q=onboarding", "url": "https://example.com/api/content/posts?q=onboarding", "content": { "…": "the source's JSON, as is" } } }
```

## What the source should look like

Any HTTPS API that answers `GET` with JSON (or plain text) works. To work well with agents:

- **Answer `GET <base>` with a list of what it offers** (paths, what each returns, the query parameters). Agents ask for `/` when they don't know where to look.
- **Offer search** (`?q=`), and a way to ask for less (`limit`, a summary view without full text). Answers over 2 MB are refused, and the assistant trims anything over about 40,000 characters.
- **Include a public `url` for each page, post or resource**, so agents can link people to it.
- **Return errors as `{"error": "…"}`** with a 4xx status. The message is passed on (on 400 and 404) so the agent can correct its request.
- **Keep it read-only and public-facing.** Point the base at the content part of the API only. If the same API also has personal data (contacts, leads), give the CRM a key that can't read it, or a base path that excludes it.

## Keeping unpublished content out

Every teammate (viewers too) can read whatever the key can, with any query parameters. If the key also sees drafts or other unpublished content, fence it off with two settings:

- **`KNOWLEDGE_FIXED_QUERY`** pins parameters on a path. `/posts?status=live` makes every request to `/posts` ask for live posts: a caller's own `status` (in any letter case, repeated or percent-encoded) is dropped first. Other parameters pass through.
- **`KNOWLEDGE_BLOCKED_PATHS`** refuses paths outright with a 403, before anything is fetched. Use it for endpoints that return a record of any status by id, like `/posts/*`.

Rules match the path relative to the base, percent-decoded and in lowercase, so `/Posts/x` and `/p%6Fsts/x` are caught by `/posts/*`. They fail closed: while any rule is set, paths must be plain (letters, digits, `-` and `_` between slashes, no file extension), since some servers read `/posts.json` as `/posts`; and a path with fixed parameters only takes plain parameter names, since some read `status[]` as `status`. Anything else is refused with a 400. A key that can't see unpublished content at all is still the stronger option when the source offers one.

Status codes the source returns are passed on as: 400 and 404 with its message; 401 and 403 as a 502 that asks an admin to check the key; 429 and 503 as a 503 to try later; anything else, a timeout (10 seconds) or a redirect as a 502. Redirects aren't followed, so the key can't be carried anywhere else; trailing slashes are dropped from paths because many sites redirect them away.

## Writing a description

The description is how an agent decides when to call the tool and which path to use. Say what's there and where, briefly:

- What it covers: "Acme's services (Plan, Build, Run), team bios, case studies, blog and downloadable guides."
- The paths that matter, with an example query each: "`/site` for contact details and stats; `/pages?path=/about` for the team; `/search?q=…` finds posts by meaning."
- How to keep answers small: "Add `fields=summary` when only titles and links are needed."

## Security

- `KNOWLEDGE_FIXED_QUERY` and `KNOWLEDGE_BLOCKED_PATHS` narrow what the key is used for; see [keeping unpublished content out](#keeping-unpublished-content-out).
- The key is sent only to `KNOWLEDGE_API_URL`'s origin, for paths under its base. Paths with `..`, `;`, encoded slashes, dots or semicolons, backslashes or a different host are refused before anything is fetched.
- Content from the source is published material, but it's still text an agent reads: the assistant's and MCP's instructions say it's data, not instructions.
- Every call counts against the caller's usual limits (300 a minute per API key; the assistant's own limits).

## How it's built

```
src/lib/knowledge/core.ts     config parsing, path guarding, the fetch and error mapping (pure, tested)
src/lib/knowledge/source.ts   reads the environment on the server
src/lib/api/features.ts       which optional features are on; tool descriptions and instructions for this deployment
src/lib/api/operations.ts     getKnowledge (GET /knowledge, tool get_knowledge, feature "knowledge")
```

Operations with a `feature` are documented everywhere but only offered as MCP and assistant tools where the feature is set up (`offered` in `src/lib/mcp/protocol.ts`).

## Examples

- [Recruiting Insight](examples/recruiting-insight.md): the configuration and API reference for one deployment's website. Only relevant to that deployment, but a worked example of a source that fits well.
