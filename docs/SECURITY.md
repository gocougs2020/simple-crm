# Security

The code is public; the data and secrets never are. This page is how that holds.

## Nothing secret is in the repo

- Every secret is an environment variable, documented in `.env.example` with no values. `.env*` files are git-ignored (except the example).
- Production refuses to start on development defaults: without `AUTH_SECRET` or `DATABASE_URL`, the app throws on Vercel instead of using the local secret or the embedded database.
- `.data/` (local database, uploads, dev notes) is git-ignored.
- The brand kit (logo, address, signature) is stored in the database, not in code, so a deployment's branding never lands in the repo.

## Access

- **Every page is behind a login.** `src/proxy.ts` redirects requests without a session cookie before anything renders, and every page, action and route handler checks the session again on the server (`requireUser`, `actionUser`, `getUser`). The proxy is a fast path, not the gate.
- **Invite-only.** The first visitor to a fresh database creates the owner (once: the insert only succeeds when no user exists). After that, admins invite teammates by email.
- **Roles.** Members work every record; viewers can only read them (every action that changes data refuses them on the server). Admins also manage settings and the team. Only owners can make or remove owners, and the last owner can't be demoted. Admin pages 404 for members.
- **API keys.** The REST API and MCP accept only API keys, never the session cookie, so a browser can't be tricked into calling them. Keys are 32 random bytes with a `crm_ws_`/`crm_pk_` prefix (easy for secret scanners to spot); only a SHA-256 hash is stored and the key is shown once. Every request rechecks the key (revoked, expired) and, for personal keys, the teammate (deactivated, current role), so changes take effect at once. Personal keys can never do more than their teammate; workspace keys (full access) are admin-only and refused by MCP. MCP refuses cross-site `Origin` headers. Each key is rate-limited to 300 requests a minute. See [API.md](API.md).
- **Connecting agents (OAuth).** Agents sign in through OAuth 2.1 with PKCE (S256 only). The consent page always shows which app is asking and where it will send the teammate back, and access is capped by their role. Redirect URIs must be https, loopback http, or an app scheme (never `javascript:`, `data:` or `file:`). Every problem with an authorization request is shown on the CRM's own page, never redirected: anyone can register an app, so redirecting errors would make the CRM an open redirector. The app hears back only after the teammate has seen the consent screen. Codes are single-use and expire in 5 minutes; access tokens last an hour; refresh tokens rotate, and a replayed refresh token (including two concurrent uses) disconnects the app, while a replayed code revokes the tokens it was exchanged for. Codes, tokens and client secrets are stored as SHA-256 hashes. Client metadata documents are fetched only for a signed-in teammate on the consent page, only from domain names (never IP literals) that resolve to public addresses, checked inside the connection's own DNS lookup with Node's BlockList (every IPv6 spelling, and ranges that wrap IPv4 blocked whole), so a rebinding hostname can't swap in a private address, without redirects, with a 5-second and 64 KB limit and one generic error for every failure. Registration and token requests are rate-limited by IP.
- **Deactivation** signs a teammate out everywhere immediately and blocks sign-in; their history stays attributed to them.

## Passwords and sessions

- Passwords are hashed with scrypt (N=16384, r=8, p=1, 16-byte salt) from Node's standard library, stored with their parameters so the cost can be raised later. Minimum 10 characters.
- Sign-in gives the same message, and spends the same time hashing, whether or not the email has an account.
- Rate limits (Postgres-backed): 30 sign-in attempts per IP and 10 per email per 15 minutes; 5 reset emails per address and 20 per IP per day.
- Sessions are rows in `sessions`, referenced by an HS256 JWT in an `httpOnly`, `secure`, `sameSite=lax` cookie. Every request checks the row, so sign-out, "Sign out other devices", password changes and deactivation take effect at once.
- Invite and reset links are 32 random bytes, looked up by their SHA-256 hash. Each works once (marked used in a single conditional `UPDATE`), invites expire in 7 days and resets in 1 hour. Reset tokens are never kept. An invite's token is also kept encrypted (`auth_tokens.sealed_token`, AES-256-GCM with the `src/lib/crypto.ts` key) so an admin can copy the link from Settings → Team and send it another way; only `inviteLink` (admins, and only owners for an owner's link) opens it. Someone who hasn't joined can't be made an owner, so a link an admin copied never becomes an owner's. It's cleared when the teammate joins, deleted when a new invite replaces it and pruned once it expires.
- Redirects after sign-in go through `safeRedirect()`, which parses the path the way the browser will and only accepts same-site paths.

