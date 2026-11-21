# Deploying to Vercel

## 1. Create the project

Import the repository in Vercel. `vercel.json` sets the build command (`pnpm db:migrate && pnpm build`), so migrations run before every build, and adds three crons: the dispatcher (`/api/cron/tick`, every quarter hour), which asks the database what's due in one query and runs only those jobs (campaigns, the agent, notifications and agenda emails, the inbox sync, Microsoft 365 and a daily prune), the delivery check (hourly) and the Stripe sync (daily at 09:00 UTC). They run on the same quarter-hour blocks (never more often than every 15 minutes), and a quarter hour with nothing to do is one query and no writes, so Neon can scale to zero in between. Check the compute's autosuspend delay in Neon: with a 5-minute delay the database still wakes for each quarter-hour check, so a shorter delay saves more when nobody is working.

## 2. Add storage (Vercel → Storage)

- **Neon Postgres.** Connecting it sets `DATABASE_URL`.
- **Blob, with private access.** Connecting it sets `BLOB_READ_WRITE_TOKEN`. Files must be private: the app streams them only to signed-in teammates.

### Put the functions next to the database

Set the project's function region (Vercel → Settings → Functions → Function Region) to the region your Neon database is in, for example `iad1` for a database in AWS `us-east-1`. The app talks to Neon over HTTP, one request per query, and a page makes several in a row (the session check, then the app's data, then the page's), so every query pays the distance between the two twice. In the same region that's about a millisecond; across a continent it's 60–80 ms a query, which turns a quick page into a slow one. Vercel's default region isn't necessarily where your database is, so check both. The repository doesn't pin a region, since each deployment's database can be anywhere.

## 3. Set environment variables

