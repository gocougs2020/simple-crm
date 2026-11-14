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
import type { ApiKeyKind } from "@/lib/constants";
import { formatAgo, formatDay } from "@/lib/format";
import { roleCan } from "@/lib/permissions";
import { Section } from "./nav";

export type KeyRow = { id: string; name: string; prefix: string; kind: ApiKeyKind; userName: string | null; createdAt: Date; lastUsedAt: Date | null; expiresAt: Date | null };

export function ApiSettings({ origin, mine, workspace, teammates }: { origin: string; mine: KeyRow[]; workspace: KeyRow[] | null; teammates: KeyRow[] | null }) {
  const { viewer } = useApp();
  const [creating, setCreating] = useState<ApiKeyKind | null>(null);
  const readOnly = !roleCan(viewer.role, "records:write");
  return (
    <>
      <Section
        title="MCP access"
        description={
          <>
            Connect an AI agent, like Claude or Cursor, to the CRM. It acts as you, with your role&apos;s access{readOnly ? " (read-only)" : ""}, and everything it changes is recorded as you. Your key also works with the{" "}
            <Link href="/developers" className="text-primary underline underline-offset-2">
              REST API
            </Link>
            .
          </>
        }
        action={
          <Button variant="primary" onClick={() => setCreating("personal")}>
            <PlusIcon />
            Create MCP key
          </Button>
        }
      >
        <KeyList rows={mine} empty="No keys yet. Create one for each agent or computer, so you can revoke them one at a time." />
        <div className="border-t border-line px-4 py-3 text-[13px] text-muted">
          Server URL <Code>{`${origin}/api/mcp`}</Code>
        </div>
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
        <Section title="Teammates' keys" description="Personal keys your teammates made. Each acts with its owner's role. Revoke any that shouldn't work anymore.">
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

function KeyList({ rows, empty, showOwner }: { rows: KeyRow[]; empty?: string; showOwner?: boolean }) {
  const { workspace } = useApp();
  const [pending, start] = useTransition();
  if (!rows.length) return <p className="px-4 py-6 text-[13.5px] text-muted">{empty}</p>;
  const tz = workspace.timezone;
  return (
    <ul className="divide-y divide-line">
      {rows.map((k) => {
        const expired = !!k.expiresAt && new Date(k.expiresAt) <= new Date();
        return (
          <li key={k.id} className="flex items-center gap-3 px-4 py-3">
            <KeyIcon className="size-4 shrink-0 text-faint" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-medium text-primary">
                {k.name}
                {showOwner && k.userName ? <span className="font-normal text-muted"> · {k.userName}</span> : null}
              </p>
              <p className="truncate text-[12.5px] text-muted" suppressHydrationWarning>
                <span className="font-mono">{k.prefix}…</span> · Created {formatAgo(k.createdAt, tz)} · {k.lastUsedAt ? `Last used ${formatAgo(k.lastUsedAt, tz)}` : "Never used"}
                {k.expiresAt && !expired ? ` · Expires ${formatDay(k.expiresAt, tz).toLowerCase()}` : ""}
              </p>
            </div>
            {expired ? <StatusBadge tone="warning">Expired</StatusBadge> : null}
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  if (!confirm(`Revoke “${k.name}”? Anything using it stops working right away.`)) return;
                  const r = await revokeApiKey(k.id);
                  if (r.ok) toast.success(`${k.name} revoked`);
                  else toast.error(r.error);
                })
              }
            >
              Revoke
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

function CreateKeyDialog({ kind, origin, onClose }: { kind: ApiKeyKind; origin: string; onClose: () => void }) {
  const [name, setName] = useState("");
  const [expires, setExpires] = useState(kind === "personal" ? "90" : "");
  const [token, setToken] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const personal = kind === "personal";
  const submit = () =>
    start(async () => {
      const r = await createApiKey({ kind, name, expiresInDays: expires ? (Number(expires) as 30 | 90 | 365) : null });
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
      title={personal ? "Create an MCP key" : "Create a workspace key"}
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

function Code({ children }: { children: string }) {
  return <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[12.5px] text-primary">{children}</code>;
}
