"use client";

import { useState, useTransition } from "react";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, ClipboardDocumentIcon, PlusIcon, TrashIcon } from "@heroicons/react/20/solid";
import { addDomain, connectWebhook, createInbox, removeDomain, removeInbox, setDomainCapability, syncNow, updateInbox, verifyDomain } from "@/actions/inbox";
import { StatusBadge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Select } from "@/components/ui/field";
import { Tooltip } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { Section } from "./nav";

export type DomainView = {
  id: string;
  name: string;
  status: string;
  region: string;
  sending: boolean;
  receiving: boolean;
  records: { record: string; type: string; name: string; value: string; priority: number | null; status: string }[];
};
export type InboxView = { id: string; address: string; name: string | null; fromName: string | null; unread: number };
type Webhook = { connected: boolean; endpoint: string | null; envSecret: boolean };

const statusTone = (s: string): Tone => (s === "verified" ? "success" : s === "failed" || s === "partially_failed" ? "error" : s === "pending" || s === "partially_verified" ? "warning" : "neutral");
const statusLabel = (s: string) => ({ verified: "Verified", failed: "Failed", partially_failed: "Partly failed", pending: "Checking", partially_verified: "Partly verified", not_started: "Not verified", temporary_failure: "Retrying" })[s] ?? s;
const regions = [
  { value: "us-east-1", label: "North America (us-east-1)" },
  { value: "eu-west-1", label: "Europe (eu-west-1)" },
  { value: "sa-east-1", label: "South America (sa-east-1)" },
  { value: "ap-northeast-1", label: "Asia Pacific (ap-northeast-1)" },
] as const;

type R = { ok: true } | { ok: false; error: string } | { ok: boolean; error?: string };
function useAct() {
  const [pending, start] = useTransition();
  const act = (fn: () => Promise<R>, message: string, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) return void toast.error("error" in r && r.error ? r.error : "Something went wrong.");
      toast.success(message);
      after?.();
    });
  return { pending, act };
}

/**
 * Sending and receiving domains, team inboxes and the webhook that brings new
 * mail in, all managed in Resend through its API. Nothing here is stored in
 * the CRM except which webhook it connected.
 */
export function EmailDomainSettings({
  configured,
  domains,
  domainsError,
  inboxes,
  inboxesError,
  webhook,
}: {
  configured: boolean;
  domains: DomainView[];
  domainsError: string | null;
  inboxes: InboxView[];
  inboxesError: string | null;
  webhook: Webhook;
}) {
  if (!configured)
    return (
      <Section title="Connect Resend" description="Domains and inboxes are managed in Resend, through its API.">
        <div className="px-4 py-4 text-[13.5px] text-secondary">
          <ol className="list-decimal space-y-1 pl-5">
            <li>Create an API key with full access in the Resend dashboard.</li>
            <li>
              Add it to the environment as <code className="font-mono text-[12.5px]">RESEND_API_KEY</code> and redeploy (or restart <code className="font-mono text-[12.5px]">pnpm dev</code>).
            </li>
            <li>Come back here to add your domains and team inboxes.</li>
          </ol>
        </div>
      </Section>
    );
  return (
    <>
      <Domains domains={domains} error={domainsError} />
      <Inboxes inboxes={inboxes} error={inboxesError} domains={domains} />
      <LiveUpdates webhook={webhook} />
    </>
  );
}

function ErrorLine({ error }: { error: string }) {
  return <p className="px-4 py-3 text-[13px] text-error">Resend couldn&apos;t load this: {error}. Check the API key, then reload.</p>;
}

// ─── Domains ─────────────────────────────────────────────────────────────

function Domains({ domains, error }: { domains: DomainView[]; error: string | null }) {
  const [adding, setAdding] = useState(false);
  return (
    <Section
      title="Domains"
      description="Each domain needs the DNS records below before it can send. Turn on receiving to get mail into inboxes on that domain."
      action={
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <PlusIcon />
          Add domain
        </Button>
      }
    >
      {error ? <ErrorLine error={error} /> : null}
      {!error && !domains.length ? <p className="px-4 py-3 text-[13px] text-muted">No domains yet. Add one like mail.yourcompany.com to send and receive as your own brand.</p> : null}
      <ul className="divide-y divide-line">
        {domains.map((d) => (
          <DomainRow key={d.id} domain={d} />
        ))}
      </ul>
      {adding ? <AddDomain onClose={() => setAdding(false)} /> : null}
    </Section>
  );
}

