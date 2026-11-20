/**
 * The "Connect Zapier, Make and other tools" guide, as data, so the docs page
 * and the Markdown export (/developers.md) say the same thing. Pure.
 *
 * Text is plain with `code` in backticks; the page renders those as code and
 * the Markdown keeps them as they are. `$CRM_URL` is this site's address.
 */

export type GuideStep = { title: string; text: string[]; code?: { label: string; code: string } };

export const integrationIntro = [
  "Anything that can send an HTTPS request with a header can create and update records: Zapier, Make, n8n, a form tool, a scheduling tool, or a few lines of code in another repository. Use the REST API with a key; MCP is for AI agents.",
  "Scheduling tools such as Calendly send their own webhooks without an Authorization header, so they can't call the API directly. Put Zapier or Make in between (or a small function of your own), and let it add the key.",
];

const json = (o: unknown) => JSON.stringify(o, null, 2);

export const integrationSteps: GuideStep[] = [
  {
    title: "1. Create a key for the integration",
    text: [
      "An admin creates a workspace key in Settings → API and MCP, named after what uses it (\"Zapier\"). Changes it makes show in history under that name. To have them show as a teammate instead, that teammate creates a personal key; it can do what their role allows.",
      "Paste the key into the tool's header field, never into a URL or a field that's shown to others. Set it to expire, and revoke it when the integration is retired.",
    ],
  },
  {
    title: "2. Send requests with the key as a bearer token",
    text: [
      "In Zapier, add an action step with Webhooks by Zapier → Custom Request (or POST with Payload type json). In Make, use HTTP → Make a request. Set:",
      "Method `POST`, URL `$CRM_URL/api/v1/…`, headers `Authorization: Bearer <key>` and `Content-Type: application/json`, and the body as JSON with the trigger's fields mapped in.",
    ],
  },
  {
    title: "3. Find or create the person",
    text: [
      "Creating someone whose email is already in the CRM answers 409, which stops a Zap. Add `?ifExists=return` and the CRM answers with the person who's already there instead, unchanged, so every booking gives you a person id to use in the next step. Organizations take the same option, matched on name.",
      "The response is `{ \"data\": { \"id\": \"…\", … } }`. In later steps, map `data.id` (Zapier shows it as Data ID).",
    ],
    code: {
      label: "Calendly invitee → person",
      code: `curl -X POST "$CRM_URL/api/v1/people?ifExists=return" \\\n  -H "Authorization: Bearer $CRM_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${json({ firstName: "{{Invitee First Name}}", lastName: "{{Invitee Last Name}}", email: "{{Invitee Email}}", phone: "{{Text Reminder Number}}", tags: ["calendly"] })}'`,
    },
  },
  {
    title: "4. Log the booking on their timeline",
    text: [
      "A consult that's coming up is a planned meeting: `type` meeting, `dueAt` the start time with its offset, and `done` false. It shows on the person's timeline as planned. Set `assigneeId` (from `GET /users`) to the teammate taking the consult so it's on their tasks and agenda; a personal key assigns it to its own teammate by default. Put the form answers in `body`; plain text is fine.",
      "To log something that already happened (a form submitted, a call made in another tool), leave out `dueAt` and `done`, and set `occurredAt` if it wasn't just now.",
    ],
    code: {
      label: "Planned meeting",
      code: `curl -X POST "$CRM_URL/api/v1/activities" \\\n  -H "Authorization: Bearer $CRM_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${json({ type: "meeting", subject: "Consult: {{Event Type Name}}", personId: "{{Data ID from step 3}}", dueAt: "{{Event Start Time}}", dueHasTime: true, done: false, body: "Booked through Calendly.\n\n{{Questions And Answers}}" })}'`,
    },
  },
  {
    title: "5. Optionally, open a prospect",
    text: [
      "To put the booking in the pipeline, create a client in the `prospective` category with the person as its contact. Without `stageId` it starts in the first stage of the first prospect pipeline; `GET /pipelines` lists the stage ids. Check `GET /clients?personId=` first if the same person can book more than once.",
    ],
    code: {
      label: "New prospect",
      code: `curl -X POST "$CRM_URL/api/v1/clients" \\\n  -H "Authorization: Bearer $CRM_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${json({ name: "{{Invitee Name}}", category: "prospective", personId: "{{Data ID from step 3}}" })}'`,
    },
  },
  {
    title: "6. Test it, then watch for failures",
    text: [
      "Run the Zap's test with a real booking and open the person in the CRM. A failed request answers with `{ \"error\": { \"code\", \"message\" } }`, and the message says what to fix; a 422 lists each field under `issues`. Zapier shows it on the step.",
      "Ids, labels and custom field keys come from the Workspace endpoints: `GET /users` for ownerId, `GET /labels`, `GET /custom-fields` (values go in `custom`, keyed by the field's key), `GET /pipelines`.",
      "To send CRM changes the other way (into a sheet, say), poll a list endpoint with `updatedSince` on a schedule.",
    ],
  },
];

/** Backticked spans in guide text, split out so the page can render them as code. */
export function codeSpans(text: string): { code: boolean; text: string }[] {
  return text.split(/(`[^`]+`)/).filter(Boolean).map((part) => (part.startsWith("`") && part.endsWith("`") && part.length > 1 ? { code: true, text: part.slice(1, -1) } : { code: false, text: part }));
}
