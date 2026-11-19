# Microsoft 365 (Outlook and calendar)

Each teammate can connect their own Microsoft 365 mailbox and calendar (Outlook on Exchange Online) in **Settings → Email and calendar**. Once connected:

- **Email from records goes out as them.** The email composer offers their Outlook address first. The message is sent through Microsoft Graph, saved in their Sent Items, and logged on the timeline. Replies come back to their Outlook.
- **Mail with contacts lands on records.** Every 15 minutes (`microsoft.syncEveryMinutes`), new mail in their Inbox (and Sent Items, with `microsoft.syncSent`) is matched to people by address, else to organizations by website domain, and added to the timeline of the person, their organization and the client they belong to. Mail between teammates and with anyone not in the CRM is never copied.
- **Private mail stays out.** Emails marked Private, Personal or Confidential in Outlook are never copied. Every other email is screened first by a decision model, TypeSafe's [Jev](https://vercel.com/i/what-is-jev) through the AI Gateway (`microsoft.screenModel`). It doesn't write text: it answers one yes/no question, "is this sensitive, by the rules in `microsoft.screenInstructions`?", with a probability, so it's fast and costs a fraction of a cent per email. By default, sensitive means anything not about recruiting, above all compensation and pay, and conversations between your own teammates (the team's names and addresses go along with each email, so a teammate who's also in the CRM as a person is recognized). At or above `microsoft.screenThreshold` (0.6) the email stays out. If the screen isn't set up or doesn't answer, the email goes in unscreened: Outlook's own label is still checked. Kept-out emails get an Outlook category (`microsoft.withheldCategory`, "Not in CRM" by default, named after the app) so the teammate can see what didn't go in. Nothing of their content is stored: only that a message was skipped, and why.
- **CRM meetings go on their calendar.** A meeting with a time, assigned to them, is created in their Outlook calendar with a link back to the record, and moved, updated or removed as the meeting is. `microsoft.calendarTypes` can add planned calls; `microsoft.inviteContacts` also invites the person (off by default, so nobody gets an invitation they didn't expect).
- **The team can see each other's calendars.** Calendar (in the sidebar) shows a week of meetings and planned calls for the teammates picked, with each connected teammate's Outlook events as much as they share: nothing, free/busy, or full details (their choice, in Settings). Events marked Private in Outlook always show as busy. Outlook events are read live when the page opens and never stored.

- **Each teammate sees what was copied from their own mailbox.** Email → My Outlook lists the mail the sync put on records from the signed-in teammate's mailbox, newest first, with the record it's on and a Remove button. It's read from `synced_emails` for the account looked up from their session, so nobody opens anyone else's list, whatever their role. The rest of the mailbox isn't shown: that's what Outlook is for.
- **Owners can cut a connection, and nothing else.** Settings → Email and calendar shows owners a Team connections list: who connected which address, what it's used for, whether it's working and when it last synced. Disconnect deletes that teammate's tokens at once (optionally taking the copied mail off the timelines), the same as if they'd done it themselves. Owners can't read a teammate's mailbox, change their settings or connect on their behalf; admins and members don't see the list at all.

## Set it up (an admin, once)

1. **Register the app** in the [Microsoft Entra admin center](https://entra.microsoft.com) → App registrations → New registration.
   - Supported account types: *Accounts in this organizational directory only* (single tenant) unless you want other organizations' users to connect.
   - Redirect URI: **Web**, `https://<your-domain>/api/integrations/microsoft/callback`. Add one per domain that should work (production, and `http://localhost:3200/api/integrations/microsoft/callback` for local development).
2. **API permissions** → Add a permission → Microsoft Graph → *Delegated*: `offline_access`, `User.Read`, `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`. Then **Grant admin consent** so teammates aren't asked to request it. (`Mail.ReadWrite` rather than `Mail.Read` is what lets the CRM mark kept-out emails with a category.)
3. **Certificates & secrets** → New client secret. Copy the value (it's shown once) and note when it expires: connections stop working when it does.
4. **Set environment variables** on the Vercel project (mark the secret as Sensitive), then redeploy:

   | Variable | Value |
   | --- | --- |
   | `MICROSOFT_CLIENT_ID` | The registration's Application (client) ID |
   | `MICROSOFT_CLIENT_SECRET` | The secret's value |
   | `MICROSOFT_TENANT_ID` | Optional. Your Directory (tenant) ID or domain, so only your organization's accounts can connect. Defaults to `organizations` (any work or school account) |
   | `TOKEN_ENCRYPTION_KEY` | Optional. Encrypts the stored tokens (AES-256-GCM). Defaults to a key derived from `AUTH_SECRET`. Changing whichever one is used means everyone reconnects |
   | `AI_GATEWAY_API_KEY` | For the mail screen. Without it, mail goes in unscreened (Outlook's Private/Confidential labels still keep mail out) |

5. Each teammate opens **Settings → Email and calendar → Connect Microsoft account**.

The cron (`/api/cron/microsoft`, every quarter hour in `vercel.json`) does the syncing; it skips the quarter hours that don't fit `microsoft.syncEveryMinutes`, so 30 or 60 lets Neon sleep longer.

## Settings (per deployment)

All in `app.config.ts`, overridable with `NEXT_PUBLIC_APP_CONFIG` (see [THEMING.md](THEMING.md)), e.g.

```bash
NEXT_PUBLIC_APP_CONFIG='{"microsoft":{"syncEveryMinutes":30,"withheldCategory":"Kept out of CRM","calendarTypes":["meeting","call"]}}'
```

| Key | Default | What it does |
| --- | --- | --- |
| `microsoft.enabled` | `true` | Off hides the integration even with credentials set |
| `microsoft.syncEveryMinutes` | `15` | 15, 30 or 60 |
| `microsoft.firstSyncDays` | `14` | How far back a newly connected mailbox's first sync reads |
| `microsoft.syncSent` | `true` | Also copy mail teammates send from Outlook itself |
| `microsoft.screenMail` | `true` | Screen each email before it's copied. Off copies everything that isn't marked private in Outlook |
| `microsoft.screenModel` | `"typesafe-ai/jev"` | An AI Gateway decision model (type "evaluation"), such as Jev |
| `microsoft.screenInstructions` | Not about recruiting: pay and compensation, teammates talking to each other, personal, HR, legal… | What counts as sensitive, in plain words. Set your own for another line of business |
| `microsoft.screenThreshold` | `0.6` | Keep an email out when the model is at least this sure (0–1) it's sensitive. Lower keeps more out |
| `microsoft.withheldCategory` | `null` ("Not in CRM") | The Outlook category kept-out emails get. `""` turns marking off |
| `microsoft.calendarTypes` | `["meeting"]` | Which planned activities go on the assignee's calendar (`"meeting"`, `"call"`) |
| `microsoft.calendarDefaultMinutes` | `30` | Length of a copied meeting with no duration |
| `microsoft.inviteContacts` | `false` | Also invite the person the meeting is with |

## How it works

- **Tokens** are encrypted at rest (`src/lib/crypto.ts`) in `connected_accounts`, one row per teammate. Access tokens are refreshed two minutes before they expire. When Microsoft refuses a refresh (password change, revoked consent, an expired client secret), the connection is marked for reconnecting and Settings says so; nothing else breaks.
- **Connecting** is the authorization code flow with PKCE. The state and verifier travel in an encrypted, HttpOnly, 10-minute cookie bound to the teammate who started, so a callback can't be replayed or completed by someone else.
- **Sync** (`src/lib/microsoft/mail.ts`) reads each folder from the newest message it has already seen (with a 10-minute overlap), drops the ones it already knows with one lookup per folder, and records every message it looks at in `synced_emails`, so nothing is copied twice, even when two teammates are on the same thread (matched by Internet Message-ID) or when the email was sent from the CRM (matched against `outbound_emails.message_id`). Each row keeps the screen's probability (`screen_score`), so you can look at real mail before moving `microsoft.screenThreshold`; mail that went in unscreened says why in `reason`.
- **Removing.** A copied email that shouldn't be there can be deleted from the timeline by the teammate whose mailbox it came from, or by an admin. It disappears for everyone and is never copied again. Disconnecting deletes the tokens at once, and can also take every email copied from that mailbox off the timelines.
- **Calendar** events the CRM creates carry an extended property with the activity's id, so Calendar doesn't show them twice. Changes are pushed after the response (`after()`), so a slow Graph never slows saving a meeting.