| Variable | Value |
| --- | --- |
| `AUTH_SECRET` | `openssl rand -base64 32`. Signs sessions and unsubscribe links. Changing it signs everyone out |
| `NEXT_PUBLIC_SITE_URL` | Your production URL, e.g. `https://crm.example.com` (used in email links) |
| `RESEND_API_KEY` | From resend.com |
| `RESEND_FROM` | A sender on a domain verified in Resend, e.g. `Acme <crm@acme.com>` |
| `RESEND_DOMAINS` | Optional. The Resend domains this CRM manages, comma-separated, e.g. `mail.acme.com`. Set it when the Resend account is shared with another app: the CRM then never lists, syncs, sends from or removes the other domains and their inboxes. Unset means every domain in the account |
| `CRON_SECRET` | Any long random string. Vercel sends it to the cron endpoints |
| `STRIPE_SECRET_KEY` | Optional. A **restricted** key with read access to Customers, Subscriptions, Invoices, Charges, Products, Prices and Payment Methods. Shows billing on every client, matched by the emails of the client's people |
| `STRIPE_SECRET_KEY_<NAME>`, `STRIPE_ACCOUNT_LABEL_<NAME>` | Optional. One more Stripe account per key (`STRIPE_SECRET_KEY_A`, `STRIPE_SECRET_KEY_B`), each with the label the app shows for it. `<NAME>` is letters, digits and underscores; lowercased, it's the account's id in the database, so keep it once set |
| `RESEND_WEBHOOK_SECRET` | Optional. Only if you create the Resend webhook yourself; otherwise Settings → Email domains → Connect webhook creates it and stores its secret. A webhook you create yourself needs the `inbox.*` events and, for delivery tracking, `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed` and `email.suppressed` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Optional, for push notifications. Generate once with `pnpm dlx web-push generate-vapid-keys` and keep them: changing them turns notifications off on every device until people turn them on again |
| `VAPID_SUBJECT` | Optional. A `mailto:` or `https:` contact for push services, e.g. `mailto:it@acme.com`. Defaults to `NEXT_PUBLIC_SITE_URL` |
| `AI_GATEWAY_API_KEY` | Required for the AI features (assistant, voice, dictation, summaries), on Vercel too. Create it in the Vercel dashboard → AI Gateway → API keys and set a budget on it: that budget caps what the CRM spends on AI. Without it the AI features are hidden. See [AGENT.md](AGENT.md) |
| `AGENT_RUN_SECRET` | Optional. Signs the tokens the CRM and the agent's background agent use with each other. Defaults to a key derived from `AUTH_SECRET` |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Optional. Only for preview deployments behind Deployment Protection, so the CRM and the background agent can reach each other there (Project → Settings → Deployment Protection → Protection Bypass for Automation) |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID` | Optional. Lets teammates connect their Microsoft 365 mailbox and calendar. See [MICROSOFT.md](MICROSOFT.md) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_WEBHOOK_SECRET`, `TWILIO_MESSAGING_SERVICE_SID` | Optional. Calling from the browser, forwarding incoming calls, and texting; numbers are bought in Settings → Phone numbers. See [PHONE.md](PHONE.md) |
| `TOKEN_ENCRYPTION_KEY` | Optional. Encrypts stored Microsoft tokens and the Twilio API key secret. Defaults to a key derived from `AUTH_SECRET`; changing either means teammates reconnect Microsoft |
| `KNOWLEDGE_API_URL`, `KNOWLEDGE_API_KEY` | Optional. A read-only JSON API about your organization (usually your website's content), which the agent and MCP agents can look things up in. Add `KNOWLEDGE_NAME` and `KNOWLEDGE_DESCRIPTION` to tell agents what it covers. See [KNOWLEDGE.md](KNOWLEDGE.md) |
| `NEXT_PUBLIC_APP_NAME` | Optional. Product name in the browser tab, e.g. `Acme CRM`. Default `CRM` |
| `NEXT_PUBLIC_BRAND_COLOR` | Optional. Brand color for buttons and selected states, e.g. `#2f629f` |
| `NEXT_PUBLIC_APP_CONFIG` | Optional. JSON overrides for anything in `app.config.ts`. See [THEMING.md](THEMING.md) |

The three `NEXT_PUBLIC_*` values are compiled into the page, so they need a redeploy to change and must never hold secrets.

Mark `AUTH_SECRET`, `RESEND_API_KEY`, `CRON_SECRET`, `STRIPE_SECRET_KEY` (and every `STRIPE_SECRET_KEY_<NAME>`), `RESEND_WEBHOOK_SECRET`, `VAPID_PRIVATE_KEY`, `AI_GATEWAY_API_KEY`, `MICROSOFT_CLIENT_SECRET`, `TWILIO_API_KEY_SECRET`, `TWILIO_WEBHOOK_SECRET`, `TWILIO_AUTH_TOKEN` (if used), `TOKEN_ENCRYPTION_KEY` and `KNOWLEDGE_API_KEY` as **Sensitive**. The Resend key needs full access, so the CRM can manage domains, inboxes and webhooks. Preview deployments should use their own Neon branch (Neon's Vercel integration can create one per preview) so previews never touch production data.

## 4. Set up email domains and inboxes

In the CRM, Settings → Email domains. Removing a domain or inbox here deletes it in Resend, so if the Resend account is shared with another app, set `RESEND_DOMAINS` first rather than removing the other app's domains.

1. **Add a domain** (with "Receive email on this domain" on). Add the DNS records it shows (SPF, DKIM, and the MX record for receiving) at your DNS host, then **Verify**. Until a domain is verified, Resend only delivers to your own address. Use a subdomain (mail.acme.com) for receiving if your main domain's mail already goes to Google Workspace or Microsoft 365, since receiving needs the MX record.
2. **Add inboxes** on that domain, like sales@ or hello@. Their mail shows in Email → Inbox and on the matching records.
3. **Connect webhook** under Live updates, so new mail shows up within seconds and sent emails show whether they were delivered or bounced. (Without it, the cron syncs inboxes every 15 minutes and checks delivery hourly.) Open and click tracking are off by default, for deliverability; leave them off in Resend too. To use them, set `email.trackOpens` / `email.trackClicks` in `NEXT_PUBLIC_APP_CONFIG` (see [THEMING.md](THEMING.md)), turn the same tracking on for the domain in Resend, redeploy, and reconnect the webhook.

## 5. Deploy and set up

Open the deployment. The first visit goes to **Set up your CRM**: the person who fills it in becomes the owner. Then:

1. Settings → Email and brand: logo, color, **postal address** (required for campaigns), signature.
2. Settings → Pipelines: each client category (prospective, current, past) starts with one pipeline. Rename the stages, set probabilities for prospects.
3. Settings → Services: what you sell, with default prices.
4. Settings → Custom fields: anything else you track.
5. Settings → Team: invite everyone.
6. People → Import: bring in a spreadsheet.

## Optional

- **Microsoft 365** (each teammate's own Outlook and calendar): register the app in Entra ID and set the `MICROSOFT_*` variables, then teammates connect in Settings → Email and calendar. See [MICROSOFT.md](MICROSOFT.md).
- **Calling and texting:** set the `TWILIO_*` variables, then Settings → Phone numbers → Set up calling, and Get a number by area code. See [PHONE.md](PHONE.md).
- **The AI features** (assistant, voice, dictation, summaries) need `AI_GATEWAY_API_KEY`; they never fall back to the deployment's OIDC token, so the key's budget is the ceiling on AI spend. Each can be turned off with `agent.*` in `NEXT_PUBLIC_APP_CONFIG` (see [AGENT.md](AGENT.md#configure-your-deployment)).
- **The agent's background work** (research, cleanups, tasks assigned to it) runs on an eve agent that deploys with the app as a second service of the same project. It needs the project's Node.js version set to 24.x (Project → Settings → Build and Deployment) and `AI_GATEWAY_API_KEY`. Its models and spending limits are `agent.background.*` in `app.config.ts`. Turn it off with `NEXT_PUBLIC_APP_CONFIG='{"agent":{"background":{"enabled":false}}}'`. See [AGENT.md](AGENT.md#background-work).
- **Push notifications:** see [Set up push notifications](#set-up-push-notifications) below.
- **Custom domain:** add it in Vercel, then update `NEXT_PUBLIC_SITE_URL`.
- **Deployment protection:** the app has its own login, but you can also turn on Vercel Authentication for preview deployments.
- **Analytics and Speed Insights** load automatically on Vercel; enable them in the project to see data.

## Set up push notifications

Push alerts (tasks, meetings, mentions, team chat, activity on your records) use Web Push, which needs a VAPID key pair: a public key the browser uses to sign up and a private key the server signs every alert with. Locally (`pnpm dev`) a pair is made for you in `.data/vapid.json`. A deployment needs its own, set once.

1. **Make a key pair**, on your own computer:

   ```bash
   pnpm dlx web-push generate-vapid-keys
   ```

   It prints a public key and a private key (URL-safe base64; the public one is about 87 characters, the private one about 43). Keep them somewhere safe, like your password manager.
2. **Add them in Vercel** → Project → Settings → Environment Variables, for Production (and Preview, if you test push there; previews can share the pair):
   - `VAPID_PUBLIC_KEY`: the public key.
   - `VAPID_PRIVATE_KEY`: the private key. Mark it **Sensitive**.
   - `VAPID_SUBJECT`: optional, a contact the push services can reach you at, such as `mailto:it@acme.com`. Without it, `NEXT_PUBLIC_SITE_URL` is used.

   Or from a terminal with the Vercel CLI linked to the project (each command asks for the value; then mark the private key Sensitive in the dashboard):

   ```bash
   vercel env add VAPID_PUBLIC_KEY production
   ```

   ```bash
   vercel env add VAPID_PRIVATE_KEY production
   ```

   ```bash
   vercel env add VAPID_SUBJECT production
   ```
3. **Redeploy**, so the new variables are picked up.
4. **Turn it on, per device.** Settings → Notifications shows whether push is on for the device you're on. Tap **Turn on notifications** and allow them when the browser asks, then pick which alerts that device gets. **Send a test** checks one arrives.
   - **Android:** works in Chrome straight away. Installing the CRM (Chrome menu → Install app) makes alerts open it full screen.
   - **iPhone and iPad** (iOS 16.4 or later): notifications only work in the installed app. In Safari, tap Share → Add to Home Screen (the sign-in page shows these steps on a phone), open the CRM from its new icon and sign in. It then asks to turn notifications on.
   - **Desktop:** Chrome, Edge, Firefox and Safari all work. If the page says notifications are blocked, allow them in the browser's site settings (the icon left of the address) and reload.

Set the keys once and keep them. New keys sign every device out of notifications, and everyone has to turn them on again. Until the keys are set, the notifications page says push isn't set up, and the notifications cron skips push (agenda emails still go out). The same page turns on the daily and weekly agenda emails, which need Resend (`RESEND_API_KEY`, `RESEND_FROM`).
