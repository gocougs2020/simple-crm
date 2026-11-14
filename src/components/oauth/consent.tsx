"use client";

import { useState, useTransition } from "react";
import { decideAuthorization } from "@/actions/oauth";
import { FormError } from "@/components/auth/auth-frame";
import { Button } from "@/components/ui/button";

/** The approve/decline step of connecting an agent. On a decision the browser goes back to the app, which may be a website or a desktop app. */
export function ConsentForm({
  params,
  appName,
  returnTo,
  userName,
  roleLabel,
  canWrite,
  askedReadOnly,
}: {
  params: Record<string, string>;
  appName: string;
  returnTo: string;
  userName: string;
  roleLabel: string;
  canWrite: boolean;
  askedReadOnly: boolean;
}) {
  const writeOffered = canWrite && !askedReadOnly;
  const [readOnly, setReadOnly] = useState(!writeOffered);
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  const [sent, setSent] = useState(false);
  const decide = (approve: boolean) =>
    start(async () => {
      setError(undefined);
      const r = await decideAuthorization(params, approve, readOnly);
      if (!r.ok) return setError(r.error);
      setSent(true);
      window.location.assign(r.data.url);
    });

  if (sent) return <p className="text-[14px] text-secondary">Going back to {appName}. If nothing happens, you can close this tab.</p>;

  return (
    <div className="grid gap-5 text-[14px]">
      <p className="text-secondary">
        It will act as <span className="font-medium text-primary">{userName}</span> ({roleLabel.toLowerCase()}). Everything it changes shows in history as you, via {appName}.
      </p>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-[13px] font-medium text-secondary">Access</legend>
        {writeOffered ? (
          <Choice checked={!readOnly} onChange={() => setReadOnly(false)} title="Read and change records" hint="Add and edit people, organizations, clients, tasks and notes, like you can." />
        ) : null}
        <Choice checked={readOnly} onChange={() => setReadOnly(true)} title="Read only" hint={writeOffered ? "See records, but not change anything." : canWrite ? `${appName} asked only to read.` : "Your role can see records but not change them."} />
      </fieldset>

      <p className="rounded-md border border-line bg-sunken px-3 py-2 text-[12.5px] text-muted">
        You&apos;ll go back to <span className="font-medium text-secondary">{returnTo}</span>. Only continue if you started connecting from {appName}. You can disconnect it any time in Settings → API and MCP.
      </p>

      <FormError message={error} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={pending} onClick={() => decide(false)}>
          Cancel
        </Button>
        <Button variant="primary" loading={pending} onClick={() => decide(true)}>
          Allow
        </Button>
      </div>
    </div>
  );
}

function Choice({ checked, onChange, title, hint }: { checked: boolean; onChange: () => void; title: string; hint: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-line px-3 py-2.5 has-[:checked]:border-ring has-[:checked]:bg-accent-soft">
      <input type="radio" name="access" checked={checked} onChange={onChange} className="mt-1 accent-[var(--accent)]" />
      <span>
        <span className="block font-medium text-primary">{title}</span>
        <span className="block text-[12.5px] text-muted">{hint}</span>
      </span>
    </label>
  );
}