## Input and output

- Every server action validates its input with zod and checks the session itself. Every export of a `"use server"` file is a public endpoint, so helpers that shouldn't be callable live in `server-only` modules.
- Rich text (notes, emails) goes through an allow-list sanitizer (`src/lib/safe-html.ts`) before it's stored: a small set of tags, `href` only, and only http(s)/mailto/tel links.
- Security headers on every response: a CSP with `script-src-attr` blocked by default, `frame-ancestors 'self'`, HSTS, `nosniff`, a strict referrer policy, and `X-Robots-Tag: noindex`.

## Files

- Stored in a **private** Vercel Blob store. Browsers upload straight to Blob with a short-lived token issued only to signed-in teammates; downloads stream through `/api/files/[id]`, which checks the session.
- Web pages, SVG, scripts and executables are refused. Downloads are sent with `nosniff` and a `sandbox` CSP, so no uploaded file can run script on the CRM's origin.
- **Internal or public.** Every file starts internal: only signed-in teammates can open it. Making one public (editors, from its menu or dialog) gives it a random 24-byte token, and `/share/<token>` then opens it for anyone with the link, no sign-in. Making it internal again or removing it clears the token, so links already sent stop working at once (the bytes are cached for a minute at most). Share pages are `noindex` and send no referrer, and sharing or unsharing a file that's on a record writes that record's history.
- Only teammates who can edit records upload files, anywhere: Files, a record, an email, the team chat, the REST API and MCP. Viewers can read and post chat messages, but not attach to them. The upload token route, the local upload route, the service (`saveUpload`) and posting a chat message with files each check it.
- **AI descriptions can't act.** The model that describes a file has no tools and answers in a fixed shape; its output is cleaned to plain text and capped. Descriptions, key facts and file text reach the agent marked as data from the file, never instructions. Word and Excel files are read for text only (no macros), workbooks are checked to inflate under a limit before they're parsed, reading both the zip's directory and its entries from the start and refusing archives where they disagree.
- **Uploads through the API and MCP** are base64 in JSON, 3 MB at most, with the same type rules and edit-access check as the browser; only that operation accepts a body over 1 MB, and MCP reads a bigger body only after the key or token is checked.
- The brand kit logo is the other public file (email clients must load it). It's stored privately and served from `/brand/logo/[name]`, which only reads files under `brand/`: admins only, raster images only, 2 MB.

## Email

- Campaign unsubscribe links are signed tokens with a purpose claim. The unsubscribe page needs a click (a POST) so link scanners can't unsubscribe people; mail apps use the RFC 8058 one-click endpoint.
- Campaigns require a postal address (CAN-SPAM) before they can send.
- Cron endpoints require `Authorization: Bearer $CRON_SECRET`, compared in constant time.
- The Resend webhook (`/api/webhooks/resend`) verifies every delivery's signature (Svix) and refuses anything unsigned. It's only a trigger: it re-fetches the thread from Resend with the API key, so a forged payload couldn't inject mail even if a signature check were bypassed. The signing secret is stored in the `workspace` row when an admin connects the webhook (or comes from `RESEND_WEBHOOK_SECRET`) and never reaches the browser.
- Received email is sanitized with the same allow-list as notes before it's stored or shown. Scripts, styles, images and tracking pixels are dropped.
- Managing domains, inboxes and the webhook is admin-only. Every teammate can read and reply to the shared inboxes.

## Microsoft 365

