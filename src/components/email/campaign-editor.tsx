"use client";

import clsx from "clsx";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { ChevronLeftIcon, CodeBracketIcon, ComputerDesktopIcon, DevicePhoneMobileIcon } from "@heroicons/react/20/solid";
import { saveCampaign, scheduleCampaign, sendCampaignTest, unscheduleCampaign } from "@/actions/campaigns";
import { useApp } from "@/components/app-context";
import { Segmented } from "@/components/activity/composer";
import { Tag } from "@/components/ui/badge";
import { Button, Spinner } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { RichText, type RichTextHandle } from "@/components/ui/rich-text";
import { toast } from "@/components/ui/toast";
import type { CampaignAudience } from "@/db/schema";
import { dayFromToday, formatDateTime, formatFull, zonedTime } from "@/lib/format";
import { fillMergeTagsHtml, mergeTagLabels, mergeTags } from "@/lib/email/merge-tags";

export type CampaignData = {
  id: string;
  name: string;
  subject: string;
  previewText: string | null;
  body: string;
  html: string | null;
  audience: CampaignAudience;
  status: "draft" | "scheduled" | "sending" | "sent";
  scheduledAt: Date | null;
  sentAt: Date | null;
  recipientCount: number;
  sendError: string | null;
};

/**
 * Write a campaign on the left, see exactly what will be sent on the right.
 * Saves as you type. The audience is a set of filters evaluated at send time.
 */
