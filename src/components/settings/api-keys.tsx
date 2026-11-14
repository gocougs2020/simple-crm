"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ArrowTopRightOnSquareIcon, CheckIcon, ClipboardDocumentIcon, KeyIcon, PlusIcon } from "@heroicons/react/20/solid";
import { createApiKey, revokeApiKey } from "@/actions/api-keys";
import { useApp } from "@/components/app-context";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import type { ApiKeyKind, ManualKeyKind } from "@/lib/constants";
import { formatAgo, formatDay } from "@/lib/format";
import { roleCan } from "@/lib/permissions";
import { Section } from "./nav";

export type KeyRow = { id: string; name: string; prefix: string; kind: ApiKeyKind; userName: string | null; createdAt: Date; lastUsedAt: Date | null; expiresAt: Date | null; readOnly: boolean };

export function ApiSettings({ origin, mine, apps, workspace, teammates }: { origin: string; mine: KeyRow[]; apps: KeyRow[]; workspace: KeyRow[] | null; teammates: KeyRow[] | null }) {
  const { viewer } = useApp();
  const [creating, setCreating] = useState<ManualKeyKind | null>(null);
  const readOnly = !roleCan(viewer.role, "records:write");
  return (
    <>
      <Section
        title="Connect an agent"
        description={
          <>
            Add this server to Claude, ChatGPT, Cursor or any MCP client. It asks you to sign in and approve, then acts as you, with your role&apos;s access{readOnly ? " (read-only)" : ""}. Everything it changes is recorded as you.
          </>
        }
      >
        <div className="grid gap-2 px-4 py-4 text-[13.5px] text-secondary">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted">Server URL</span>
            <Code>{`${origin}/api/mcp`}</Code>
            <CopyButton text={`${origin}/api/mcp`} />
          </div>
          <p className="text-[13px] text-muted">
            In Claude, add it under Settings → Connectors → Add custom connector. In ChatGPT, add it as a connector (developer mode). Step-by-step setup for each app is in the{" "}
            <Link href="/developers#mcp" className="text-primary underline underline-offset-2">
              MCP guide
            </Link>
            .
          </p>
        </div>
      </Section>

      <Section title="Connected apps" description="Agents you approved. Each acts as you; disconnecting one stops it at once.">
        <KeyList rows={apps} empty="No apps connected yet." action="Disconnect" />
      </Section>

      <Section
        title="MCP keys"
        description={
          <>
            For agents that take a key instead of signing in, and for your own scripts with the{" "}
            <Link href="/developers" className="text-primary underline underline-offset-2">
              REST API
            </Link>
            . A key acts as you.
          </>
        }
        action={
          <Button onClick={() => setCreating("personal")}>
            <PlusIcon />
            Create key
          </Button>
        }
      >
        <KeyList rows={mine} empty="No keys. Create one for each agent or computer, so you can revoke them one at a time." />
      </Section>

      {workspace ? (
        <Section
          title="Workspace API keys"
          description="For integrations and scripts. A workspace key has full access to every record and isn't tied to a person, so it can't be used with MCP. Changes it makes show the key's name in history."
          action={
            <Button onClick={() => setCreating("workspace")}>
              <PlusIcon />
              Create workspace key
            </Button>
          }
        >
          <KeyList rows={workspace} empty="No workspace keys. Create one when an integration needs to read or write records." />
        </Section>
      ) : null}

      {teammates?.length ? (
        <Section title="Teammates' keys and apps" description="Personal keys and connected apps your teammates made. Each acts with its owner's role. Revoke any that shouldn't work anymore.">
          <KeyList rows={teammates} showOwner />
        </Section>
      ) : null}

      <p className="flex items-center gap-1.5 text-[13px] text-muted">
        <ArrowTopRightOnSquareIcon className="size-4" />
        <Link href="/developers" className="text-primary underline underline-offset-2">
          API and MCP docs
        </Link>
        : every endpoint, with examples and setup for each agent.
      </p>

      {creating ? <CreateKeyDialog kind={creating} origin={origin} onClose={() => setCreating(null)} /> : null}
    </>
  );
}

/** "Today" and "Tomorrow" read mid-sentence in lowercase; dates keep their capital. */
const relativeDay = (s: string) => (s === "Today" || s === "Tomorrow" ? s.toLowerCase() : s);

