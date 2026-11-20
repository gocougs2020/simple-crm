import { roleHints, roleLabels, userRoles } from "@/lib/constants";
import { curlFor, fieldsOf, modelFields, type FieldDoc } from "./docs";
import { permissionLabels } from "./docs-text";
import { integrationIntro, integrationSteps } from "./integrations";
import { API_RATE_LIMIT_PER_MINUTE } from "./limits";
import { models } from "./models";
import { operationList, tags } from "./operations";

/**
 * The whole developer reference as one Markdown document, served at
 * /developers.md and copied by the button on /developers. Generated from
 * the same operation list, schemas and models as the API itself, so it
 * can't drift from what the server accepts. Pure: it describes the API,
 * never data.
 */

/** A table cell: one line, pipes escaped. */
const cell = (s: string | null | undefined) => (s ?? "").replace(/\r?\n+/g, " ").replace(/\|/g, "\\|").trim() || "—";
const table = (head: string[], rows: string[][]) => [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
const fence = (code: string, lang = "") => `\`\`\`${lang}\n${code}\n\`\`\``;

function fieldTable(fields: FieldDoc[], showRequired = true) {
  return table(
    showRequired ? ["Field", "Type", "Required", "Description"] : ["Field", "Type", "Description"],
    fields.map((f) => (showRequired ? [`\`${f.name}\``, `\`${f.type}\``, f.required ? "yes" : "", f.description ?? ""] : [`\`${f.name}\``, `\`${f.type}\``, f.description ?? ""])),
  );
}

function endpoint(op: (typeof operationList)[number], base: string) {
  const out = [`### ${op.summary}`, "", `\`${op.method} ${base}/api/v1${op.path}\``, ""];
  if (op.description) out.push(op.description, "");
  out.push(`Needs ${permissionLabels[op.permission]}.${op.tool ? ` MCP tool: \`${op.tool}\`.` : ""}${op.feature ? " Optional: only where this deployment has it set up." : ""}`, "");
  const params = fieldsOf(op.params);
  const query = fieldsOf(op.query);
  const body = fieldsOf(op.body);
  if (params.length) out.push("**Path**", "", fieldTable(params, false), "");
  if (query.length) out.push("**Query**", "", fieldTable(query), "");
  if (body.length) out.push("**Body** (JSON)", "", fieldTable(body), "");
  out.push(`Returns ${op.status === 201 ? "201 with " : ""}${op.list ? "`{ data: [...], nextCursor }`, a list of" : "`{ data }`, a"} [\`${op.response}\`](#model-${op.response.toLowerCase()}).`, "");
  out.push(fence(curlFor(op).replaceAll("$CRM_URL", base), "bash"), "");
  return out.join("\n");
}

export function buildMarkdown({ name, origin }: { name: string; origin: string }) {
  const base = origin.replace(/\/$/, "");
  const tools = operationList.filter((o) => o.tool);
  const sections: string[] = [];
  const push = (...lines: string[]) => sections.push(lines.join("\n"));

  push(
    `# ${name} API and MCP`,
    "",
    `Read and change ${name} from your own code or a no-code tool with the REST API, or let an AI agent work in it through MCP. Both cover people, organizations, clients, tasks, notes and every other kind of activity, and both write the same history as the app.`,
    "",
    `- REST API: \`${base}/api/v1\``,
    `- OpenAPI 3.1: \`${base}/api/v1/openapi.json\` (imports into Postman, Insomnia or any client generator)`,
    `- MCP server: \`${base}/api/mcp\` (Streamable HTTP)`,
    `- This page as HTML: \`${base}/developers\``,
    "",
    "## Contents",
    "",
    "- [Quick start](#quick-start)",
    "- [Authorization](#authorization)",
    "- [Connect Zapier, Make and other tools](#connect-zapier-make-and-other-tools)",
    "- [Conventions](#conventions)",
    "- [Errors and limits](#errors-and-limits)",
    "- [MCP for agents](#mcp-for-agents)",
    "- [Endpoints](#endpoints)",
    "- [Models](#models)",
    "- [MCP tools](#mcp-tools)",
  );

  push(
    "## Quick start",
    "",
    "1. Create a key in Settings → API and MCP. For your own scripts or an agent, create a personal key. For an integration, an admin creates a workspace key.",
    "2. Keep it in an environment variable or the tool's secret field, never in code, a URL or a browser.",
    "3. Call the API with the key as a bearer token:",
    "",
    fence(`export CRM_URL="${base}"\nexport CRM_KEY="crm_pk_…"\n\ncurl "$CRM_URL/api/v1/me" -H "Authorization: Bearer $CRM_KEY"`, "bash"),
  );

  push(
    "## Authorization",
    "",
    "Every request to `/api/v1` needs a key or an OAuth access token, sent as `Authorization: Bearer <key>` (or `X-API-Key: <key>`). The API never accepts the browser's session cookie, so a web page can't be tricked into calling it. Every request rechecks the key: revoked or expired keys, and keys of deactivated teammates, answer 401 at once.",
    "",
    "### Kinds of credential",
    "",
    table(
      ["", "Workspace key `crm_ws_…`", "Personal key `crm_pk_…`", "Connected app (OAuth) `crm_at_…`"],
      [
        ["Made by", "Admins, in Settings → API and MCP", "Any teammate, for themselves (up to 10 live keys)", "A teammate approving an app or agent in the browser"],
        ["Acts as", "The workspace, with no person behind it", "The teammate who made it", "The teammate who approved it"],
        ["Can do", "Everything", "What their role allows, or read-only if made that way", "What their role allows, or read-only if they chose that"],
        ["REST API", "Yes", "Yes", "Yes"],
        ["MCP", "No, so an agent never has more access than its person", "Yes", "Yes"],
        ["History shows", "The key's name", "The teammate, via the key", "The teammate, via the app"],
        ["Best for", "Zapier, Make, server-to-server integrations", "Your own scripts, agents that take a header", "Claude, ChatGPT and other agents that sign in"],
      ],
    ),
    "",
    "- Keys are shown once when made; only a SHA-256 hash is stored. Lose one and make another.",
    "- Keys can expire (30 days, 90 days, a year, or never). Revoking takes effect on the next request. Admins see and can revoke every key, including teammates' personal keys.",
    "- A personal key follows its teammate: change their role and the key changes with it; deactivate them and it stops working.",
    "",
    "### Roles",
    "",
    "Personal keys and connected apps can do what the teammate's role allows, checked on every request. A request the role doesn't allow answers 403.",
    "",
    ...userRoles.map((r) => `- **${roleLabels[r]}.** ${roleHints[r]}`),
    "",
    "Each endpoint below says what it needs:",
    "",
    table(
      ["Permission", "Who has it"],
      Object.entries(permissionLabels).map(([p, label]) => [`\`${p}\``, label]),
    ),
    "",
    "### OAuth 2.1 (for agent and app developers)",
    "",
    "Clients that sign a teammate in, instead of taking a key, use OAuth 2.1 with PKCE (S256 only):",
    "",
    `1. \`POST ${base}/api/mcp\` without a token answers 401 with \`WWW-Authenticate: Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/api/mcp"\`.`,
    `2. That document (RFC 9728) names this site as the authorization server. \`${base}/.well-known/oauth-authorization-server\` (RFC 8414) lists the endpoints.`,
    `3. Register with \`POST ${base}/api/oauth/register\` (RFC 7591 dynamic client registration), or use an https URL to a client ID metadata document as \`client_id\`.`,
    `4. Send the teammate to \`${base}/oauth/authorize\`. They sign in, see which app is asking and where it sends them back, and approve read-and-change or read-only (never more than their role).`,
    `5. \`POST ${base}/api/oauth/token\` trades the code (single use, 5 minutes) for an access token (\`crm_at_…\`, 1 hour) and a refresh token (\`crm_rt_…\`, 30 days). Refresh tokens rotate on every use; reusing one disconnects the app.`,
    `6. \`POST ${base}/api/oauth/revoke\` (RFC 7009) ends a token.`,
    "",
    "Scopes are `crm:read` and `crm:write`. Public clients authenticate with PKCE; confidential ones with `client_secret_basic` or `client_secret_post`. The OAuth endpoints allow any origin (they take no cookies). Teammates see and disconnect connected apps in Settings → API and MCP.",
  );

  push(
    "## Connect Zapier, Make and other tools",
    "",
    ...integrationIntro.flatMap((p) => [p, ""]),
    ...integrationSteps.flatMap((s) => [`### ${s.title}`, "", ...s.text.flatMap((t) => [t.replaceAll("$CRM_URL", base), ""]), ...(s.code ? [`${s.code.label}:`, "", fence(s.code.code.replaceAll("$CRM_URL", base), "bash"), ""] : [])]),
  );

  push(
    "## Conventions",
    "",
    "- Requests and responses are JSON. A record comes back as `{ \"data\": { … } }`; a list as `{ \"data\": [ … ], \"nextCursor\": \"…\" }`.",
    "- Lists return up to 50 items (`limit` goes to 100), newest first. Pass `nextCursor` back as `cursor` for the next page; it's null on the last one. Use `updatedSince` to sync changes.",
    "- `PATCH` changes only the fields you send. Send `null` to clear a field.",
    "- `DELETE` on people, organizations and clients archives them: they leave lists and search but keep their history, and `POST …/restore` brings them back. Tasks, notes and other activity are deleted.",
    "- Money is integer cents (12500 is 125.00) in the workspace currency. Dates are YYYY-MM-DD. Times are ISO 8601; send them with an offset.",
    "- Text bodies take HTML (p, strong, em, a, lists, blockquote, code) or plain text, where blank lines start paragraphs. Anything else is removed.",
    "- Custom fields go in each record's `custom` object, keyed by the field's `key` from `GET /custom-fields`.",
    "- Logging activity on a client also shows it on the client's contact and organization; on a person, also on their organization. Tasks and notes can stand alone; calls, emails, texts and meetings need a person, organization or client.",
    "- A person's email and an organization's name are unique; a duplicate answers 409 with `existingId`, or the existing record with `?ifExists=return`.",
  );

  push(
    "## Errors and limits",
    "",
    "Failures return `{ \"error\": { \"code\", \"message\" } }`. The message is a sentence that says what to do. Validation errors add `issues`, one per field; a duplicate adds `existingId`.",
    "",
    table(
      ["Status", "Code", "Means"],
      [
        ["400", "bad_request, invalid_json", "The request can't be done as sent"],
        ["401", "unauthorized", "No key, or it's revoked, expired or its teammate was deactivated"],
        ["403", "forbidden", "The key's role doesn't allow it"],
        ["404", "not_found", "No such record or endpoint"],
        ["409", "conflict", "It already exists (same email, same organization name)"],
        ["413", "payload_too_large", "The body is over 1 MB (file uploads allow more)"],
        ["415", "unsupported_media_type", "Send the body as JSON with Content-Type: application/json"],
        ["422", "validation_error", "A field is missing or invalid"],
        ["429", "rate_limited", "Too many requests; wait for Retry-After seconds"],
      ],
    ),
    "",
    `Each key can make ${API_RATE_LIMIT_PER_MINUTE} requests a minute, across the API and MCP. Responses carry \`X-RateLimit-Limit\` and \`X-RateLimit-Remaining\`.`,
  );

  push(
    "## MCP for agents",
    "",
    `The Model Context Protocol lets an AI agent use ${name} as a set of tools. Each teammate connects their own agent, which acts as them and can do only what they can. A viewer's agent, or one approved as read-only, sees only reading tools. Server URL: \`${base}/api/mcp\` (Streamable HTTP, stateless JSON-RPC; GET and DELETE answer 405).`,
    "",
    "- **Claude:** Settings → Connectors → Add custom connector, and paste the server URL. Sign in when asked.",
    "- **ChatGPT:** turn on developer mode in Settings, then add a connector with the server URL and OAuth authentication.",
    "- **Claude Code:** `claude mcp add --transport http crm " + `"${base}/api/mcp"` + "`, then run `/mcp` and choose it to sign in.",
    "- **Clients that take a header** (Cursor, VS Code, Windsurf): use a personal key.",
    "",
    fence(JSON.stringify({ mcpServers: { crm: { url: `${base}/api/mcp`, headers: { Authorization: "Bearer crm_pk_…" } } } }, null, 2), "json"),
    "",
    "Workspace keys are refused by MCP. Requests with a cross-site `Origin` are refused. Each tool runs one endpoint; its arguments are the endpoint's path, query and body fields together.",
  );

  push("## Endpoints", "", "Every path is under `/api/v1`.");
  for (const t of tags) {
    const ops = operationList.filter((o) => o.tag === t.name);
    if (!ops.length) continue;
    push(`## ${t.name}`, "", t.description, "", ...ops.map((o) => endpoint(o, base)));
  }

  push(
    "## Models",
    "",
    "What responses contain, inside `data`.",
    "",
    ...Object.entries(models).flatMap(([modelName, schema]) => [`<a id="model-${modelName.toLowerCase()}"></a>`, "", `### ${modelName}`, "", fieldTable(modelFields(schema), false), ""]),
  );

  push(
    "## MCP tools",
    "",
    "Each tool runs one endpoint above.",
    "",
    table(
      ["Tool", "Does", "Needs"],
      tools.map((o) => [`\`${o.tool}\``, `${o.summary} (\`${o.method} ${o.path}\`)`, o.permission === "records:read" ? "Any role" : "Edit access"]),
    ),
  );

  return sections.join("\n\n") + "\n";
}
