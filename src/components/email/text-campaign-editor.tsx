"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { ChevronLeftIcon } from "@heroicons/react/20/solid";
import { saveAudience } from "@/actions/audiences";
import { saveTextCampaign, scheduleCampaign, sendTextCampaignTest, unscheduleCampaign } from "@/actions/campaigns";
import { useApp } from "@/components/app-context";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import type { CampaignAudience } from "@/db/schema";
import { appConfig } from "@/app.config";
import { fillMergeTags } from "@/lib/email/merge-tags";
import { formatDateTime } from "@/lib/format";
import { formatPhone, smsSegments } from "@/lib/phone/numbers";
import { AudienceFilters, hasFilters } from "./audience-filters";
import { NameAudienceDialog, ScheduleDialog, type SavedAudience } from "./campaign-editor";

export type TextCampaignData = {
  id: string;
  name: string;
  textBody: string;
  phoneNumberId: string | null;
  audience: CampaignAudience;
  audienceId: string | null;
  status: "draft" | "scheduled" | "sending" | "sent";
  scheduledAt: Date | null;
  sentAt: Date | null;
  recipientCount: number;
  sendError: string | null;
};

const TAGS = ["first_name", "last_name", "company", "job_title", "owner_first_name"] as const;

/**
 * A text campaign: one message to everyone who matches an audience, from one
 * of the team's numbers. Saves as you type. Only people with a phone who
 * haven't replied STOP (and, by default, who agreed to marketing texts) get it.
 */