function DomainRow({ domain: d }: { domain: DomainView }) {
  const [open, setOpen] = useState(d.status !== "verified");
  const { pending, act } = useAct();
  return (
    <li>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <button type="button" onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" aria-expanded={open}>
          {open ? <ChevronDownIcon className="size-4 text-faint" /> : <ChevronRightIcon className="size-4 text-faint" />}
          <span className="truncate text-[14px] font-medium text-primary">{d.name}</span>
          <StatusBadge tone={statusTone(d.status)}>{statusLabel(d.status)}</StatusBadge>
          <span className="hidden text-[12px] text-muted sm:inline">{d.region}</span>
        </button>
        <Checkbox checked={d.sending} disabled={pending} onChange={(e) => act(() => setDomainCapability(d.id, "sending", e.target.checked), e.target.checked ? "Sending turned on" : "Sending turned off")} label={<span className="text-[13px]">Sending</span>} />
        <Checkbox
          checked={d.receiving}
          disabled={pending}
          onChange={(e) => act(() => setDomainCapability(d.id, "receiving", e.target.checked), e.target.checked ? "Receiving turned on. Add the MX record, then verify." : "Receiving turned off")}
          label={<span className="text-[13px]">Receiving</span>}
        />
        <div className="flex gap-1">
          {d.status !== "verified" ? (
            <Button size="sm" variant="outline" loading={pending} onClick={() => act(() => verifyDomain(d.id), "Verification started. DNS changes can take a few minutes to show up.")}>
              Verify
            </Button>
          ) : null}
          <Tooltip content="Remove domain">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove ${d.name}`}
              disabled={pending}
              onClick={() => {
                if (confirm(`Remove ${d.name} from Resend? Email from and to this domain stops working.`)) act(() => removeDomain(d.id), `${d.name} removed`);
              }}
            >
              <TrashIcon />
            </Button>
          </Tooltip>
        </div>
      </div>
      {open ? <DnsRecords records={d.records} /> : null}
    </li>
  );
}

function DnsRecords({ records }: { records: DomainView["records"] }) {
  if (!records.length) return <p className="px-4 pb-3 text-[13px] text-muted">Resend hasn&apos;t listed any DNS records for this domain yet. Reload in a moment.</p>;
  return (
    <div className="px-4 pb-4">
      <p className="mb-2 text-[12.5px] text-muted">Add these at your DNS provider, then press Verify.</p>
      <div className="overflow-x-auto rounded-lg border border-line scroll-thin">
        <table className="w-full text-[12.5px]">
          <thead className="bg-sunken text-left text-table-header">
            <tr>
              <th className="px-2.5 py-1.5">For</th>
              <th className="px-2.5 py-1.5">Type</th>
              <th className="px-2.5 py-1.5">Name</th>
              <th className="px-2.5 py-1.5">Value</th>
              <th className="px-2.5 py-1.5">Priority</th>
              <th className="px-2.5 py-1.5">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {records.map((r, i) => (
              <tr key={i} className="align-top">
                <td className="px-2.5 py-1.5 whitespace-nowrap text-secondary">{r.record}</td>
                <td className="px-2.5 py-1.5 font-mono">{r.type}</td>
                <td className="px-2.5 py-1.5">
                  <Copyable value={r.name} />
                </td>
                <td className="max-w-80 px-2.5 py-1.5">
                  <Copyable value={r.value} />
                </td>
                <td className="px-2.5 py-1.5 tabular-nums">{r.priority ?? "—"}</td>
                <td className="px-2.5 py-1.5">
                  <StatusBadge tone={statusTone(r.status)}>{statusLabel(r.status)}</StatusBadge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Copyable({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex items-start gap-1">
      <code className="min-w-0 font-mono break-all text-primary">{value}</code>
      <button
        type="button"
        className="shrink-0 rounded p-0.5 text-faint hover:bg-sunken hover:text-primary"
        aria-label="Copy"
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <CheckIcon className="size-3.5 text-success" /> : <ClipboardDocumentIcon className="size-3.5" />}
      </button>
    </span>
  );
}

function AddDomain({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [region, setRegion] = useState<(typeof regions)[number]["value"]>("us-east-1");
  const [receiving, setReceiving] = useState(true);
  const { pending, act } = useAct();
  const submit = () => act(() => addDomain({ name, region, receiving }), `${name} added. Add its DNS records, then verify.`, onClose);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add a domain"
      description="A subdomain like mail.yourcompany.com keeps CRM email separate from your main mailboxes."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={submit}>
            Add domain
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Domain">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="mail.yourcompany.com" autoComplete="off" />}</Field>
        <Field label="Region" hint="Where Resend sends from. Pick the one closest to your recipients.">
          {(p) => (
            <Select id={p.id} value={region} onChange={(e) => setRegion(e.target.value as typeof region)}>
              {regions.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Checkbox checked={receiving} onChange={(e) => setReceiving(e.target.checked)} label="Receive email on this domain" />
      </form>
    </Dialog>
  );
}

// ─── Inboxes ─────────────────────────────────────────────────────────────

function Inboxes({ inboxes, error, domains }: { inboxes: InboxView[]; error: string | null; domains: DomainView[] }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<InboxView | null>(null);
  const { pending, act } = useAct();
  const receiving = domains.filter((d) => d.receiving);
  return (
    <Section
      title="Inboxes"
      description="Shared addresses like hello@ or support@. Mail to them shows up in Email → Inbox, linked to the person and client it's from."
      action={
        <Button size="sm" variant="outline" onClick={() => setAdding(true)} disabled={!receiving.length}>
          <PlusIcon />
          Add inbox
        </Button>
      }
    >
      {error ? <ErrorLine error={error} /> : null}
      {!error && !inboxes.length ? (
        <p className="px-4 py-3 text-[13px] text-muted">{receiving.length ? "No inboxes yet. Add one to start receiving mail." : "Turn on receiving for a domain above, then add an inbox on it."}</p>
      ) : null}
      <ul className="divide-y divide-line">
        {inboxes.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-medium text-primary">{i.address}</p>
              <p className="truncate text-[12.5px] text-muted">
                {[i.name, i.fromName ? `Sends as ${i.fromName}` : null].filter(Boolean).join(" · ") || "No name yet"}
                {i.unread ? ` · ${i.unread} unread` : ""}
              </p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setEditing(i)}>
              Edit
            </Button>
            <Tooltip content="Remove inbox">
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Remove ${i.address}`}
                disabled={pending}
                onClick={() => {
                  if (confirm(`Remove ${i.address}? New mail to it stops arriving. Conversations already in the CRM stay on their records.`)) act(() => removeInbox(i.id), `${i.address} removed`);
                }}
              >
                <TrashIcon />
              </Button>
            </Tooltip>
          </li>
        ))}
      </ul>
      {adding ? <AddInbox domains={receiving} onClose={() => setAdding(false)} /> : null}
      {editing ? <EditInbox inbox={editing} onClose={() => setEditing(null)} /> : null}
    </Section>
  );
}

