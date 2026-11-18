"use client";

import clsx from "clsx";
import { useState, useTransition } from "react";
import { PlusIcon } from "@heroicons/react/20/solid";
import { deleteLabel, saveLabel, setLabelHidden } from "@/actions/settings";
import { Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Textarea } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import type { Label } from "@/lib/crm/labels";
import { Section } from "./nav";

type Usage = Record<string, { people: number; organizations: number; clients: number }>;

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
/** "12 people · 3 organizations", or null when nothing has the label. */
function usageText(u: Usage[string] | undefined) {
  if (!u) return null;
  return [u.people ? plural(u.people, "person", "people") : null, u.organizations ? plural(u.organizations, "organization", "organizations") : null, u.clients ? plural(u.clients, "client", "clients") : null].filter(Boolean).join(" · ") || null;
}

/**
 * The workspace's labels: what each is called, what the team means by it,
 * and whether the app shows it. The description appears when someone hovers
 * the label on a record and in the picker, and the agent reads it.
 */
export function LabelSettings({ labels, usage }: { labels: Label[]; usage: Usage }) {
  const [editing, setEditing] = useState<Label | "new" | null>(null);
  const [, start] = useTransition();
  return (
    <>
      <Section
        title="Labels"
        description="Labels go on people, organizations and clients, and an organization's labels carry to everyone at it. Say what each one means: the description shows when someone hovers the label, and the agent reads it."
        action={
          <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
            <PlusIcon />
            Add label
          </Button>
        }
      >
        {labels.length ? (
          <ul className="divide-y divide-line">
            {labels.map((l) => (
              <li key={l.name} className="flex items-center gap-3 px-4 py-2.5">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing(l)} aria-label={`Edit ${l.name}`}>
                  <span className="flex items-center gap-2">
                    <Tag className={clsx(l.hidden && "opacity-60")}>{l.name}</Tag>
                    <span className="text-[12px] text-muted tabular-nums">{usageText(usage[l.name]) ?? "Not in use"}</span>
                  </span>
                  <span className={clsx("mt-1 block text-[12.5px]", l.description ? "text-secondary" : "text-faint")}>{l.description ?? "No description yet. Add one so the team and the agent know what it means."}</span>
                </button>
                <button
                  type="button"
                  role="switch"
                  aria-checked={!l.hidden}
                  aria-label={`Show ${l.name} in the app`}
                  onClick={() =>
                    start(async () => {
                      const r = await setLabelHidden(l.name, !l.hidden);
                      if (!r.ok) toast.error(r.error);
                      else toast.success(l.hidden ? `${l.name} is shown again` : `${l.name} is hidden`);
                    })
                  }
                  className={clsx("relative h-5 w-9 shrink-0 rounded-full border transition-colors", l.hidden ? "border-line-strong bg-sunken" : "border-accent bg-accent")}
                >
                  <span className={clsx("absolute top-0.5 size-3.5 rounded-full bg-surface shadow-sm transition-[left]", l.hidden ? "left-0.5" : "left-[1.125rem]")} />
                </button>
                <span className="w-14 text-[12.5px] text-muted">{l.hidden ? "Hidden" : "Shown"}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-6 text-center text-[13px] text-muted">No labels yet. Add one, like &ldquo;vip&rdquo; or &ldquo;referral partner&rdquo;, then pick it on a record.</p>
        )}
      </Section>
      {editing ? <LabelDialog label={editing === "new" ? null : editing} inUse={editing === "new" ? null : usageText(usage[editing.name])} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

function LabelDialog({ label, inUse, onClose }: { label: Label | null; inUse: string | null; onClose: () => void }) {
  const [name, setName] = useState(label?.name ?? "");
  const [description, setDescription] = useState(label?.description ?? "");
  const [shown, setShown] = useState(!label?.hidden);
  const [pending, start] = useTransition();
  const renamed = !!label && name.trim().toLowerCase() !== label.name;
  const save = () =>
    start(async () => {
      const r = await saveLabel(label?.name ?? null, { name, description, hidden: !shown });
      if (!r.ok) return void toast.error(r.error);
      toast.success(label ? "Label saved" : `${r.data.name} added`);
      onClose();
    });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={label ? `Edit ${label.name}` : "Add a label"}
      description={label && inUse ? `On ${inUse}.${renamed ? " Renaming it changes it on all of them, and in audiences that use it." : ""}` : undefined}
      size="sm"
      footer={
        <>
          {label ? (
            <Button
              variant="ghost"
              className="mr-auto text-error"
              onClick={() => {
                if (!confirm(inUse ? `Delete ${label.name}? It comes off ${inUse} and out of any audience that uses it. This can't be undone.` : `Delete ${label.name}? This can't be undone.`)) return;
                start(async () => {
                  const r = await deleteLabel(label.name);
                  if (!r.ok) return void toast.error(r.error);
                  toast.success(`${label.name} deleted`);
                  onClose();
                });
              }}
            >
              Delete
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={save}>
            {label ? "Save" : "Add label"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name" hint="Lowercase, up to 40 characters.">
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value.toLowerCase())} autoFocus={!label} maxLength={40} placeholder="vip" autoComplete="off" />}
        </Field>
        <Field label="Description" optional hint="What the team means by it, and when to use it.">
          {(p) => <Textarea {...p} value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={500} placeholder="Top accounts: answer within the hour and loop in their owner." />}
        </Field>
        <Checkbox checked={shown} onChange={(e) => setShown(e.target.checked)} label={<span className="text-[13.5px]">Show in the app</span>} />
        {!shown ? <p className="-mt-2 text-fine">Hidden labels stay on their records, but nobody sees them or can pick them, and lists and audiences don&apos;t offer them.</p> : null}
      </div>
    </Dialog>
  );
}
