import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { appConfig } from "@/app.config";
import { CodeBlock, SiteUrl } from "@/components/developers/code";
import { StatusBadge, type Tone } from "@/components/ui/badge";
import { curlFor, fieldsOf, modelFields, type FieldDoc } from "@/lib/api/docs";
import { permissionLabels } from "@/lib/api/docs-text";
import { API_RATE_LIMIT_PER_MINUTE } from "@/lib/api/limits";
import { models } from "@/lib/api/models";
import { operationList, tags } from "@/lib/api/operations";
import type { HttpMethod } from "@/lib/api/spec";
import { roleHints, roleLabels, userRoles } from "@/lib/constants";

export const metadata: Metadata = { title: "API and MCP", description: `Read and change ${appConfig.brand.name} from code or from an AI agent.` };

/**
 * The developer docs: every endpoint, model and MCP tool, generated from the
 * same operation list the API runs on. Public and static: it describes the
 * API, never data.
 */

const methodTone: Record<HttpMethod, Tone> = { GET: "info", POST: "success", PATCH: "warning", DELETE: "error" };
const anchor = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const tools = operationList.filter((o) => o.tool);

const guides = [
  { id: "start", label: "Quick start" },
  { id: "keys", label: "Keys and access" },
  { id: "mcp", label: "MCP for agents" },
  { id: "conventions", label: "Conventions" },
  { id: "errors", label: "Errors and limits" },
];

