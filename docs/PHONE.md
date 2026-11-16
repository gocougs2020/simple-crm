# Calling and texting (Twilio)

With a Twilio account connected, the team can:

- **Call from the browser.** A Call button on people, organizations and clients (and "Call now" in the composer's Call tab) dials the record's phone from one of the team's numbers. A panel in the corner shows the call (timer, mute, keypad, hang up) and takes notes as you talk; it stays open while you move around the CRM. The call is logged on the record by itself, with how it went (Connected, No answer, Busy…) and how long it lasted, and the notes save onto it.
- **Forward incoming calls.** Each number rings a cell phone. The call is logged on whoever called, if their number matches a person (or an organization's main line), with a note of who it was forwarded to; the teammate who looks after the number gets a task, due today, to write the call up. Unknown callers get a task too, so nobody is lost.
- **Text one to one.** The composer's Text tab sends from one of the team's numbers. Texts both ways go on the person's timeline, with delivery status for ones sent. Replies are matched by phone number and notify the person's owner (push alert "Texts from my contacts").
- **Send text campaigns.** Email → Campaigns → New → Text campaign: the same audience filters as email campaigns (tags, decision makers, organizations, industries, client stage and more), a live preview, a segment counter, tests, scheduling and a report.

Settings → **Phone numbers** (admins) decides which numbers the CRM uses, who may call and text from each, and where calls ring.

## Set it up (an admin, once)

1. In the [Twilio console](https://console.twilio.com), buy a number (or use one you have). For texting in the US, register it for A2P 10DLC (Messaging → Regulatory compliance); unregistered numbers are filtered by carriers.
2. Set environment variables on the Vercel project (mark the auth token Sensitive), then redeploy:

   | Variable | Value |
   | --- | --- |
   | `TWILIO_ACCOUNT_SID` | Account SID, `AC…` |
   | `TWILIO_AUTH_TOKEN` | Auth token. Also verifies every webhook Twilio sends |
   | `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_TWIML_APP_SID` | Optional. Settings creates these for you (below); set them only to use your own |
   | `TOKEN_ENCRYPTION_KEY` | Optional. Encrypts the API key secret Settings stores. Defaults to a key derived from `AUTH_SECRET` |

3. In the CRM, Settings → Phone numbers:
   - **Set up calling** creates a TwiML app (whose voice URL is this deployment) and an API key in the Twilio account, for browser calls. Texting works without it.
   - **+ Number** picks a number from the account, names it, sets the cell phone calls ring and who answers (they get the write-up tasks and texts from unknown numbers), and who can use it. Adding a number points its voice and messaging webhooks at the CRM.
   - After moving to a new domain, **Reconnect all** and **Repair** point everything at it again.
4. Teammates with access see Call and Text on records right away. The browser asks for the microphone the first time.

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
| `phone.forwardCallerId` | `"caller"` | Caller ID on a forwarded call: the caller's number (the cell phone shows who it is) or `"number"` (the team's number) |
| `phone.forwardTimeoutSeconds` | `25` | How long a forwarded call rings before it's missed |
| `phone.missedCallMessage` | `null` | Said to callers when nobody answers. `null` hangs up |
| `phone.textCampaignsNeedConsent` | `true` | Text campaigns only go to people who agreed to marketing texts |
| `phone.textCampaignFooter` | `"Reply STOP to opt out."` | Added to every campaign text |

## How it works

- **Webhooks** (`/api/webhooks/twilio/*`) check Twilio's signature (HMAC-SHA1 with the auth token over the URL and parameters) against the deployment's public URL and the URL the request arrived on; anything unsigned gets a 403. Each is idempotent on Twilio's id (`CallSid`, `MessageSid`), so Twilio's retries never log twice.
- **Browser calls** (`src/lib/twilio/voice.ts`): the page asks the server to prepare the call (checking access to the number and getting a one-hour token that can only place calls), the Voice SDK connects, and Twilio asks the voice webhook what to do. The webhook only dials a call that this teammate prepared in the last five minutes, from the number they chose, and logs the activity then. Dial and status callbacks fill in the outcome and length.
- **Matching** compares the last 10 digits of a number (`right(regexp_replace(phone, '[^0-9]', '', 'g'), 10)`, indexed), so "(303) 555-0123" on a record matches a call from +13035550123.
- **Text campaigns** send through the same claim-and-resume path as email campaigns. Each recipient is a `text_messages` row (unique per campaign and person) before Twilio is asked, so a resumed send never texts anyone twice; a number Twilio refuses is kept as failed and the send goes on. Campaign texts are on each timeline but, like campaign emails, don't count as contact; they set "Last campaign".
- **Local development:** the features hide themselves without Twilio credentials. Twilio's webhooks need a public URL, so use a tunnel (and set `NEXT_PUBLIC_SITE_URL` to it) to try them locally.