function AddInbox({ domains, onClose }: { domains: DomainView[]; onClose: () => void }) {
  const [localPart, setLocalPart] = useState("");
  const [domain, setDomain] = useState(domains[0]?.name ?? "");
  const [name, setName] = useState("");
  const [fromName, setFromName] = useState("");
  const { pending, act } = useAct();
  const submit = () => act(() => createInbox({ localPart, domain, name, fromName }), `${localPart}@${domain} is ready`, onClose);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add an inbox"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={submit}>
            Add inbox
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Address">
          {(p) => (
            <div className="flex items-center gap-1.5">
              <Input {...p} value={localPart} onChange={(e) => setLocalPart(e.target.value)} placeholder="hello" className="flex-1" autoComplete="off" />
              <span className="text-[14px] text-muted">@</span>
              <Select value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Domain" className="flex-1">
                {domains.map((d) => (
                  <option key={d.id} value={d.name}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </Field>
        <Field label="Name" optional hint="What the team sees, like Sales or Support.">
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Sender name" optional hint="What recipients see in From.">
          {(p) => <Input {...p} value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Acme team" />}
        </Field>
      </form>
    </Dialog>
  );
}

function EditInbox({ inbox, onClose }: { inbox: InboxView; onClose: () => void }) {
  const [name, setName] = useState(inbox.name ?? "");
  const [fromName, setFromName] = useState(inbox.fromName ?? "");
  const { pending, act } = useAct();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Edit ${inbox.address}`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={() => act(() => updateInbox(inbox.id, { name, fromName }), "Inbox saved", onClose)}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Sender name">{(p) => <Input {...p} value={fromName} onChange={(e) => setFromName(e.target.value)} />}</Field>
      </div>
    </Dialog>
  );
}

// ─── Webhook ─────────────────────────────────────────────────────────────

function LiveUpdates({ webhook }: { webhook: Webhook }) {
  const { pending, act } = useAct();
  return (
    <Section title="Live updates" description="A Resend webhook tells the CRM about new mail within seconds. A sync every 15 minutes catches anything it misses.">
      <div className="flex flex-col gap-3 px-4 py-3 text-[13.5px]">
        <div className="flex flex-wrap items-center gap-3">
          {webhook.connected ? <StatusBadge tone="success">Connected</StatusBadge> : <StatusBadge tone="neutral">Not connected</StatusBadge>}
          <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-secondary">{webhook.endpoint ?? "/api/webhooks/resend"}</span>
          <Button size="sm" variant={webhook.connected ? "outline" : "primary"} loading={pending} onClick={() => act(async () => connectWebhook(), "Webhook connected. New mail will show up within seconds.")}>
            {webhook.connected ? "Reconnect" : "Connect webhook"}
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(async () => syncNow(), "Inboxes synced")}>
            Sync now
          </Button>
        </div>
        <p className="text-fine">
          Connecting creates a webhook in Resend pointed at this site&apos;s /api/webhooks/resend and saves its signing secret. If RESEND_WEBHOOK_SECRET is set, it&apos;s used instead
          {webhook.envSecret ? " (it is set here)" : ""}. Resend can&apos;t reach localhost, so while developing use Sync now.
        </p>
      </div>
    </Section>
  );
}