function KeyList({ rows, empty, showOwner, action = "Revoke" }: { rows: KeyRow[]; empty?: string; showOwner?: boolean; action?: string }) {
  const { workspace } = useApp();
  const [pending, start] = useTransition();
  if (!rows.length) return <p className="px-4 py-6 text-[13.5px] text-muted">{empty}</p>;
  const tz = workspace.timezone;
  return (
    <ul className="divide-y divide-line">
      {rows.map((k) => {
        const expired = !!k.expiresAt && new Date(k.expiresAt) <= new Date();
        return (
          // On phones the badges and button wrap under the name instead of squeezing it.
          <li key={k.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3">
            <KeyIcon className="size-4 shrink-0 text-faint" />
            <div className="min-w-[12rem] flex-1">
              <p className="truncate text-[14px] font-medium text-primary">
                {k.name}
                {showOwner && k.userName ? <span className="font-normal text-muted"> · {k.userName}</span> : null}
              </p>
              <p className="text-[12.5px] text-muted sm:truncate" suppressHydrationWarning>
                {k.kind === "oauth" ? <span>Connected app · {k.prefix}</span> : <span className="font-mono">{k.prefix}…</span>} · {k.kind === "oauth" ? "Connected" : "Created"} {formatAgo(k.createdAt, tz)} · {k.lastUsedAt ? `Last used ${formatAgo(k.lastUsedAt, tz)}` : "Never used"}
                {k.expiresAt && !expired ? ` · Expires ${relativeDay(formatDay(k.expiresAt, tz))}` : ""}
              </p>
            </div>
            {k.readOnly ? <StatusBadge>Read only</StatusBadge> : null}
            {expired ? <StatusBadge tone="warning">Expired</StatusBadge> : null}
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              aria-label={`${k.kind === "oauth" ? "Disconnect" : action} ${k.name}`}
              onClick={() =>
                start(async () => {
                  if (!confirm(k.kind === "oauth" ? `Disconnect ${k.name}? It stops working right away; connect again to use it.` : `Revoke “${k.name}”? Anything using it stops working right away.`)) return;
                  const r = await revokeApiKey(k.id);
                  if (r.ok) toast.success(k.kind === "oauth" ? `${k.name} disconnected` : `${k.name} revoked`);
                  else toast.error(r.error);
                })
              }
            >
              {k.kind === "oauth" ? "Disconnect" : action}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

const expiries = [
  { value: "", label: "Never" },
  { value: "30", label: "In 30 days" },
  { value: "90", label: "In 90 days" },
  { value: "365", label: "In a year" },
];

function CreateKeyDialog({ kind, origin, onClose }: { kind: ManualKeyKind; origin: string; onClose: () => void }) {
  const { viewer } = useApp();
  const [name, setName] = useState("");
  const [expires, setExpires] = useState(kind === "personal" ? "90" : "");
  const canWrite = roleCan(viewer.role, "records:write");
  const [access, setAccess] = useState<"write" | "read">(canWrite ? "write" : "read");
  const [token, setToken] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const personal = kind === "personal";
  const submit = () =>
    start(async () => {
      const r = await createApiKey({ kind, name, expiresInDays: expires ? (Number(expires) as 30 | 90 | 365) : null, readOnly: access === "read" });
      if (!r.ok) return void toast.error(r.error);
      setToken(r.data.token);
    });

  if (token)
    return (
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        title={personal ? "Connect your agent" : "Your workspace key"}
        description="Copy the key now. It won't be shown again; if you lose it, revoke it and make a new one."
        size="lg"
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <div className="grid gap-5">
          <Snippet label="Key" text={token} />
          {personal ? (
            <>
              <Snippet label="Claude Code" text={`claude mcp add --transport http crm ${origin}/api/mcp --header "Authorization: Bearer ${token}"`} />
              <Snippet
                label="Cursor, Windsurf and other clients (mcp.json)"
                text={JSON.stringify({ mcpServers: { crm: { url: `${origin}/api/mcp`, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)}
              />
              <p className="text-[13px] text-muted">
                Any client that supports remote MCP servers over HTTP with a custom header works the same way. See the{" "}
                <Link href="/developers#mcp" className="text-primary underline underline-offset-2">
                  MCP setup guide
                </Link>{" "}
                for more.
              </p>
            </>
          ) : (
            <Snippet label="Try it" text={`curl ${origin}/api/v1/me -H "Authorization: Bearer ${token}"`} />
          )}
        </div>
      </Dialog>
    );

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={personal ? "Create a key" : "Create a workspace key"}
      description={personal ? "The key acts as you. Make one per agent or computer." : "Full access to every record, for an integration or script. Keep it on a server, never in a browser or an app people can download."}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={submit}>
            Create key
          </Button>
        </>
      }
    >
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Name" hint={personal ? "Where it's used, like “Claude Code on my laptop”." : "What uses it, like “Website signup form”."}>
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />}
        </Field>
        {personal && canWrite ? (
          <Field label="Access" hint={access === "read" ? "Can see records but not change them." : "Can do what you can."}>
            {(p) => (
              <Select id={p.id} value={access} onChange={(e) => setAccess(e.target.value as "write" | "read")}>
                <option value="write">Read and change records</option>
                <option value="read">Read only</option>
              </Select>
            )}
          </Field>
        ) : null}
        <Field label="Expires">
          {(p) => (
            <Select id={p.id} value={expires} onChange={(e) => setExpires(e.target.value)}>
              {expiries.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function Snippet({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[13px] font-medium text-secondary">{label}</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              toast.error("Couldn't copy. Select the text and copy it instead.");
            }
          }}
        >
          {copied ? <CheckIcon /> : <ClipboardDocumentIcon />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-md border border-line bg-sunken px-3 py-2 font-mono text-[12.5px] whitespace-pre-wrap break-all text-primary">{text}</pre>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Couldn't copy. Select the text and copy it instead.");
        }
      }}
    >
      {copied ? <CheckIcon /> : <ClipboardDocumentIcon />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function Code({ children }: { children: string }) {
  return <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[12.5px] text-primary">{children}</code>;
}