export function TextCampaignEditor({
  campaign,
  tags,
  clientTags,
  industries,
  initialCount,
  audiences: initialAudiences,
  stats,
  numbers,
}: {
  campaign: TextCampaignData;
  tags: string[];
  clientTags: string[];
  industries: string[];
  initialCount: number;
  audiences: SavedAudience[];
  stats: { total: number; delivered: number; failed: number; replies: number } | null;
  /** Every number the campaign might use, so a sent campaign still names its own. */
  numbers: { id: string; label: string; number: string }[];
}) {
  const { workspace, viewer, comms } = useApp();
  const readOnly = campaign.status === "sent" || campaign.status === "sending";
  const [name, setName] = useState(campaign.name);
  const [body, setBody] = useState(campaign.textBody);
  const [numberId, setNumberId] = useState(campaign.phoneNumberId ?? "");
  const [audience, setAudience] = useState<CampaignAudience>(campaign.audience);
  const [audienceId, setAudienceId] = useState(campaign.audienceId);
  const [audiences, setAudiences] = useState(initialAudiences);
  const [count, setCount] = useState(initialCount);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [naming, setNaming] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [pending, start] = useTransition();
  const first = useRef(true);
  const area = useRef<HTMLTextAreaElement>(null);
  const tz = workspace.timezone;

  useEffect(() => {
    if (readOnly) return;
    if (first.current) {
      first.current = false;
      return;
    }
    setSaving("saving");
    const t = setTimeout(async () => {
      const r = await saveTextCampaign(campaign.id, { name: name || "Untitled text campaign", textBody: body, phoneNumberId: numberId || null, audience, audienceId });
      if (!r.ok) {
        setSaving("error");
        return void toast.error(r.error);
      }
      setCount(r.data.recipients);
      setSaving("saved");
    }, 700);
    return () => clearTimeout(t);
  }, [name, body, numberId, audience, audienceId, campaign.id, readOnly]);

  const saved = audiences.find((a) => a.id === audienceId);
  const footer = appConfig.phone.textCampaignFooter.trim();
  const sample = fillMergeTags(body, { first_name: viewer.name.split(" ")[0], last_name: viewer.name.split(" ").slice(1).join(" "), company: workspace.name, owner_first_name: viewer.name.split(" ")[0] });
  const preview = footer && !sample.toLowerCase().includes(footer.toLowerCase()) ? `${sample.trim()}\n\n${footer}` : sample;
  const segments = smsSegments(preview);
  // A sent campaign keeps showing the number it went from, even if the viewer can't use it.
  const options = numbers.length ? numbers : comms.numbers;

  const insert = (tag: string) => {
    const el = area.current;
    const text = `{{${tag}}}`;
    const at = el?.selectionStart ?? body.length;
    setBody(body.slice(0, at) + text + body.slice(el?.selectionEnd ?? at));
    setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(at + text.length, at + text.length);
    });
  };

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
            {campaign.status === "sent" ? `Sent ${campaign.sentAt ? formatDateTime(campaign.sentAt, tz) : ""}` : campaign.status === "scheduled" ? `Scheduled ${campaign.scheduledAt ? formatDateTime(campaign.scheduledAt, tz) : ""}` : "Sending"}
          </StatusBadge>
        ) : null}
        {!readOnly ? (
          <>
            <Button variant="ghost" onClick={() => setTesting(true)} disabled={!body.trim() || !numberId}>
              Send test
            </Button>
            {campaign.status === "scheduled" ? (
              <Button variant="outline" onClick={() => start(async () => void (await unscheduleCampaign(campaign.id)))}>
                Unschedule
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setScheduling(true)} disabled={saving === "saving"}>
                Schedule
              </Button>
            )}
            <Button variant="primary" onClick={() => setConfirmSend(true)} disabled={!count || !body.trim() || !numberId || saving === "saving"}>
              Send now
            </Button>
          </>
        ) : null}
      </header>
      {campaign.sendError ? <p className="border-b border-error-border bg-error-surface px-6 py-2 text-[13px] text-error">The last send attempt stopped: {campaign.sendError}</p> : null}
      {!comms.texting && !readOnly ? (
        <p className="border-b border-warning-border bg-warning-surface px-6 py-2 text-[13px] text-warning">You don&apos;t have a number to text from. An admin can give you access in Settings → Phone numbers.</p>
      ) : null}

      <div className="grid flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="flex flex-col gap-5 border-line p-4 lg:border-r lg:p-6">
          {stats ? (
            <section className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Results">
              {[
                { label: "Texted", value: stats.total },
                { label: "Delivered", value: stats.delivered },
                { label: "Didn't deliver", value: stats.failed },
                { label: "Replied", value: stats.replies },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border border-line bg-surface px-3 py-2.5">
                  <p className="text-[12px] text-muted">{s.label}</p>
                  <p className="text-[18px] font-semibold text-primary tabular-nums">{s.value.toLocaleString()}</p>
                </div>
              ))}
            </section>
          ) : null}
          <Field label="Text from">
            {(p) => (
              <Select {...p} value={numberId} onChange={(e) => setNumberId(e.target.value)} disabled={readOnly}>
                {!numberId ? <option value="">Pick a number</option> : null}
                {options.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.label} · {formatPhone(n.number)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <section>
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <label htmlFor="text-body" className="text-label">
                Message
              </label>
              {!readOnly ? (
                <div className="flex flex-wrap gap-1">
                  {TAGS.map((t) => (
                    <button key={t} type="button" onClick={() => insert(t)} className="rounded-full border border-line px-2 py-0.5 text-[11.5px] text-secondary hover:border-line-strong hover:text-primary">
                      {`{{${t}}}`}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <Textarea id="text-body" ref={area} value={body} onChange={(e) => setBody(e.target.value)} disabled={readOnly} rows={6} maxLength={1600} />
            <p className="mt-1.5 text-fine">
              {footer ? `“${footer}” is added at the end. ` : ""}
              {preview.length} characters · {segments} {segments === 1 ? "message" : "messages"} per person. Use <code className="font-mono">{"{{first_name|there}}"}</code> for a fallback.
            </p>
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
                  className="min-w-0 flex-1 [&_select]:h-8 pointer-coarse:[&_select]:h-10 [&_select]:text-[13px]"
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
                Everyone with a phone number who hasn&apos;t replied STOP{appConfig.phone.textCampaignsNeedConsent ? " and has agreed to marketing texts (on their record)" : ""}
                {hasFilters(audience) ? ", narrowed to people who match all of these:" : "."}
              </p>
              <AudienceFilters audience={audience} onChange={setAudience} tags={tags} clientTags={clientTags} industries={industries} readOnly={readOnly || !!saved} />
            </div>
          </section>
        </div>

        <aside className="flex flex-col gap-3 bg-sunken/50 p-4 lg:p-6">
          <span className="text-label">Preview</span>
          <div className="mx-auto w-full max-w-72 rounded-2xl border border-line bg-surface p-3 shadow-sm">
            <p className="mb-2 text-center text-[11.5px] text-muted">{options.find((n) => n.id === numberId) ? formatPhone(options.find((n) => n.id === numberId)!.number) : "Your number"}</p>
            <p className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-3 py-2 text-[13.5px] whitespace-pre-wrap text-accent-foreground">{preview.trim() || "Start writing to see the preview."}</p>
          </div>
          <p className="text-center text-fine">Shown filled in for you. Replies land on each person&apos;s timeline.</p>
        </aside>
      </div>

      {naming ? (
        <NameAudienceDialog
          onClose={() => setNaming(false)}
          onSave={async (audienceName) => {
            const r = await saveAudience(null, { name: audienceName, filters: audience });
            if (!r.ok) return void toast.error(r.error);
            setAudiences((list) => [...list, { id: r.data.id, name: audienceName, filters: audience }]);
            setAudienceId(r.data.id);
            setNaming(false);
            toast.success(`Saved “${audienceName}”. Other campaigns can use it now.`);
          }}
        />
      ) : null}
      {scheduling ? <ScheduleDialog campaignId={campaign.id} count={count} onClose={() => setScheduling(false)} /> : null}
      {testing ? (
        <Dialog
          open
          onOpenChange={(o) => !o && setTesting(false)}
          title="Text a test"
          description="Sent from the campaign's number, filled in as if you were the recipient."
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setTesting(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={pending}
                disabled={!testTo.trim()}
                onClick={() =>
                  start(async () => {
                    const r = await sendTextCampaignTest(campaign.id, testTo);
                    if (!r.ok) return void toast.error(r.error);
                    toast.success(`Test texted to ${formatPhone(r.data.to)}`);
                    setTesting(false);
                  })
                }
              >
                Send test
              </Button>
            </>
          }
        >
          <Field label="Your cell phone">{(p) => <Input {...p} type="tel" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="(303) 555-0123" autoFocus />}</Field>
        </Dialog>
      ) : null}
      {confirmSend ? (
        <Dialog
          open
          onOpenChange={(o) => !o && setConfirmSend(false)}
          title={`Text ${count.toLocaleString()} ${count === 1 ? "person" : "people"}?`}
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
          <p className="text-[13.5px] whitespace-pre-wrap text-secondary">{preview}</p>
        </Dialog>
      ) : null}
    </div>
  );
}
