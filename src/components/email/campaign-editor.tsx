"use client";

import clsx from "clsx";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { ChevronLeftIcon, ComputerDesktopIcon, DevicePhoneMobileIcon, DocumentDuplicateIcon } from "@heroicons/react/20/solid";
import { saveAudience } from "@/actions/audiences";
import { saveCampaign, scheduleCampaign, sendCampaignTest, unscheduleCampaign } from "@/actions/campaigns";
import { listTemplates } from "@/actions/email";
import { useApp } from "@/components/app-context";
import { Segmented } from "@/components/activity/composer";
import { Button, Spinner } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { RichText, type RichTextHandle } from "@/components/ui/rich-text";
import { toast } from "@/components/ui/toast";
import type { CampaignAudience, EmailAttachment } from "@/db/schema";
import type { CampaignDelivery } from "@/lib/email/delivery";
import { dayFromToday, formatDateTime, formatFull, roundUpToQuarterHour, zonedTime } from "@/lib/format";
import { fillMergeTagsHtml } from "@/lib/email/merge-tags";
import { AttachmentPicker } from "./attachment-picker";
import { AudienceFilters, hasFilters } from "./audience-filters";
import { CampaignReport } from "./campaign-report";
import { MergeTagMenu } from "./merge-tag-menu";

export type SavedAudience = {
  id: string;
  name: string;
  filters: CampaignAudience;
};
type Template = Awaited<ReturnType<typeof listTemplates>>[number];

