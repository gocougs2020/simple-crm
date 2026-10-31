"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { ChevronLeftIcon, CodeBracketIcon, PlusIcon } from "@heroicons/react/20/solid";
import { DocumentDuplicateIcon } from "@heroicons/react/24/outline";
import { deleteTemplate, saveTemplate } from "@/actions/email";
import { useApp } from "@/components/app-context";
import { PageHeader } from "@/components/shell/app-shell";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Checkbox, Field, Input } from "@/components/ui/field";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { RichText, type RichTextHandle } from "@/components/ui/rich-text";
import { toast } from "@/components/ui/toast";
import { mergeTagLabels, mergeTags } from "@/lib/email/merge-tags";
import { htmlToText } from "@/lib/safe-html";
import { EmailTabs } from "./email-tabs";

export type TemplateRow = { id: string; name: string; subject: string; body: string; shared: boolean; createdBy: string | null };

export function TemplateList({ rows }: { rows: TemplateRow[] }) {
  const { member } = useApp();
  return (
    <>
      <PageHeader title="Email">
        <Button variant="primary" asChild>
          <Link href="/email/templates/new">
            <PlusIcon />
            Template
          </Link>
        </Button>
      </PageHeader>
      <EmailTabs />
      <div className="mx-auto max-w-5xl px-4 py-5 lg:px-6">
        {rows.length ? (
          <ul className="grid gap-3 sm:grid-cols-2">
            {rows.map((t) => (
              <li key={t.id}>
                <Link href={`/email/templates/${t.id}`} className="block h-full rounded-xl border border-line bg-surface p-4 transition-shadow hover:shadow-md">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium text-primary">{t.name}</p>
                    {!t.shared ? <StatusBadge>Only you</StatusBadge> : null}
                  </div>
                  <p className="mt-0.5 truncate text-[13px] text-secondary">{t.subject || "No subject"}</p>
                  <p className="mt-2 line-clamp-2 text-[12.5px] text-muted">{htmlToText(t.body)}</p>
                  <p className="mt-2 text-[11.5px] text-faint">By {member(t.createdBy)?.name ?? "a former teammate"}</p>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={DocumentDuplicateIcon}
            title="No templates yet"
            description="Save emails you send often. Pick one from the Email tab on any record and it fills in the subject and message."
            action={
              <Button variant="primary" asChild>
                <Link href="/email/templates/new">Create a template</Link>
              </Button>
            }
          />
        )}
      </div>
    </>
  );
}

export function TemplateEditor({ template }: { template: TemplateRow | null }) {
  const router = useRouter();
  const { viewer, isAdmin } = useApp();
  const editor = useRef<RichTextHandle>(null);
  const [name, setName] = useState(template?.name ?? "");
  const [subject, setSubject] = useState(template?.subject ?? "");
  const [body, setBody] = useState(template?.body ?? "");
  const [shared, setShared] = useState(template?.shared ?? true);
  const [pending, start] = useTransition();
  const canEdit = !template || template.createdBy === viewer.id || isAdmin;
  const save = () =>
    start(async () => {
      const r = await saveTemplate(template?.id ?? null, { name, subject, body, shared });
      if (!r.ok) return void toast.error(r.error);
      toast.success("Template saved");
      router.push("/email/templates");
    });
  return (
    <div className="mx-auto max-w-3xl px-4 py-5 lg:px-6">
      <Link href="/email/templates" className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-primary">
        <ChevronLeftIcon className="size-4" />
        Templates
      </Link>
      <h1 className="text-page-title">{template ? template.name : "New template"}</h1>
      <div className="mt-5 flex flex-col gap-4">
        <Field label="Name" hint="Only your team sees this.">
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Proposal follow-up" disabled={!canEdit} />}
        </Field>
        <Field label="Subject">{(p) => <Input {...p} value={subject} onChange={(e) => setSubject(e.target.value)} disabled={!canEdit} />}</Field>
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-label">Message</span>
            <Menu>
              <MenuTrigger asChild>
                <Button size="sm" variant="ghost" disabled={!canEdit}>
                  <CodeBracketIcon />
                  Insert field
                </Button>
              </MenuTrigger>
              <MenuContent className="w-52">
                <MenuLabel>Filled in when sent</MenuLabel>
                {mergeTags.map((t) => (
                  <MenuItem key={t} onSelect={() => editor.current?.insert(`{{${t}}}`)}>
                    {mergeTagLabels[t]}
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
          </div>
          <RichText handle={editor} value={body} onChange={setBody} minHeight={220} placeholder="Hi {{first_name}}," onSubmit={save} />
        </div>
        <Checkbox checked={shared} onChange={(e) => setShared(e.target.checked)} label="Share with the team" disabled={!canEdit} />
        <div className="flex items-center gap-2 border-t border-line pt-4">
          {template && canEdit ? (
            <Button
              variant="ghost"
              className="text-error"
              onClick={() =>
                start(async () => {
                  if (!confirm(`Delete “${template.name}”?`)) return;
                  const r = await deleteTemplate(template.id);
                  if (!r.ok) return void toast.error(r.error);
                  router.push("/email/templates");
                })
              }
            >
              Delete
            </Button>
          ) : null}
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" asChild>
              <Link href="/email/templates">Cancel</Link>
            </Button>
            <Button variant="primary" loading={pending} onClick={save} disabled={!canEdit}>
              Save template
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