export function CampaignEditor({ campaign, tags, initialCount, hasAddress }: { campaign: CampaignData; tags: string[]; initialCount: number; hasAddress: boolean }) {
  const { team, pipelines, workspace, viewer } = useApp();
  const readOnly = campaign.status === "sent" || campaign.status === "sending";
  const [name, setName] = useState(campaign.name);
  const [subject, setSubject] = useState(campaign.subject);
  const [previewText, setPreviewText] = useState(campaign.previewText ?? "");
  const [body, setBody] = useState(campaign.body);
  const [audience, setAudience] = useState<CampaignAudience>(campaign.audience);
  const [count, setCount] = useState(initialCount);
  const [html, setHtml] = useState(campaign.html);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [device, setDevice] = useState<"desktop" | "phone">("desktop");
  const [scheduling, setScheduling] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);
  const [pending, start] = useTransition();
  const editor = useRef<RichTextHandle>(null);
  const first = useRef(true);
  const tz = workspace.timezone;

  // Autosave, debounced. The preview re-renders from the saved HTML.
  useEffect(() => {
    if (readOnly) return;
    if (first.current) {
      first.current = false;
      return;
    }
    setSaving("saving");
    const t = setTimeout(async () => {
      const r = await saveCampaign(campaign.id, { name: name || "Untitled campaign", subject, previewText: previewText || null, body, audience });
      if (!r.ok) {
        setSaving("error");
        return void toast.error(r.error);
      }
      setCount(r.data.recipients);
      setHtml(r.data.html);
      setSaving("saved");
    }, 700);
    return () => clearTimeout(t);
  }, [name, subject, previewText, body, audience, campaign.id, readOnly]);

  // A sample recipient for the preview: you.
  const sample = { first_name: viewer.name.split(" ")[0], last_name: viewer.name.split(" ").slice(1).join(" "), full_name: viewer.name, company: workspace.name };
  const previewHtml = fillMergeTagsHtml(html ?? "", sample);

  const toggle = (key: keyof Omit<CampaignAudience, "personIds">, value: string) =>
    setAudience((a) => {
      const list = (a[key] ?? []) as string[];
      return { ...a, [key]: list.includes(value) ? list.filter((x) => x !== value) : [...list, value] };
    });

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5 lg:px-6">
        <Link href="/email" className="flex items-center gap-1 text-[13px] text-muted hover:text-primary">
          <ChevronLeftIcon className="size-4" />
          Campaigns
        </Link>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={readOnly}
          aria-label="Campaign name"
          className="min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 text-[16px] font-semibold text-primary outline-none hover:bg-sunken focus:bg-sunken disabled:hover:bg-transparent"
        />
        <span className="text-[12px] text-muted" aria-live="polite">
          {saving === "saving" ? "Saving…" : saving === "saved" ? "Saved" : saving === "error" ? "Not saved" : ""}
        </span>
        {campaign.status !== "draft" ? (
          <StatusBadge tone={campaign.status === "sent" ? "success" : campaign.status === "scheduled" ? "info" : "warning"}>
            {campaign.status === "sent" ? `Sent ${campaign.sentAt ? formatDateTime(campaign.sentAt, tz) : ""}` : campaign.status === "scheduled" ? `Scheduled ${campaign.scheduledAt ? formatDateTime(campaign.scheduledAt, tz) : ""}` : "Sending"}
          </StatusBadge>
        ) : null}
        {!readOnly ? (
          <>
            <Button
              variant="ghost"
              loading={pending}
              onClick={() =>
                start(async () => {
                  const r = await sendCampaignTest(campaign.id);
                  if (r.ok) toast.success(`Test sent to ${r.data.to}`);
                  else toast.error(r.error);
                })
              }
            >
              Send test
            </Button>
            {campaign.status === "scheduled" ? (
              <Button variant="outline" onClick={() => start(async () => void (await unscheduleCampaign(campaign.id)))}>
                Unschedule
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setScheduling(true)}>
                Schedule
              </Button>
            )}
            <Button variant="primary" onClick={() => setConfirmSend(true)} disabled={!count || !subject.trim()}>
              Send now
            </Button>
          </>
        ) : null}
      </header>
      {campaign.sendError ? <p className="border-b border-error-border bg-error-surface px-6 py-2 text-[13px] text-error">The last send attempt stopped: {campaign.sendError}</p> : null}
      {!hasAddress && !readOnly ? (
        <p className="border-b border-warning-border bg-warning-surface px-6 py-2 text-[13px] text-warning">
          Marketing email must include your postal address. <Link href="/settings/brand" className="font-medium underline">Add it in Settings → Email and brand</Link> before sending.
        </p>
      ) : null}

      <div className="grid flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5 border-line p-4 lg:border-r lg:p-6">
          <section className="flex flex-col gap-3">
            <Field label="Subject">{(p) => <Input {...p} value={subject} onChange={(e) => setSubject(e.target.value)} disabled={readOnly} placeholder="What's new at {{company}}" />}</Field>
            <Field label="Preview text" optional hint="Shown after the subject in most inboxes.">
              {(p) => <Input {...p} value={previewText} onChange={(e) => setPreviewText(e.target.value)} disabled={readOnly} />}
            </Field>
          </section>

          <section>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-label">Message</span>
              {!readOnly ? (
                <Menu>
                  <MenuTrigger asChild>
                    <Button size="sm" variant="ghost">
                      <CodeBracketIcon />
                      Insert field
                    </Button>
                  </MenuTrigger>
                  <MenuContent className="w-52">
                    <MenuLabel>Filled in for each person</MenuLabel>
                    {mergeTags
                      .filter((t) => !t.startsWith("sender"))
                      .map((t) => (
                        <MenuItem key={t} onSelect={() => editor.current?.insert(`{{${t}}}`)}>
                          {mergeTagLabels[t]}
                        </MenuItem>
                      ))}
                  </MenuContent>
                </Menu>
              ) : null}
            </div>
            {readOnly ? (
              <div className="prose-crm rounded-md border border-line px-3 py-2.5" dangerouslySetInnerHTML={{ __html: body }} />
            ) : (
              <RichText handle={editor} value={body} onChange={setBody} minHeight={260} placeholder="Write your email" />
            )}
            <p className="mt-1.5 text-fine">
              Use <code className="font-mono">{"{{first_name|there}}"}</code> to say “there” when someone has no first name. The logo, footer, address and unsubscribe link come from your brand kit.
            </p>
          </section>

          <section>
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-label">Audience</span>
              <span className="text-[13px] text-secondary tabular-nums">
                {count.toLocaleString()} {count === 1 ? "person" : "people"}
              </span>
            </div>
            <div className={clsx("flex flex-col gap-3 rounded-xl border border-line p-3.5", readOnly && "pointer-events-none opacity-70")}>
              <p className="text-[12.5px] text-muted">Everyone with an email who hasn&apos;t opted out{Object.values(audience).some((v) => v?.length) ? ", narrowed to people who match all of these:" : "."}</p>
              <ChipGroup label="Tagged" options={tags.map((t) => ({ value: t, label: t }))} selected={audience.tags ?? []} onToggle={(v) => toggle("tags", v)} empty="No tags yet. Tag people from their page or during import." />
              <ChipGroup label="With an open deal in" options={pipelines.flatMap((p) => p.stages.map((s) => ({ value: s.id, label: pipelines.length > 1 ? `${p.name}: ${s.name}` : s.name })))} selected={audience.stageIds ?? []} onToggle={(v) => toggle("stageIds", v)} />
              <ChipGroup label="Owned by" options={team.filter((m) => m.active).map((m) => ({ value: m.id, label: m.name }))} selected={audience.ownerIds ?? []} onToggle={(v) => toggle("ownerIds", v)} />
            </div>
          </section>
        </div>

        <div className="flex flex-col bg-sunken/50 p-4 lg:p-6">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-label">Preview</span>
            <Segmented
              value={device}
              onChange={setDevice}
              options={[
                { value: "desktop", label: "Desktop", icon: <ComputerDesktopIcon className="size-3.5" /> },
                { value: "phone", label: "Phone", icon: <DevicePhoneMobileIcon className="size-3.5" /> },
              ]}
            />
          </div>
          <div className="mb-3 rounded-lg border border-line bg-surface px-3 py-2 text-[12.5px]">
            <p className="truncate">
              <span className="text-muted">Subject </span>
              <span className="font-medium text-primary">{subject || "—"}</span>
            </p>
            {previewText ? <p className="truncate text-muted">{previewText}</p> : null}
          </div>
          <div className="relative flex flex-1 justify-center">
            {saving === "saving" ? <Spinner className="absolute top-3 right-3 text-faint" /> : null}
            {html ? (
              <iframe
                key={device}
                title="Email preview"
                sandbox="allow-same-origin"
                srcDoc={previewHtml}
                className={clsx("min-h-[560px] rounded-lg border border-line bg-white shadow-sm transition-[width]", device === "phone" ? "w-[375px]" : "w-full")}
              />
            ) : (
              <p className="self-center text-[13px] text-muted">Start writing to see the preview.</p>
            )}
          </div>
        </div>
      </div>

      {scheduling ? <ScheduleDialog campaignId={campaign.id} count={count} onClose={() => setScheduling(false)} /> : null}
      {confirmSend ? (
        <Dialog
          open
          onOpenChange={(o) => !o && setConfirmSend(false)}
          title={`Send to ${count.toLocaleString()} ${count === 1 ? "person" : "people"}?`}
          description="It starts going out right away and can't be unsent."
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmSend(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={pending}
                onClick={() =>
                  start(async () => {
                    const r = await scheduleCampaign(campaign.id, null);
                    setConfirmSend(false);
                    if (!r.ok) return void toast.error(r.error);
                    toast.success("Sending now. You can leave this page.");
                  })
                }
              >
                Send now
              </Button>
            </>
          }
        >
          <p className="text-[14px]">
            <span className="font-medium text-primary">{subject}</span>
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}

function ChipGroup({ label, options, selected, onToggle, empty }: { label: string; options: { value: string; label: string }[]; selected: string[]; onToggle: (v: string) => void; empty?: string }) {
  return (
    <div>
      <p className="mb-1.5 text-[12px] font-medium text-secondary">{label}</p>
      {options.length ? (
        <div className="flex flex-wrap gap-1.5">
          {options.map((o) => {
            const on = selected.includes(o.value);
            return (
              <button key={o.value} type="button" aria-pressed={on} onClick={() => onToggle(o.value)} className="rounded-full">
                <Tag className={on ? "border-accent bg-accent text-accent-foreground" : "hover:border-line-strong"}>{o.label}</Tag>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="text-[12px] text-faint">{empty ?? "Nothing to choose yet."}</p>
      )}
    </div>
  );
}

function ScheduleDialog({ campaignId, count, onClose }: { campaignId: string; count: number; onClose: () => void }) {
  const { workspace } = useApp();
  const tz = workspace.timezone;
  const [day, setDay] = useState(dayFromToday(tz, 1));
  const [time, setTime] = useState("09:00");
  const [pending, start] = useTransition();
  const at = zonedTime(day, time || "09:00", tz);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Schedule campaign"
      description={`Goes to everyone who matches the audience at that moment (${count.toLocaleString()} right now).`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={pending}
            onClick={() =>
              start(async () => {
                const r = await scheduleCampaign(campaignId, at.toISOString());
                if (!r.ok) return void toast.error(r.error);
                toast.success(`Scheduled for ${formatDateTime(at, tz)}`);
                onClose();
              })
            }
          >
            Schedule
          </Button>
        </>
      }
    >
      <div className="flex gap-3">
        <Field label="Date">{(p) => <Input {...p} type="date" value={day} min={dayFromToday(tz)} onChange={(e) => setDay(e.target.value)} />}</Field>
        <Field label="Time">{(p) => <Input {...p} type="time" value={time} step={900} onChange={(e) => setTime(e.target.value)} className="w-32" />}</Field>
      </div>
      <p className="mt-3 text-fine">{formatFull(at, tz)}</p>
    </Dialog>
  );
}