export default function DevelopersPage() {
  const name = appConfig.brand.name;
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="sticky top-0 z-10 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 lg:px-6">
          <span className="font-semibold text-primary">{name}</span>
          <span className="text-faint">/</span>
          <span className="text-[14px] text-secondary">API and MCP</span>
          <nav className="ml-auto flex items-center gap-4 text-[13.5px]">
            <a href="/api/v1/openapi.json" className="text-secondary hover:text-primary">
              OpenAPI
            </a>
            <Link href="/settings/api" className="text-secondary hover:text-primary">
              Your keys
            </Link>
          </nav>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-8 lg:grid-cols-[200px_minmax(0,1fr)] lg:px-6">
        <aside className="hidden lg:block">
          <nav aria-label="Docs" className="sticky top-20 max-h-[calc(100dvh-6rem)] overflow-y-auto pb-8 text-[13.5px] scroll-thin">
            <NavGroup title="Guides">
              {guides.map((g) => (
                <NavLink key={g.id} href={`#${g.id}`}>
                  {g.label}
                </NavLink>
              ))}
            </NavGroup>
            <NavGroup title="Endpoints">
              {tags.map((t) => (
                <NavLink key={t.name} href={`#${anchor(t.name)}`}>
                  {t.name}
                </NavLink>
              ))}
            </NavGroup>
            <NavGroup title="Reference">
              <NavLink href="#models">Models</NavLink>
              <NavLink href="#tools">MCP tools</NavLink>
            </NavGroup>
          </nav>
        </aside>

        <main className="min-w-0 max-w-3xl text-[14.5px] leading-relaxed text-secondary">
          <h1 className="text-[28px] font-semibold tracking-tight text-primary">API and MCP</h1>
          <p className="mt-2 text-[15.5px]">
            Read and change {name} from your own code with the REST API, or let an AI agent work in it through MCP. Both cover people, organizations, clients, tasks, notes and every other kind of activity, and both write the same history as the app.
          </p>

          <Guide id="start" title="Quick start">
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                Create a key in{" "}
                <Link href="/settings/api" className="text-primary underline underline-offset-2">
                  Settings → API and MCP
                </Link>
                . For your own scripts or an agent, create a personal key. For an integration, an admin creates a workspace key.
              </li>
              <li>Keep it in an environment variable, never in code or a browser.</li>
              <li>Call the API with the key as a bearer token:</li>
            </ol>
            <CodeBlock code={`export CRM_URL="$CRM_URL"\nexport CRM_KEY="crm_pk_…"\n\ncurl "$CRM_URL/api/v1/me" -H "Authorization: Bearer $CRM_KEY"`} />
            <p>
              Every endpoint lives under <SiteUrl path="/api/v1" />. The full <a href="/api/v1/openapi.json" className="text-primary underline underline-offset-2">OpenAPI 3.1 document</a> imports into Postman, Insomnia or any client generator.
            </p>
          </Guide>

          <Guide id="keys" title="Keys and access">
            <div className="overflow-x-auto">
              <Table head={["", "Personal key (crm_pk_…)", "Workspace key (crm_ws_…)"]}>
                <Row cells={["Who makes it", "Any teammate, for themselves", "Admins"]} />
                <Row cells={["Acts as", "The teammate who made it", "The workspace, with no person behind it"]} />
                <Row cells={["Can do", "What that teammate's role allows, checked on every request", "Everything"]} />
                <Row cells={["Works with MCP", "Yes", "No, so an agent never has more access than its person"]} />
                <Row cells={["History shows", "The teammate, via the key", "The key's name"]} />
              </Table>
            </div>
            <p className="mt-4">A personal key follows its teammate: change their role and the key changes with it; deactivate them and it stops working. Keys can expire, and revoking one takes effect at once.</p>
            <h3 className="mt-6 mb-2 text-[15px] font-semibold text-primary">Roles</h3>
            <ul className="space-y-1.5">
              {userRoles.map((r) => (
                <li key={r}>
                  <span className="font-medium text-primary">{roleLabels[r]}.</span> {roleHints[r]}
                </li>
              ))}
            </ul>
          </Guide>

          <Guide id="mcp" title="MCP for agents">
            <p>
              The Model Context Protocol lets an AI agent use {name} as a set of tools. Each teammate connects their own agent, which acts as them and can do only what they can. A viewer&apos;s agent, or one approved as read-only, sees only reading tools. Server URL: <SiteUrl path="/api/mcp" /> (Streamable HTTP).
            </p>

            <h3 className="mt-5 mb-1 text-[15px] font-semibold text-primary">Sign in with OAuth</h3>
            <p>
              Most agents connect by signing in: add the server URL, and the agent opens {name} in your browser. Sign in, choose whether it can change records or only read them, and approve. It works with any client that follows the MCP authorization spec, including Claude (claude.ai, the desktop app and Claude Code) and ChatGPT.
            </p>
            <ul className="mt-2 list-disc space-y-1.5 pl-5">
              <li>
                <span className="font-medium text-primary">Claude:</span> Settings → Connectors → Add custom connector, and paste the server URL.
              </li>
              <li>
                <span className="font-medium text-primary">ChatGPT:</span> turn on developer mode in Settings, then add a connector with the server URL and OAuth authentication.
              </li>
              <li>
                <span className="font-medium text-primary">Claude Code:</span> add the server, then run <C>/mcp</C> and choose it to sign in.
              </li>
              <li>
                <span className="font-medium text-primary">Other agents:</span> add a remote MCP server with the URL. Leave the client ID and secret blank; the agent registers itself.
              </li>
            </ul>
            <CodeBlock label="Claude Code" code={`claude mcp add --transport http crm "$CRM_URL/api/mcp"`} />
            <p>
              Connected apps are listed in{" "}
              <Link href="/settings/api" className="text-primary underline underline-offset-2">
                Settings → API and MCP
              </Link>
              , where you can disconnect them. Access tokens last an hour and renew on their own; an app that goes unused for 30 days has to sign in again.
            </p>

            <h3 className="mt-6 mb-1 text-[15px] font-semibold text-primary">Or use a key</h3>
            <p>For clients that take a header instead of signing in, create a key in Settings → API and MCP and send it as a bearer token.</p>
            <CodeBlock label="Cursor, Windsurf and most clients (mcp.json)" code={JSON.stringify({ mcpServers: { crm: { url: "$CRM_URL/api/mcp", headers: { Authorization: "Bearer crm_pk_…" } } } }, null, 2)} />
            <CodeBlock label="VS Code (.vscode/mcp.json)" code={JSON.stringify({ servers: { crm: { type: "http", url: "$CRM_URL/api/mcp", headers: { Authorization: "Bearer crm_pk_…" } } } }, null, 2)} />

            <h3 className="mt-6 mb-1 text-[15px] font-semibold text-primary">For client developers</h3>
            <p>
              OAuth 2.1 with PKCE (S256). Discovery starts from the 401 on <C>/api/mcp</C>, whose <C>WWW-Authenticate</C> header points to <C>/.well-known/oauth-protected-resource/api/mcp</C>; the authorization server metadata is at <C>/.well-known/oauth-authorization-server</C>. Clients register with dynamic client registration (RFC 7591) or identify themselves with a client ID metadata document (an https URL as <C>client_id</C>). Scopes are <C>crm:read</C> and <C>crm:write</C>. Refresh tokens rotate on every use. See the <a href="#tools" className="text-primary underline underline-offset-2">tool list</a> for everything an agent can do.
            </p>
          </Guide>

          <Guide id="conventions" title="Conventions">
            <ul className="list-disc space-y-2 pl-5">
              <li>
                Requests and responses are JSON. A record comes back as <C>{`{ "data": { … } }`}</C>; a list as <C>{`{ "data": [ … ], "nextCursor": "…" }`}</C>.
              </li>
              <li>
                Lists return up to 50 items (<C>limit</C> goes to 100), newest first. Pass <C>nextCursor</C> back as <C>cursor</C> for the next page; it&apos;s null on the last one. Use <C>updatedSince</C> to sync changes.
              </li>
              <li>
                <C>PATCH</C> changes only the fields you send. Send <C>null</C> to clear a field.
              </li>
              <li>
                <C>DELETE</C> on people, organizations and clients archives them: they leave lists and search but keep their history, and <C>POST …/restore</C> brings them back. Tasks, notes and other activity are deleted.
              </li>
              <li>Money is integer cents (12500 is 125.00) in the workspace currency. Dates are YYYY-MM-DD. Times are ISO 8601; send them with an offset.</li>
              <li>Text bodies take HTML (p, strong, em, a, lists, blockquote, code) or plain text, where blank lines start paragraphs. Anything else is removed.</li>
              <li>
                Custom fields go in each record&apos;s <C>custom</C> object, keyed by the field&apos;s <C>key</C> from <C>GET /custom-fields</C>.
              </li>
              <li>Logging activity on a client also shows it on the client&apos;s contact and organization; on a person, also on their organization. Tasks and notes can stand alone.</li>
            </ul>
          </Guide>

          <Guide id="errors" title="Errors and limits">
            <p>
              Failures return <C>{`{ "error": { "code", "message" } }`}</C>. The message is a sentence that says what to do. Validation errors add <C>issues</C>, one per field; a duplicate adds <C>existingId</C>.
            </p>
            <div className="mt-3 overflow-x-auto">
              <Table head={["Status", "Code", "Means"]}>
                <Row cells={["400", "bad_request, invalid_json", "The request can't be done as sent"]} />
                <Row cells={["401", "unauthorized", "No key, or it's revoked, expired or its teammate was deactivated"]} />
                <Row cells={["403", "forbidden", "The key's role doesn't allow it"]} />
                <Row cells={["404", "not_found", "No such record or endpoint"]} />
                <Row cells={["409", "conflict", "It already exists (same email, same organization name)"]} />
                <Row cells={["422", "validation_error", "A field is missing or invalid"]} />
                <Row cells={["429", "rate_limited", "Too many requests; wait for Retry-After seconds"]} />
              </Table>
            </div>
            <p className="mt-3">
              Each key can make {API_RATE_LIMIT_PER_MINUTE} requests a minute, across the API and MCP. Responses carry <C>X-RateLimit-Limit</C> and <C>X-RateLimit-Remaining</C>.
            </p>
          </Guide>

          {tags.map((t) => (
            <section key={t.name} id={anchor(t.name)} className="scroll-mt-20 border-t border-line pt-8 mt-12">
              <h2 className="text-[22px] font-semibold tracking-tight text-primary">{t.name}</h2>
              <p className="mt-1">{t.description}</p>
              {operationList
                .filter((o) => o.tag === t.name)
                .map((o) => (
                  <Endpoint key={o.id} op={o} />
                ))}
            </section>
          ))}

          <section id="models" className="scroll-mt-20 border-t border-line pt-8 mt-12">
            <h2 className="text-[22px] font-semibold tracking-tight text-primary">Models</h2>
            <p className="mt-1">What responses contain.</p>
            {Object.entries(models).map(([modelName, schema]) => (
              <div key={modelName} id={`model-${modelName}`} className="scroll-mt-20 mt-8">
                <h3 className="font-mono text-[15px] font-semibold text-primary">{modelName}</h3>
                <Fields fields={modelFields(schema)} showRequired={false} />
              </div>
            ))}
          </section>

          <section id="tools" className="scroll-mt-20 border-t border-line pt-8 mt-12">
            <h2 className="text-[22px] font-semibold tracking-tight text-primary">MCP tools</h2>
            <p className="mt-1">Each tool runs one endpoint. Its arguments are the endpoint&apos;s path parameters, query parameters and body fields together.</p>
            <div className="mt-4 overflow-x-auto">
              <Table head={["Tool", "Does", "Needs"]}>
                {tools.map((o) => (
                  <tr key={o.id} className="border-t border-line align-top">
                    <td className="py-2 pr-4 font-mono text-[12.5px] text-primary">{o.tool}</td>
                    <td className="py-2 pr-4">
                      <a href={`#${o.id}`} className="hover:text-primary hover:underline">
                        {o.summary}
                      </a>
                    </td>
                    <td className="py-2 text-[13px] text-muted">{o.permission === "records:read" ? "Any role" : "Edit access"}</td>
                  </tr>
                ))}
              </Table>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

function Endpoint({ op }: { op: (typeof operationList)[number] }) {
  const params = fieldsOf(op.params);
  const query = fieldsOf(op.query);
  const body = fieldsOf(op.body);
  return (
    <article id={op.id} className="scroll-mt-20 mt-10">
      <h3 className="text-[16px] font-semibold text-primary">{op.summary}</h3>
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
        <StatusBadge tone={methodTone[op.method]}>{op.method}</StatusBadge>
        <code className="font-mono text-[13px] break-all text-primary">/api/v1{op.path}</code>
      </div>
      {op.description ? <p className="mt-2">{op.description}</p> : null}
      <p className="mt-2 text-[13px] text-muted">
        Needs {permissionLabels[op.permission]}.{op.tool ? <> MCP tool: <C>{op.tool}</C>.</> : null}
      </p>
      {params.length ? <Fields title="Path" fields={params} showRequired={false} /> : null}
      {query.length ? <Fields title="Query" fields={query} /> : null}
      {body.length ? <Fields title="Body" fields={body} /> : null}
      <p className="mt-3 text-[13px]">
        Returns {op.status === 201 ? "201 with " : ""}
        {op.list ? "a list of " : ""}
        <a href={`#model-${op.response}`} className="font-mono text-primary underline underline-offset-2">
          {op.response}
        </a>
        .
      </p>
      <CodeBlock code={curlFor(op)} />
    </article>
  );
}

function Fields({ title, fields, showRequired = true }: { title?: string; fields: FieldDoc[]; showRequired?: boolean }) {
  return (
    <div className="mt-3">
      {title ? <h4 className="mb-1 text-[12px] font-semibold tracking-wide text-muted uppercase">{title}</h4> : null}
      <dl className="divide-y divide-line rounded-lg border border-line bg-surface">
        {fields.map((f) => (
          <div key={f.name} className="grid gap-1 px-3 py-2 sm:grid-cols-[minmax(0,200px)_minmax(0,1fr)] sm:gap-4">
            <dt className="min-w-0">
              <span className="font-mono text-[13px] font-medium text-primary">{f.name}</span>
              {showRequired && f.required ? <span className="ml-1.5 text-[11.5px] font-medium text-error">required</span> : null}
              <span className="block font-mono text-[11.5px] break-words text-muted">{f.type}</span>
            </dt>
            <dd className="min-w-0 text-[13.5px]">{f.description ?? <span className="text-faint">—</span>}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Guide({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 mt-10">
      <h2 className="mb-3 text-[20px] font-semibold tracking-tight text-primary">{title}</h2>
      {children}
    </section>
  );
}

function NavGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-5">
      <p className="mb-1 px-2 text-[11.5px] font-semibold tracking-wide text-faint uppercase">{title}</p>
      <ul>{children}</ul>
    </div>
  );
}

function NavLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <li>
      <a href={href} className="block rounded-md px-2 py-1 text-secondary hover:bg-sunken hover:text-primary">
        {children}
      </a>
    </li>
  );
}

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <table className="w-full text-left text-[13.5px]">
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h} className="pb-2 pr-4 text-[12px] font-semibold text-muted">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

function Row({ cells }: { cells: string[] }) {
  return (
    <tr className="border-t border-line align-top">
      {cells.map((c, i) => (
        <td key={i} className={i === 0 ? "py-2 pr-4 font-medium text-primary" : "py-2 pr-4"}>
          {c}
        </td>
      ))}
    </tr>
  );
}

function C({ children }: { children: ReactNode }) {
  return <code className="rounded bg-sunken px-1 py-0.5 font-mono text-[12.5px] text-primary">{children}</code>;
}
