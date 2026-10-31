# Deploying to Vercel

## 1. Create the project

Import the repository in Vercel. `vercel.json` sets the build command (`pnpm db:migrate && pnpm build`), so migrations run before every build, and adds the campaign cron.

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
| `CRON_SECRET` | Any long random string. Vercel sends it to the cron endpoint |

Mark `AUTH_SECRET`, `RESEND_API_KEY` and `CRON_SECRET` as **Sensitive**. Preview deployments should use their own Neon branch (Neon's Vercel integration can create one per preview) so previews never touch production data.

## 4. Verify your email domain in Resend

Add the SPF and DKIM records Resend gives you. Until the domain is verified, Resend only delivers to your own address.

## 5. Deploy and set up

Open the deployment. The first visit goes to **Set up your CRM**: the person who fills it in becomes the owner. Then:

1. Settings → Email and brand: logo, color, **postal address** (required for campaigns), signature.
2. Settings → Pipelines: rename the starter stages, set probabilities.
3. Settings → Custom fields: anything else you track.
4. Settings → Team: invite everyone.
5. People → Import: bring in a spreadsheet.

## Optional

- **Custom domain:** add it in Vercel, then update `NEXT_PUBLIC_SITE_URL`.
- **Deployment protection:** the app has its own login, but you can also turn on Vercel Authentication for preview deployments.
- **Analytics and Speed Insights** load automatically on Vercel; enable them in the project to see data.
