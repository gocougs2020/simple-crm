# Deploying to Vercel

## 1. Create the project

Import the repository in Vercel. `vercel.json` sets the build command (`pnpm db:migrate && pnpm build`), so migrations run before every build, and adds the campaign and inbox crons.

## 2. Add storage (Vercel → Storage)

- **Neon Postgres.** Connecting it sets `DATABASE_URL`.
- **Blob, with private access.** Connecting it sets `BLOB_READ_WRITE_TOKEN`. Files must be private: the app streams them only to signed-in teammates.

## 3. Set environment variables

| Variable | Value |
| --- | --- |
| `AUTH_SECRET` | `openssl rand -base64 32`. Signs sessions and unsubscribe links. Changing it signs everyone out |
| `NEXT_PUBLIC_SITE_URL` | Your production URL, e.g. `https://crm.example.com` (used in email links) |
| `RESEND_API_KEY` | From resend.com |
| `RESEND_FROM` | A sender on a domain verified in Resend, e.g. `Acme <crm@acme.com>` |
| `CRON_SECRET` | Any long random string. Vercel sends it to the cron endpoints |
| `STRIPE_SECRET_KEY` | Optional. A **restricted** key with read access to Customers, Subscriptions, Invoices, Charges and Products. Shows billing on current and past clients |
| `RESEND_WEBHOOK_SECRET` | Optional. Only if you create the Resend webhook yourself; otherwise Settings → Email domains → Connect webhook creates it and stores its secret |

Mark `AUTH_SECRET`, `RESEND_API_KEY`, `CRON_SECRET`, `STRIPE_SECRET_KEY` and `RESEND_WEBHOOK_SECRET` as **Sensitive**. The Resend key needs full access, so the CRM can manage domains, inboxes and webhooks. Preview deployments should use their own Neon branch (Neon's Vercel integration can create one per preview) so previews never touch production data.

## 4. Set up email domains and inboxes

In the CRM, Settings → Email domains:

1. **Add a domain** (with "Receive email on this domain" on). Add the DNS records it shows (SPF, DKIM, and the MX record for receiving) at your DNS host, then **Verify**. Until a domain is verified, Resend only delivers to your own address. Use a subdomain (mail.acme.com) for receiving if your main domain's mail already goes to Google Workspace or Microsoft 365, since receiving needs the MX record.
2. **Add inboxes** on that domain, like sales@ or hello@. Their mail shows in Email → Inbox and on the matching records.
3. **Connect webhook** under Live updates, so new mail shows up within seconds. (Without it, the cron syncs every 15 minutes.)

## 5. Deploy and set up

Open the deployment. The first visit goes to **Set up your CRM**: the person who fills it in becomes the owner. Then:

1. Settings → Email and brand: logo, color, **postal address** (required for campaigns), signature.
2. Settings → Pipelines: each client category (prospective, current, past) starts with one pipeline. Rename the stages, set probabilities for prospects.
3. Settings → Services: what you sell, with default prices.
4. Settings → Custom fields: anything else you track.
5. Settings → Team: invite everyone.
6. People → Import: bring in a spreadsheet.

## Optional

- **Custom domain:** add it in Vercel, then update `NEXT_PUBLIC_SITE_URL`.
- **Deployment protection:** the app has its own login, but you can also turn on Vercel Authentication for preview deployments.
- **Analytics and Speed Insights** load automatically on Vercel; enable them in the project to see data.
