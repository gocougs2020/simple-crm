# Calling and texting (Twilio)

With a Twilio account connected, the team can:

- **Call from the browser.** A Call button on people, organizations and clients (and "Call now" in the composer's Call tab) dials the record's phone from one of the team's numbers. A panel in the corner shows the call (timer, mute, keypad, hang up) and takes notes as you talk; it stays open while you move around the CRM. The call is logged on the record by itself, with how it went (Connected, No answer, Busy…) and how long it lasted, and the notes save onto it.
- **Forward incoming calls.** Each number rings a cell phone. The call is logged on whoever called, if their number matches a person (or an organization's main line), with a note of who it was forwarded to; the teammate who looks after the number gets a task, due today, to write the call up. Unknown callers get a task too, so nobody is lost.
- **Text one to one.** The composer's Text tab sends from one of the team's numbers. Texts both ways go on the person's timeline, with delivery status for ones sent. Replies are matched by phone number and notify the person's owner (push alert "Texts from my contacts"), opening the conversation on the Messages page.
- **Read and answer every conversation in one place.** Messages (in the sidebar, with a count of what's unread for you) lists every text conversation, newest first: one per pair of our number and theirs. Search by name, number or words in a text, and filter to Unread, My records or Not in the CRM. The middle shows the back and forth with each teammate's initials on the texts they sent (campaign texts carry the campaign creator's, labeled with the campaign and styled apart), delivery status, and a composer (Enter sends, from the number they texted); the right shows the person, their organization and the clients they're part of. Unread belongs to whoever owns the person, or is everyone's when nobody does, the same as email (see [ARCHITECTURE.md](ARCHITECTURE.md#unread-email-and-texts)); hover a conversation or use the envelope button to mark it read or unread. A number nobody in the CRM has gets **Add person**: once a person has that number, the conversation and its texts move onto their record and timeline. Campaign texts join the conversation but don't move it up the list, so a campaign doesn't bury real conversations; a reply does.
- **Send text campaigns.** Email → Campaigns → New → Text campaign: the same audience filters as email campaigns (tags, decision makers, organizations, industries, client stage and more), a live preview, a segment counter, tests, scheduling and a report.

Settings → **Phone numbers** (admins) is where numbers are bought by area code, who may call and text from each is set, and where calls ring. Only numbers bought there are ever listed: the rest of the Twilio account (numbers you keep for other clients, say) is never shown, changed or used.

## Set it up (an admin, once)

1. For texting in the US, register for A2P 10DLC in the [Twilio console](https://console.twilio.com) (Messaging → Regulatory compliance) and create a **messaging service** for it; unregistered numbers are filtered by carriers. In the service's Integration settings, choose **Defer to sender's webhook**, so texts keep reaching the CRM.
2. In the Twilio console, Settings → Account settings → **API keys & auth tokens** → Create API key, type **Standard**. Copy its SID (`SK…`) and secret; the secret is shown once. The CRM uses this key for every call to Twilio's API and to sign browser-call tokens, so the account's auth token isn't needed. (Twilio doesn't let Restricted keys sign call tokens, so it has to be Standard. A Standard key can't manage the account, its subaccounts or other keys, and can be revoked on its own.)
3. Set environment variables on the Vercel project (mark the secrets Sensitive), then redeploy:

   | Variable | Value |
   | --- | --- |
   | `TWILIO_ACCOUNT_SID` | Account SID, `AC…` |
   | `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` | The Standard API key from step 2 |
   | `TWILIO_WEBHOOK_SECRET` | The webhook signing key's secret (step 4). Verifies every webhook Twilio sends. While rotating, both secrets, comma-separated |
   | `TWILIO_MESSAGING_SERVICE_SID` | Optional (`MG…`). Numbers bought from Settings are added to this messaging service, so they text under your A2P 10DLC registration |
   | `TWILIO_TWIML_APP_SID` | Optional. Settings creates it for you (below); set it only to use your own |
   | `TWILIO_AUTH_TOKEN` | Legacy, optional. Works instead of the API key, and verifies webhooks Twilio signs with the auth token, which is all of them until step 4 is done |
   | `TOKEN_ENCRYPTION_KEY` | Optional. Encrypts the API key secret Settings stores on the legacy auth-token setup. Defaults to a key derived from `AUTH_SECRET` |

4. Have Twilio sign the CRM's webhooks with a **signing key** instead of the auth token. Twilio's [webhook configuration API](https://www.twilio.com/docs/usage/webhooks/webhook-shared-keys) does this; run these with the API key from step 2 (`SK…:secret`), using the deployment's public URL:

   ```bash
   curl -X POST https://webhooks.twilio.com/v1/Webhooks/SharedKeys -u "$TWILIO_API_KEY_SID:$TWILIO_API_KEY_SECRET" -H 'Content-Type: application/json' -d '{"friendlyName": "CRM webhooks"}'
   ```

   Save the `secret` it returns (shown once) as `TWILIO_WEBHOOK_SECRET` and redeploy. Then make a setting that signs with it (use the `id` from above):

   ```bash
   curl -X POST https://webhooks.twilio.com/v1/Webhooks/Settings -u "$TWILIO_API_KEY_SID:$TWILIO_API_KEY_SECRET" -H 'Content-Type: application/json' -d '{"friendlyName": "CRM webhooks", "auth": {"source": "INLINE", "value": {"scheme": "NONE"}}, "signature": {"type": "SHARED_KEY", "sharedKeyId": "SHARED_KEY_ID", "algorithm": "HMAC_SHA256"}}'
   ```

   And a rule that applies it to the CRM's webhooks only (use the setting's `id`, and your domain):

   ```bash
   curl -X POST https://webhooks.twilio.com/v1/Webhooks/Rules -u "$TWILIO_API_KEY_SID:$TWILIO_API_KEY_SECRET" -H 'Content-Type: application/json' -d '{"matchType": "PREFIX_MATCH", "prefix": "https://crm.example.com/api/webhooks/twilio/", "settings": [{"settingId": "SETTING_ID", "percentage": 100}]}'
   ```

   It takes a minute or two to apply. Text one of the numbers to check: the text lands on the record. If it doesn't, the deployment's logs say why (`[twilio] webhook refused: …`); if they say the signature didn't match with `HMAC_SHA256`, make a second setting with `"algorithm": "HMAC_SHA1"` and point the rule at it. Until the rule applies, Twilio keeps signing with the auth token, so an existing deployment switching over keeps `TWILIO_AUTH_TOKEN` set until then, then removes it.

5. In the CRM, Settings → Phone numbers:
   - **Set up calling** creates a TwiML app (whose voice URL is this deployment) in the Twilio account, for browser calls, and signs call tokens with the API key. (On the legacy auth-token setup, it also creates an API key and stores it encrypted.) Texting works without it.
   - **Get a number**: type an area code, pick from the local numbers Twilio has that can do voice, SMS and MMS, name it, set the cell phone calls ring, who answers (they get the write-up tasks and texts from unknown numbers) and who can use it, then **Buy**. The number is bought in the Twilio account (a monthly charge), already pointed at the CRM, and added to the messaging service when one is set.
   - **Delete number** (in a number's Edit) releases it from the Twilio account for good: it stops working and stops being billed. Calls and texts it carried stay on the records.
   - After moving to a new domain, **Reconnect all** and **Repair** point everything at it again.
6. Teammates with access see Call and Text on records right away. The browser asks for the microphone the first time.

## Consent and opt-outs

- Replies of STOP (and STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT) mark everyone with that number as opted out, with a history entry; START or UNSTOP opts them back in. Twilio also blocks texts to opted-out numbers itself. One-to-one texts to someone who opted out are refused with a sentence that says why.
- Text campaigns go only to people marked **Agreed to marketing texts** on their record (the date is kept), unless a deployment sets `phone.textCampaignsNeedConsent` to `false`. In the US, marketing texts need prior express written consent; turning this off is your legal call.
- Every campaign text ends with `phone.textCampaignFooter` ("Reply STOP to opt out.") unless the message already includes it.

## Settings (per deployment)

In `app.config.ts`, overridable with `NEXT_PUBLIC_APP_CONFIG` (see [THEMING.md](THEMING.md)):

| Key | Default | What it does |
| --- | --- | --- |
| `phone.enabled` | `true` | Off hides calling and texting even with credentials set |
| `phone.defaultCountryCode` | `"1"` | Added to numbers typed without a country code |
| `phone.numberCountry` | `"US"` | Where Get a number searches (two-letter country code). Area codes work in `"US"` and `"CA"` |
| `phone.forwardCallerId` | `"caller"` | Caller ID on a forwarded call: the caller's number (the cell phone shows who it is) or `"number"` (the team's number) |
| `phone.forwardTimeoutSeconds` | `25` | How long a forwarded call rings before it's missed |
| `phone.missedCallMessage` | `null` | Said to callers when nobody answers. `null` hangs up |
| `phone.textCampaignsNeedConsent` | `true` | Text campaigns only go to people who agreed to marketing texts |
| `phone.textCampaignFooter` | `"Reply STOP to opt out."` | Added to every campaign text |

## How it works

- **Webhooks** (`/api/webhooks/twilio/*`) check Twilio's signature (an HMAC over the URL and parameters) against the deployment's public URL and the URL the request arrived on; anything unsigned gets a 403. A webhook Twilio signed with a signing key (it says so in `X-Twilio-Webhooks-Signature-Settings`, with the algorithm) is checked with `TWILIO_WEBHOOK_SECRET`; any other with `TWILIO_AUTH_TOKEN`. With neither set, every webhook is refused and Settings → Phone numbers says so.
- **Credentials.** Every call to Twilio's API (`src/lib/twilio/client.ts`) authenticates with the API key, or the auth token when no key is set; Settings → Phone numbers notes when it's the auth token. Each is idempotent on Twilio's id (`CallSid`, `MessageSid`), so Twilio's retries never log twice.
- **Browser calls** (`src/lib/twilio/voice.ts`): the page asks the server to prepare the call (checking access to the number and getting a one-hour token that can only place calls), the Voice SDK connects, and Twilio asks the voice webhook what to do. The webhook only dials a call that this teammate prepared in the last five minutes, from the number they chose, and logs the activity then. Dial and status callbacks fill in the outcome and length.
- **Only the CRM's numbers.** Settings never lists the Twilio account's numbers; it searches Twilio's available numbers and buys one. Every action that changes or releases a number works only on numbers in the CRM's own table, which only purchases add to.
- **Conversations** (`text_threads`, `src/lib/twilio/threads.ts`) are found or made when a text is saved, keyed on our number and the last 10 digits of theirs, so a reply always goes back from the number they texted. Texts from before conversations existed were grouped into them by migration `0013`; ones whose latest one-to-one text was an unanswered reply from the last week start unread, the rest read.
- **Matching** compares the last 10 digits of a number, ignoring an extension (indexed), so "(303) 555-0123" on a record matches a call from +13035550123.
- **Text campaigns** send through the same claim-and-resume path as email campaigns. Each recipient is a `text_messages` row (unique per campaign and person) before Twilio is asked, so a resumed send never texts anyone twice; a number Twilio refuses is kept as failed and the send goes on. Campaign texts are on each timeline but, like campaign emails, don't count as contact; they set "Last campaign".
- **Local development:** the features hide themselves without Twilio credentials. Twilio's webhooks need a public URL, so use a tunnel (and set `NEXT_PUBLIC_SITE_URL` to it) to try them locally.