- Each teammate connects only their own account (delegated permissions), through the authorization code flow with PKCE. The state and verifier are in an encrypted, HttpOnly, 10-minute cookie scoped to the callback path and bound to the teammate who started, so a callback can't be replayed or completed in someone else's session.
- Access and refresh tokens are encrypted at rest with AES-256-GCM (`src/lib/crypto.ts`, keyed from `TOKEN_ENCRYPTION_KEY` or `AUTH_SECRET`), never sent to the browser, and only sent to `graph.microsoft.com` (the Graph helper refuses any other host, including in paging links). Disconnecting deletes them at once.
- Mail marked Private, Personal or Confidential in Outlook is never copied, whatever else happens. Every other email is screened by a decision model before it's stored; if the screen can't answer, the email goes in (a deliberate choice: the Outlook label is the guarantee, the screen a second net). Nothing of a kept-out email's content is stored. Copied mail is plain text, sanitized like notes. The email reaches the model as structured fields (state), separate from the question, so its text can't rewrite what's being asked.
- A sensitive email that gets through can be deleted from the records by the teammate whose mailbox it came from, or by an admin. It's gone for everyone, never re-copied, and the history entry doesn't repeat its subject. The same goes for texts and Resend inbox mail (hidden from the shared inbox's conversation too); only admins can delete what someone else sent or logged.
- A connection belongs to its teammate: only they can connect it, change what it's used for or see the list of mail copied from it (Email → My Outlook, scoped to the session's own account). An owner can see that a connection exists and delete it (`disconnectTeammateMicrosoft`, owner role checked on the server), which removes the tokens; no role can read another teammate's mailbox.
- Private synced mail is stored on `synced_emails`, not as an activity, so the shared read paths (timelines, Activities, the REST API, MCP, the agent, summaries) can't return it. The only reads are `copiedMail` and `privateMailOn`, both keyed to the signed-in teammate's own account; sharing, un-sharing and deleting look the row up through that same account, so another teammate's id matches nothing. No role, owner included, can see it.
- What teammates see of each other's calendars is each owner's choice (nothing, free/busy, details); events marked Private always show as busy.

## Phone (Twilio)

- The CRM calls Twilio with a Standard API key, not the account's auth token: the key can be revoked on its own and can't manage the account, subaccounts or keys. The auth token still works, for older deployments, and Settings notes when it's in use.
- Every Twilio webhook verifies `X-Twilio-Signature` (an HMAC compared in constant time) and is refused without it: with the webhook signing key's secret (`TWILIO_WEBHOOK_SECRET`) when Twilio signed with that key, else with the auth token. With neither set, all webhooks are refused. Each is idempotent on Twilio's id.
- Browser call tokens are signed per teammate for an hour, can only place calls (never receive), and only through the CRM's TwiML app. The voice webhook only dials a call that teammate prepared in the last five minutes, after the server checked their access to the number and their role, so a token can't be used to dial arbitrary numbers from arbitrary lines.
- Access to each number is checked on the server for every call, text and campaign. Viewers can't call or text.
- The CRM never lists or touches the Twilio account's other numbers: admins buy numbers by area code, and editing, reconnecting and deleting (releasing) only ever act on numbers in the CRM's own table. Buying and deleting are admin-only.
- TwiML is built with every value escaped, so a caller's number or a typed message can't change what Twilio does. The Twilio API key secret Settings creates (legacy auth-token setup only) is stored encrypted.
- STOP replies opt people out immediately, and text campaigns need recorded consent by default.

## The agent's background work

- A background run acts as one teammate and reaches the CRM only through `/api/mcp`, with a token signed for that run (`src/lib/agent/run-token.ts`, HS256, ten minutes). The CRM checks on every call that the run is still going and the teammate still active, reads their role fresh, and offers only the tools that role allows. Cancelling a run or changing someone's access takes effect at once.
- A run gets less than its teammate, never more: no archive, delete or merge, no starting further runs, and no way to send email or texts (it writes drafts only the teammate can send).
- Starting a run needs edit access. Read-only roles, keys and connected apps can't, and workspace keys can't: a run always belongs to a teammate.
- The agent's own routes (`/eve/v1`) accept only tokens the CRM signed. Browsers never call it.
- Web research is done by a helper with no CRM connection and no write tools. What it reads from the web reaches the worker as text to weigh, and both are told that text from pages, records and messages is never an instruction.
- A note calls on the agent only when a teammate wrote it in the browser. Notes written through a key, a connected app or the agent itself never start work.
- Spend is capped per run, per month and by run time (`agent.background.*`), on top of the AI Gateway key's own budget.

