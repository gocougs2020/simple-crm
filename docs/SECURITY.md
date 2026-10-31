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
- **Roles.** Members work every record. Admins also manage settings and the team. Only owners can make or remove owners, and the last owner can't be demoted. Admin pages 404 for members.
- **Deactivation** signs a teammate out everywhere immediately and blocks sign-in; their history stays attributed to them.

## Passwords and sessions

- Passwords are hashed with scrypt (N=16384, r=8, p=1, 16-byte salt) from Node's standard library, stored with their parameters so the cost can be raised later. Minimum 10 characters.
- Sign-in gives the same message, and spends the same time hashing, whether or not the email has an account.
- Rate limits (Postgres-backed): 30 sign-in attempts per IP and 10 per email per 15 minutes; 5 reset emails per address and 20 per IP per day.
- Sessions are rows in `sessions`, referenced by an HS256 JWT in an `httpOnly`, `secure`, `sameSite=lax` cookie. Every request checks the row, so sign-out, "Sign out other devices", password changes and deactivation take effect at once.
- Invite and reset links are 32 random bytes; only their SHA-256 hash is stored. Each works once (marked used in a single conditional `UPDATE`), invites expire in 7 days and resets in 1 hour.
- Redirects after sign-in go through `safeRedirect()`, which parses the path the way the browser will and only accepts same-site paths.

## Input and output

- Every server action validates its input with zod and checks the session itself. Every export of a `"use server"` file is a public endpoint, so helpers that shouldn't be callable live in `server-only` modules.
- Rich text (notes, emails) goes through an allow-list sanitizer (`src/lib/safe-html.ts`) before it's stored: a small set of tags, `href` only, and only http(s)/mailto/tel links.
- Security headers on every response: a CSP with `script-src-attr` blocked by default, `frame-ancestors 'self'`, HSTS, `nosniff`, a strict referrer policy, and `X-Robots-Tag: noindex`.

## Files

- Stored in a **private** Vercel Blob store. Browsers upload straight to Blob with a short-lived token issued only to signed-in teammates; downloads stream through `/api/files/[id]`, which checks the session.
- Web pages, SVG, scripts and executables are refused. Downloads are sent with `nosniff` and a `sandbox` CSP, so no uploaded file can run script on the CRM's origin.
- The brand kit logo is the one public file (email clients must load it): admins only, raster images only, 2 MB.

## Email

- Campaign unsubscribe links are signed tokens with a purpose claim. The unsubscribe page needs a click (a POST) so link scanners can't unsubscribe people; mail apps use the RFC 8058 one-click endpoint.
- Campaigns require a postal address (CAN-SPAM) before they can send.
- Cron endpoints require `Authorization: Bearer $CRON_SECRET`, compared in constant time.
