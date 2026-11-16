"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { DocumentDuplicateIcon } from "@heroicons/react/20/solid";
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
import type { Links } from "./composer";

export type EmailRecipient = { personId: string; name: string; email: string | null };
type Template = Awaited<ReturnType<typeof listTemplates>>[number];
type SendingInbox = Awaited<ReturnType<typeof listSendingInboxes>>[number];

/** Write and send an email to this record's person, optionally from a template. Merge tags fill in at send time. */
export function EmailComposer({ links, recipient }: { links: Links; recipient: EmailRecipient }) {
  const editor = useRef<RichTextHandle>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [cc, setCc] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [copyMe, setCopyMe] = useState(false);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [pending, start] = useTransition();
  const [lastFocus, setLastFocus] = useState<"subject" | "body">("body");
  const [inboxes, setInboxes] = useState<SendingInbox[]>([]);
  /** "" sends from the default address, with replies to `replyTo`. */
  const [inboxId, setInboxId] = useState("");
  const { viewer } = useApp();
  /** Replies go to the sender unless they change it for this email. */
  const [replyTo, setReplyTo] = useState(viewer.email);
  const [editReplyTo, setEditReplyTo] = useState(false);
  const [attachments, setAttachments] = useState<EmailAttachment[]>([]);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    listTemplates().then(setTemplates, () => setTemplates([]));

    listSendingInboxes().then(
      (list) => {
        setInboxes(list);
        if (list[0]) setInboxId(list[0].id);
      },
      () => setInboxes([]),
    );
  }, []);

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
    start(async () => {
      const ccList = cc
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const r = await sendRecordEmail({
        personId: recipient.personId,
        clientId: links.clientId ?? null,
        inboxId: inboxId || null,
        cc: ccList,
        replyTo: inboxId ? null : replyTo.trim(),
        subject,
        body,
        attachmentIds: attachments.map((a) => a.fileId),
        copyMe,
      });
      if (!r.ok) return void toast.error(r.error);
      toast.success(`Email sent to ${recipient.name}`);
      editor.current?.clear();
      setBody("");
      setSubject("");
      setCc("");
      setAttachments([]);
      setReplyTo(viewer.email);
      setEditReplyTo(false);
    });
  };

  return (
    <div className="flex flex-col gap-2.5">
      {inboxes.length ? (
        <div className="flex items-center gap-2 text-[13px]">
          <label htmlFor="email-from" className="w-10 text-muted">
            From
          </label>
          <Select id="email-from" value={inboxId} onChange={(e) => setInboxId(e.target.value)} className="min-w-0 flex-1 [&_select]:h-8 [&_select]:text-[13px]">
            {inboxes.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name ? `${i.name} <${i.address}>` : i.address}
              </option>
            ))}
            <option value="">Default (replies to your own inbox)</option>
          </Select>
        </div>
      ) : null}
      <div className="flex items-center gap-2 text-[13px]">
        <span className="w-10 text-muted">To</span>
        <span className="min-w-0 flex-1 truncate text-primary">
          {recipient.name} <span className="text-muted">&lt;{recipient.email}&gt;</span>
        </span>
        {!showCc ? (
          <button type="button" className="text-[12.5px] text-muted hover:text-primary" onClick={() => setShowCc(true)}>
            Cc
          </button>
        ) : null}
        <Menu>
          <MenuTrigger asChild>
            <Button size="sm" variant="ghost" disabled={!templates?.length}>
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
        <div className="flex items-center gap-2 text-[13px]">
          <label htmlFor="email-cc" className="w-10 text-muted">
            Cc
          </label>
          <Input id="email-cc" value={cc} onChange={(e) => setCc(e.target.value)} placeholder="name@company.com, …" className="h-8 text-[13px]" autoFocus />
        </div>
      ) : null}
      <Input ref={subjectRef} value={subject} onChange={(e) => setSubject(e.target.value)} onFocus={() => setLastFocus("subject")} placeholder="Subject" aria-label="Subject" />
      <div onFocusCapture={(e) => (e.target as HTMLElement).isContentEditable && setLastFocus("body")}>
        <RichText
          handle={editor}
          value={body}
          onChange={setBody}
          onSubmit={send}
          minHeight={120}
          placeholder={`Hi {{first_name}},`}
          actions={<MergeTagMenu onInsert={insertTag} className="h-7" />}
          dictation
        />
      </div>
      <AttachmentPicker value={attachments} onChange={setAttachments} links={{ personId: recipient.personId, clientId: links.clientId ?? null }} onUploadingChange={setUploading} />
      <div className="flex flex-wrap items-center gap-3">
        <Checkbox checked={copyMe} onChange={(e) => setCopyMe(e.target.checked)} label={<span className="text-[13px]">Send me a copy</span>} />
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-[11.5px] text-faint sm:inline">
            <Kbd>⌘</Kbd> <Kbd>↵</Kbd>
          </span>
          <Button variant="primary" size="sm" loading={pending} disabled={uploading} onClick={send}>
            Send email
          </Button>
        </div>
      </div>
      {inboxId ? (
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