export type CampaignData = {
  id: string;
  name: string;
  subject: string;
  previewText: string | null;
  body: string;
  html: string | null;
  audience: CampaignAudience;
  audienceId: string | null;
  replyTo: string | null;
  attachments: EmailAttachment[];
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
export function CampaignEditor({
  campaign,
  tags,
  clientTags,
  initialCount,
  hasAddress,
  audiences: initialAudiences,
  defaultReplyTo,
  delivery,
}: {
  campaign: CampaignData;
  tags: string[];
  clientTags: string[];
  initialCount: number;
  hasAddress: boolean;
  audiences: SavedAudience[];
  /** What a blank reply-to falls back to: the email of whoever set the campaign up. */
  defaultReplyTo: string | null;
  delivery: CampaignDelivery | null;
}) {
  const { workspace, viewer } = useApp();
  const readOnly = campaign.status === "sent" || campaign.status === "sending";
  const [name, setName] = useState(campaign.name);
  const [subject, setSubject] = useState(campaign.subject);
  const [previewText, setPreviewText] = useState(campaign.previewText ?? "");
  const [body, setBody] = useState(campaign.body);
  const [audience, setAudience] = useState<CampaignAudience>(campaign.audience);
  const [audienceId, setAudienceId] = useState(campaign.audienceId);
  const [audiences, setAudiences] = useState(initialAudiences);
  const [replyTo, setReplyTo] = useState(campaign.replyTo ?? "");
  const [attachments, setAttachments] = useState<EmailAttachment[]>(campaign.attachments);
  const [uploading, setUploading] = useState(false);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [naming, setNaming] = useState(false);
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
      const r = await saveCampaign(campaign.id, {
        name: name || "Untitled campaign",
        subject,
        previewText: previewText || null,
        body,
        audience,
        audienceId,
        replyTo: replyTo.trim(),
        attachmentIds: attachments.map((a) => a.fileId),
      });
      if (!r.ok) {
        setSaving("error");
        return void toast.error(r.error);
      }
      setCount(r.data.recipients);
      setHtml(r.data.html);
      setSaving("saved");
    }, 700);
    return () => clearTimeout(t);
  }, [name, subject, previewText, body, audience, audienceId, replyTo, attachments, campaign.id, readOnly]);

  useEffect(() => {
    if (!readOnly) listTemplates().then(setTemplates, () => setTemplates([]));
  }, [readOnly]);

  const saved = audiences.find((a) => a.id === audienceId);
  const applyTemplate = (t: Template) => {
    if (t.subject) setSubject(t.subject);
    setBody(t.body);
    editor.current?.setContent(t.body);
    setAttachments((list) => [...list, ...t.attachments.filter((a) => !list.some((x) => x.fileId === a.fileId))]);
  };

  // A sample recipient for the preview: you.
  const sample = {
    first_name: viewer.name.split(" ")[0],
    last_name: viewer.name.split(" ").slice(1).join(" "),
    full_name: viewer.name,
    email: viewer.email,
    company: workspace.name,
    owner_name: viewer.name,
    owner_first_name: viewer.name.split(" ")[0],
  };
  const previewHtml = fillMergeTagsHtml(html ?? "", sample);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5 lg:px-6">
        <Link href="/email/campaigns" className="flex items-center gap-1 text-[13px] text-muted hover:text-primary">
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
            {campaign.status === "sent"
              ? `Sent ${campaign.sentAt ? formatDateTime(campaign.sentAt, tz) : ""}`
              : campaign.status === "scheduled"
                ? `Scheduled ${campaign.scheduledAt ? formatDateTime(campaign.scheduledAt, tz) : ""}`
                : "Sending"}
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
              <Button variant="outline" onClick={() => setScheduling(true)} disabled={uploading || saving === "saving"}>
                Schedule
              </Button>
            )}
            <Button variant="primary" onClick={() => setConfirmSend(true)} disabled={!count || !subject.trim() || uploading || saving === "saving"}>
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
          {campaign.status === "sent" || campaign.status === "sending" ? <CampaignReport campaignId={campaign.id} delivery={delivery} sending={campaign.status === "sending"} /> : null}
          <section className="flex flex-col gap-3">
            <Field label="Subject">{(p) => <Input {...p} value={subject} onChange={(e) => setSubject(e.target.value)} disabled={readOnly} placeholder="What's new at {{company}}" />}</Field>
            <Field label="Preview text" optional hint="Shown after the subject in most inboxes.">
              {(p) => <Input {...p} value={previewText} onChange={(e) => setPreviewText(e.target.value)} disabled={readOnly} />}
            </Field>
          </section>

          <section>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-label">Message</span>
              {!readOnly ? (
                <div className="flex items-center gap-1">
                  <Menu>
                    <MenuTrigger asChild>
                      <Button size="sm" variant="ghost" disabled={!templates?.length}>
                        <DocumentDuplicateIcon />
                        Template
                      </Button>
                    </MenuTrigger>
                    <MenuContent className="max-h-72 w-64 overflow-auto">
                      <MenuLabel>Replace the message with</MenuLabel>
                      {templates?.map((t) => (
                        <MenuItem key={t.id} onSelect={() => applyTemplate(t)}>
                          <span className="truncate">{t.name}</span>
                        </MenuItem>
                      ))}
                    </MenuContent>
                  </Menu>
                  <MergeTagMenu campaign onInsert={(t) => editor.current?.insert(`{{${t}}}`)} />
                </div>
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

          <section className="flex flex-col gap-3">
            <Field
              label="Reply-to"
              optional
              hint={
                defaultReplyTo
                  ? `Starts as the email of whoever set up this campaign. Change it to send replies somewhere else; blank uses ${defaultReplyTo}.`
                  : "Blank means replies go to the sending address."
              }
            >
              {(p) => <Input {...p} type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} disabled={readOnly} placeholder={defaultReplyTo ?? "hello@acme.com"} />}
            </Field>
            {readOnly && !attachments.length ? null : (
              <div>
                <p className="mb-1.5 text-label">Attachments</p>
                <AttachmentPicker value={attachments} onChange={setAttachments} disabled={readOnly} onUploadingChange={setUploading} />
                {attachments.length && !readOnly ? (
                  <p className="mt-1.5 text-fine">
                    Resend can&apos;t batch emails with files, so this campaign goes out one email at a time. Large audiences take longer. A link to the file is often better for deliverability.
                  </p>
                ) : null}
              </div>
            )}
          </section>

          <section>
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-label">Audience</span>
              <span className="text-[13px] text-secondary tabular-nums">
                {count.toLocaleString()} {count === 1 ? "person" : "people"}
              </span>
            </div>
            <div className="flex flex-col gap-3 rounded-xl border border-line p-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  aria-label="Audience"
                  value={audienceId ?? ""}
                  disabled={readOnly}
                  onChange={(e) => {
                    const next = audiences.find((a) => a.id === e.target.value);
                    setAudienceId(next?.id ?? null);
                    if (next) setAudience(next.filters);
                  }}
                  className="min-w-0 flex-1 [&_select]:h-8 [&_select]:text-[13px]"
                >
                  <option value="">Filters set here</option>
                  {audiences.map((a) => (
                    <option key={a.id} value={a.id}>
                      Saved: {a.name}
                    </option>
                  ))}
                </Select>
                {saved ? (
                  <Button size="sm" variant="ghost" asChild>
                    <Link href={`/email/audiences/${saved.id}`}>Edit audience</Link>
                  </Button>
                ) : !readOnly && hasFilters(audience) ? (
                  <Button size="sm" variant="ghost" onClick={() => setNaming(true)}>
                    Save as audience
                  </Button>
                ) : null}
              </div>
              <p className="text-[12.5px] text-muted">
                {saved
                  ? `Uses the saved audience “${saved.name}” as it is when the campaign sends.`
                  : `Everyone with an email who hasn't opted out or bounced${hasFilters(audience) ? ", narrowed to people who match all of these:" : "."}`}
              </p>
              <AudienceFilters audience={audience} onChange={setAudience} tags={tags} clientTags={clientTags} readOnly={readOnly || !!saved} />
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
                {
                  value: "desktop",
                  label: "Desktop",
                  icon: <ComputerDesktopIcon className="size-3.5" />,
                },
                {
                  value: "phone",
                  label: "Phone",
                  icon: <DevicePhoneMobileIcon className="size-3.5" />,
                },
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

      {naming ? (
        <NameAudienceDialog
          onClose={() => setNaming(false)}
          onSave={async (audienceName) => {
            const r = await saveAudience(null, {
              name: audienceName,
              filters: audience,
            });
            if (!r.ok) return void toast.error(r.error);
            setAudiences((list) => [...list, { id: r.data.id, name: audienceName, filters: audience }]);
            setAudienceId(r.data.id);
            setNaming(false);
            toast.success(`Saved “${audienceName}”. Other campaigns can use it now.`);
          }}
        />
      ) : null}
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

function NameAudienceDialog({ onClose, onSave }: { onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [audienceName, setAudienceName] = useState("");
  const [pending, start] = useTransition();
  const submit = () => start(() => onSave(audienceName.trim()));
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Save as an audience"
      description="Reuse these filters in other campaigns. Changing the audience later changes it everywhere it's used."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} disabled={!audienceName.trim()} onClick={submit}>
            Save audience
          </Button>
        </>
      }
    >
      <Field label="Name">
        {(p) => (
          <Input
            {...p}
            value={audienceName}
            onChange={(e) => setAudienceName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && audienceName.trim() && submit()}
            placeholder="e.g. Prospects in proposal stage"
            autoFocus
          />
        )}
      </Field>
    </Dialog>
  );
}

function ScheduleDialog({ campaignId, count, onClose }: { campaignId: string; count: number; onClose: () => void }) {
  const { workspace } = useApp();
  const tz = workspace.timezone;
  const [day, setDay] = useState(dayFromToday(tz, 1));
  const [time, setTime] = useState("09:00");
  const [pending, start] = useTransition();
  const at = roundUpToQuarterHour(zonedTime(day, time || "09:00", tz));
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Schedule campaign"
      description={`Goes to everyone who matches the audience at that moment (${count.toLocaleString()} right now). Campaigns go out on the quarter hour.`}
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