## Email forwarding

- The team shares one address (the agent's name at `FORWARD_EMAIL_DOMAIN`). It isn't a secret: who sent an email decides whose work it is, so that's what is proven. The From line must name exactly one address, an active teammate's sign-in email, and the message must carry a DKIM signature from that domain (or an aligned one) that the CRM verifies itself, from the raw message and the key in DNS. Only the topmost Authentication-Results line (the receiving server's own) counts, and only when it comes from a receiver the deployment lists in `FORWARD_AUTHSERV_IDS` and names the From domain; lines below it may have come with the message. Signatures with `l=` and messages with more than one From line are refused.
- A validly signed email can be sent on unchanged by anyone who received it. So the signature must cover the Date and the Message-ID, each must appear exactly once (the signature covers the last instance, so a second one added on top can't be what's read), the Date must be within `agent.forwarding.maxAgeDays` (3), and an email is read once per sender and Message-ID (a unique index over verified rows only, so a forged copy that arrives first can't take the real one's slot). Forwarding an old thread is unaffected: the forward is a new email.
- The Resend webhook's signature is checked, and the email is fetched back from Resend by id; nothing in the webhook body is trusted. The raw download must be https and at most 30 MB. Mail that doesn't claim to be from a teammate is dropped before anything is fetched or stored.
- Mail that fails a check is never answered, so a forged sender can't make the CRM email anyone. Refusals are listed only for the teammate the mail claimed to be from. Answers go only to the sender's sign-in address, never to the thread.
- The run is ordinary background work as the sender: their role, no archive, delete, merge or sending. The email is marked as data, never instructions. Out-of-office replies and bounces are ignored and the CRM's replies are marked `Auto-Submitted`, so mail can't loop; each teammate can send 20 verified emails an hour, counted only after the checks pass, so forged mail in their name (or anyone's) can't use up an allowance and lock real senders out, and a conversation ends after 8 rounds.
- Forwarded text is private to the sender and cleared after 30 days; rows go after 180.

## Knowledge source

- Optional and read-only: `GET` only, to paths under `KNOWLEDGE_API_URL` (https). Paths that could climb out of the base (`..`, `;`, encoded slashes, dots or semicolons, backslashes, another host) are refused before anything is fetched, and redirects aren't followed, so the key is never sent anywhere else. It's never returned in a result or an error. Use a read-only key, and a base that excludes anything holding personal data. `KNOWLEDGE_FIXED_QUERY` and `KNOWLEDGE_BLOCKED_PATHS` keep unpublished content out when the key can see it; they match the decoded, lowercased path, so case and percent-encoding don't get around them. See [KNOWLEDGE.md](KNOWLEDGE.md).

## Stripe

- Mostly read-only. Everything the CRM shows comes from `GET` requests; the only writes start, change, cancel or un-cancel a subscription, from the client's billing details (`src/actions/billing.ts`). Those are **admins only** (checked on the server with `actionAdmin`, and the controls are hidden from everyone else), check that the subscription's customer is one of the client's, and are written to the client's history. They aren't API operations or MCP tools, so the agent can't change billing. A restricted key with read access per Stripe account is enough to see billing; add write access to Subscriptions only if admins should change billing here. With a read-only key, a change is refused by Stripe and the admin sees that nothing changed. Keys are never sent to the browser, and billing is fetched on the server. Only the fields a page shows reach the browser.
- Customers are matched to clients by email, so anyone who can edit a person's email can change which Stripe customer shows on a client. Billing is visible to everyone who can see the client, the same as before.
- `STRIPE_API_URL` points the client at a local stand-in for tests. It's ignored on Vercel.
