"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { DocumentDuplicateIcon, PlusIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { myEmailSignature } from "@/actions/accounts";
import { listTemplates, sendRecordEmail } from "@/actions/email";
import { listSendingInboxes } from "@/actions/inbox";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Kbd, Select } from "@/components/ui/field";
import { useApp } from "@/components/app-context";
import { AttachmentPicker } from "@/components/email/attachment-picker";
import { MergeTagMenu } from "@/components/email/merge-tag-menu";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { RichText, type RichTextHandle } from "@/components/ui/rich-text";
import { toast } from "@/components/ui/toast";
import type { EmailAttachment } from "@/db/schema";
import { MAX_EMAIL_RECIPIENTS } from "@/lib/constants";
import type { Links } from "./composer";
import { PeopleChips, type Contact } from "./people-picker";

export type EmailRecipient = { personId: string; name: string; email: string | null };
type Template = Awaited<ReturnType<typeof listTemplates>>[number];
type SendingInbox = Awaited<ReturnType<typeof listSendingInboxes>>[number];
type Signature = Awaited<ReturnType<typeof myEmailSignature>>;

const noEmail = (c: Contact) => (c.email ? null : "No email address");
const splitAddresses = (s: string) =>
  s
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Write and send an email to this record's person, optionally from a template.
 * Merge tags fill in at send time. With `contacts` (a client's people) more of
 * them can go on the To and Cc lines: one email to all of them, 10 addresses
 * at most between the two lines.
 */
export function EmailComposer({
  links,
  recipient,
  contacts = [],
  draft,
  onDraftSent,
  startBlank,
}: {
  links: Links;
  recipient: EmailRecipient;
  contacts?: Contact[];
  draft?: { subject: string | null; body: string; attachments?: EmailAttachment[] } | null;
  onDraftSent?: () => void;
  /** Start with nobody on the To line: a record with no contact of its own (an organization), so the teammate picks who. */
  startBlank?: boolean;
}) {
  const editor = useRef<RichTextHandle>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  // A draft the agent wrote starts the email off; the teammate edits it like any other before sending.
  const [subject, setSubject] = useState(draft?.subject ?? "");
  const [body, setBody] = useState(draft?.body ?? "");
  /** Everyone who can be picked: the record's people, with whoever it starts addressed to. */
  const everyone: Contact[] = contacts.some((c) => c.personId === recipient.personId) ? contacts : [recipient, ...contacts];
  const startTo = startBlank ? [] : [recipient.personId];
  const [pickedTo, setToIds] = useState<string[]>(startTo);
  const [pickedCc, setCcIds] = useState<string[]>([]);
  const [cc, setCc] = useState("");
  // Someone taken off the record while the email was being written comes off it too, so it never goes to a person who isn't shown.
  // The To line can be emptied, even of the contact it started with, so someone else can go on it instead.
  const onRecord = (id: string) => everyone.some((c) => c.personId === id);
  const toIds = pickedTo.filter(onRecord);
  const ccIds = pickedCc.filter((id) => onRecord(id) && !toIds.includes(id));
  const first = everyone.find((c) => c.personId === toIds[0]) ?? null;
  const count = toIds.length + ccIds.length + splitAddresses(cc).length;
  const full = count >= MAX_EMAIL_RECIPIENTS;
  const [showCc, setShowCc] = useState(false);
  const [copyMe, setCopyMe] = useState(false);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [pending, start] = useTransition();
  const [lastFocus, setLastFocus] = useState<"subject" | "body">("body");
  const [inboxes, setInboxes] = useState<SendingInbox[]>([]);
  const { viewer, comms } = useApp();
  /** "microsoft" sends from the teammate's own Outlook; an inbox id from that Resend inbox; "" from the default address, with replies to `replyTo`. */
  const [inboxId, setInboxId] = useState(comms.mailbox && !comms.mailbox.needsReconnect ? "microsoft" : "");
  const viaMailbox = inboxId === "microsoft";
  /** Replies go to the sender unless they change it for this email. */
  const [replyTo, setReplyTo] = useState(viewer.email);
  const [editReplyTo, setEditReplyTo] = useState(false);
  // A draft's files come with it; the teammate can remove any before sending.
  const [attachments, setAttachments] = useState<EmailAttachment[]>(draft?.attachments ?? []);
  const [uploading, setUploading] = useState(false);
  /** The signature an Outlook email can carry (undefined while it loads), and whether this one does. */
  const [signature, setSignature] = useState<Signature | undefined>(undefined);
  const [withSignature, setWithSignature] = useState(false);
  const hasMailbox = !!comms.mailbox;

  useEffect(() => {
    listTemplates().then(setTemplates, () => setTemplates([]));
    if (hasMailbox)
      myEmailSignature().then(
        (sig) => {
          setSignature(sig);
          setWithSignature(!!sig?.auto);
        },
        () => setSignature(null),
      );

    listSendingInboxes().then(
      (list) => {
        setInboxes(list);
        if (list[0]) setInboxId((current) => (current === "microsoft" ? current : list[0].id));
      },
      () => setInboxes([]),
    );
  }, [hasMailbox]);

  const insertTag = (tag: string) => {
    const text = `{{${tag}}}`;
    if (lastFocus === "subject" && subjectRef.current) {
      const el = subjectRef.current;
      const at = el.selectionStart ?? subject.length;
      setSubject(subject.slice(0, at) + text + subject.slice(el.selectionEnd ?? at));
      setTimeout(() => el.setSelectionRange(at + text.length, at + text.length));
      el.focus();
    } else editor.current?.insert(text);
  };

  const send = () => {
    if (uploading) return void toast.error("Wait for the attachments to finish uploading.");
    if (!first) return void toast.error("Add someone to the To line, then send.");
    if (count > MAX_EMAIL_RECIPIENTS) return void toast.error(`An email can go to ${MAX_EMAIL_RECIPIENTS} addresses at most, counting To and Cc. Take ${count - MAX_EMAIL_RECIPIENTS} off and send again.`);
    start(async () => {
      const ccList = splitAddresses(cc);
      const r = await sendRecordEmail({
        personId: first.personId,
        toPersonIds: toIds.slice(1),
        ccPersonIds: ccIds,
        clientId: links.clientId ?? null,
        inboxId: viaMailbox ? null : inboxId || null,
        via: viaMailbox ? "microsoft" : "crm",
        cc: ccList,
        replyTo: viaMailbox ? (replyTo.trim() === viewer.email ? null : replyTo.trim()) : inboxId ? null : replyTo.trim(),
        subject,
        body,
        attachmentIds: attachments.map((a) => a.fileId),
        copyMe,
        // Only once it's loaded: until then the server uses the teammate's default.
        signature: viaMailbox && signature !== undefined ? withSignature : undefined,
      });
      if (!r.ok) return void toast.error(r.error);
      const others = toIds.length - 1 + ccIds.length + ccList.length;
      toast.success(`Email sent to ${first.name}${others ? ` and ${others} ${others === 1 ? "other" : "others"}` : ""}`);
      onDraftSent?.();
      editor.current?.clear();
      setBody("");
      setSubject("");
      setCc("");
      setCcIds([]);
      setToIds(startTo);
      setAttachments([]);
      setReplyTo(viewer.email);
      setEditReplyTo(false);
      setWithSignature(!!signature?.auto);
    });
  };

  return (
    <div className="flex flex-col gap-2.5">
      {inboxes.length || comms.mailbox ? (
        <div className="flex items-center gap-2 text-[13px]">
          <label htmlFor="email-from" className="w-10 text-muted">
            From
          </label>
          <Select id="email-from" value={inboxId} onChange={(e) => setInboxId(e.target.value)} className="min-w-0 flex-1 [&_select]:h-8 pointer-coarse:[&_select]:h-10 [&_select]:text-[13px]">
            {comms.mailbox ? (
              <option value="microsoft" disabled={comms.mailbox.needsReconnect}>
                {comms.mailbox.email} (your Outlook{comms.mailbox.needsReconnect ? ", reconnect in Settings" : ""})
              </option>
            ) : null}
            {inboxes.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name ? `${i.name} <${i.address}>` : i.address}
              </option>
            ))}
            <option value="">Default (replies to your own inbox)</option>
          </Select>
        </div>
      ) : null}
      {/* Everything on this line is 28px tall, so "To", the chips, "Cc" and "Template" sit on one line. */}
      <div className="flex items-start gap-2 text-[13px]">
        <span className="flex h-7 w-10 shrink-0 items-center text-muted">To</span>
        <PeopleChips contacts={everyone} value={toIds} onChange={setToIds} exclude={ccIds} unavailable={noEmail} full={full} addLabel={toIds.length ? "Add" : "Add a recipient"} menuLabel="Add to the To line" />
        {!showCc ? (
          <button type="button" className="inline-flex h-7 shrink-0 items-center px-1 text-[12.5px] text-muted hover:text-primary" onClick={() => setShowCc(true)}>
            Cc
          </button>
        ) : null}
        <Menu>
          <MenuTrigger asChild>
            <Button size="sm" variant="ghost" className="h-7 shrink-0" disabled={!templates?.length}>
              <DocumentDuplicateIcon />
              Template
            </Button>
          </MenuTrigger>
          <MenuContent className="max-h-72 w-64 overflow-auto">
            <MenuLabel>Use a template</MenuLabel>
            {templates?.map((t) => (
              <MenuItem
                key={t.id}
                onSelect={() => {
                  setSubject(t.subject);
                  setBody(t.body);
                  editor.current?.setContent(t.body);
                  // The template's files come along; anything already attached stays.
                  setAttachments((list) => [...list, ...t.attachments.filter((a) => !list.some((x) => x.fileId === a.fileId))]);
                }}
              >
                <span className="truncate">{t.name}</span>
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      </div>
      {showCc ? (
        <div className="flex items-start gap-2 text-[13px]">
          <label htmlFor="email-cc" className="flex h-7 w-10 shrink-0 items-center text-muted">
            Cc
          </label>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            {everyone.length > 1 ? <PeopleChips contacts={everyone} value={ccIds} onChange={setCcIds} exclude={toIds} unavailable={noEmail} full={full} addLabel="Add" menuLabel="Add to the Cc line" /> : null}
            <Input id="email-cc" value={cc} onChange={(e) => setCc(e.target.value)} placeholder={everyone.length > 1 ? "Or type addresses: name@company.com, …" : "name@company.com, …"} className="h-8 text-[13px]" autoFocus={everyone.length < 2} />
          </div>
        </div>
      ) : null}
      {count > 1 ? (
        <p className={count > MAX_EMAIL_RECIPIENTS ? "text-[12px] text-error" : "text-fine"} role={count > MAX_EMAIL_RECIPIENTS ? "alert" : undefined}>
          {count} of {MAX_EMAIL_RECIPIENTS} recipients, counting To and Cc.
          {toIds.length > 1 && first ? ` Everyone gets the same email, so merge tags like {{first_name}} fill in for ${first.name}.` : ""}
        </p>
      ) : null}
      <Input ref={subjectRef} value={subject} onChange={(e) => setSubject(e.target.value)} onFocus={() => setLastFocus("subject")} placeholder="Subject" aria-label="Subject" />
      <div onFocusCapture={(e) => (e.target as HTMLElement).isContentEditable && setLastFocus("body")}>
        <RichText
          handle={editor}
          value={body}
          onChange={setBody}
          onSubmit={send}
          minHeight={120}
          placeholder={toIds.length > 1 ? "Hi all," : `Hi {{first_name}},`}
          actions={<MergeTagMenu onInsert={insertTag} className="h-7" />}
          dictation
        />
      </div>
      {viaMailbox && signature ? (
        withSignature ? (
          <div className="rounded-lg border border-dashed border-line px-3 pt-1.5 pb-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11.5px] text-muted">{signature.own ? "Your signature" : "Workspace signature"}</span>
              <button type="button" onClick={() => setWithSignature(false)} className="-mr-1.5 inline-flex h-7 items-center gap-1 rounded px-1.5 text-[12px] text-muted hover:bg-sunken hover:text-primary">
                <XMarkIcon className="size-3.5" aria-hidden />
                Remove signature
              </button>
            </div>
            <div className="prose-signature" dangerouslySetInnerHTML={{ __html: signature.html }} />
          </div>
        ) : (
          <button type="button" onClick={() => setWithSignature(true)} className="inline-flex h-7 items-center gap-1 self-start rounded px-1.5 text-[12.5px] text-muted hover:bg-sunken hover:text-primary">
            <PlusIcon className="size-3.5" aria-hidden />
            Add signature
          </button>
        )
      ) : viaMailbox && signature === null ? (
        <Link href="/settings/accounts" className="self-start text-[12px] text-muted underline-offset-2 hover:text-primary hover:underline">
          Set up an email signature
        </Link>
      ) : null}
      <AttachmentPicker value={attachments} onChange={setAttachments} links={{ personId: recipient.personId, clientId: links.clientId ?? null }} onUploadingChange={setUploading} />
      <div className="flex flex-wrap items-center gap-3">
        <Checkbox checked={copyMe} onChange={(e) => setCopyMe(e.target.checked)} label={<span className="text-[13px]">Send me a copy</span>} />
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-[11.5px] text-faint sm:inline">
            <Kbd>⌘</Kbd> <Kbd>↵</Kbd>
          </span>
          <Button variant="primary" size="sm" loading={pending} disabled={uploading || !first} onClick={send}>
            Send email
          </Button>
        </div>
      </div>
      {viaMailbox ? (
        <p className="text-fine">Sends from your Outlook and is saved in your Sent Items. Replies come to your mailbox and onto this timeline with the next sync.</p>
      ) : inboxId ? (
        <p className="text-fine">Replies come back to the CRM inbox. The email is saved to this timeline.</p>
      ) : editReplyTo ? (
        <div className="flex items-center gap-2 text-[13px]">
          <label htmlFor="email-reply-to" className="shrink-0 text-muted">
            Replies go to
          </label>
          <Input id="email-reply-to" type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder={viewer.email} className="h-8 text-[13px]" autoFocus />
        </div>
      ) : (
        <p className="text-fine">
          Replies go to <span className="text-secondary">{replyTo.trim() || viewer.email}</span>.{" "}
          <button type="button" className="font-medium text-secondary underline-offset-2 hover:text-primary hover:underline" onClick={() => setEditReplyTo(true)}>
            Change
          </button>{" "}
          The email is saved to this timeline.
        </p>
      )}
    </div>
  );
}
