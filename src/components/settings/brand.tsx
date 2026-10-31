"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { previewBrand, updateBrand } from "@/actions/settings";
import { useApp } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import type { BrandKit } from "@/db/schema";
import { Section } from "./nav";

/**
 * The brand kit: what every email from the CRM is wrapped in. One-off emails
 * and campaigns both use it, so they look consistent without anyone thinking
 * about it. The app's own look is set in code (src/styles/theme.css).
 */
export function BrandSettings({ brand }: { brand: BrandKit }) {
  const { services } = useApp();
  const [kit, setKit] = useState<Required<{ [K in keyof BrandKit]: string }>>({
    logoUrl: brand.logoUrl ?? "",
    accentColor: brand.accentColor ?? "",
    senderName: brand.senderName ?? "",
    replyTo: brand.replyTo ?? "",
    postalAddress: brand.postalAddress ?? "",
    website: brand.website ?? "",
    signature: brand.signature ?? "",
  });
  const [preview, setPreview] = useState("");
  const [pending, start] = useTransition();
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const set = (k: keyof typeof kit) => (e: { target: { value: string } }) => setKit((x) => ({ ...x, [k]: e.target.value }));

  useEffect(() => {
    const t = setTimeout(() => previewBrand(kit).then(setPreview, () => {}), 300);
    return () => clearTimeout(t);
  }, [kit]);

  const upload = async (f: File) => {
    setUploading(true);
    const form = new FormData();
    form.set("file", f);
    const res = await fetch("/api/brand/logo", { method: "POST", body: form });
    const json = await res.json().catch(() => ({}));
    setUploading(false);
    if (!res.ok) return void toast.error(json.error ?? "Couldn't upload the logo.");
    setKit((x) => ({ ...x, logoUrl: json.url }));
  };

  return (
    <Section title="Email brand kit" description="Wraps every email sent from the CRM: one-off emails from records, and campaigns.">
      <div className="grid gap-6 p-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await updateBrand(kit);
              if (r.ok) toast.success("Brand kit saved");
              else toast.error(r.error);
            });
          }}
        >
          <Field label="Logo" optional hint="A wide PNG about 56px tall looks best. It's public so inboxes can show it.">
            {(p) => (
              <div className="flex gap-2">
                <Input {...p} value={kit.logoUrl} onChange={set("logoUrl")} placeholder="https://…/logo.png" />
                {services.blob ? (
                  <>
                    <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
                    <Button variant="outline" loading={uploading} onClick={() => file.current?.click()}>
                      Upload
                    </Button>
                  </>
                ) : null}
              </div>
            )}
          </Field>
          <Field label="Button and link color" optional>
            {(p) => (
              <div className="flex gap-2">
                <input type="color" value={kit.accentColor || "#18181b"} onChange={set("accentColor")} className="h-9 w-12 cursor-pointer rounded-md border border-line bg-surface p-1" aria-label="Pick a color" />
                <Input {...p} value={kit.accentColor} onChange={set("accentColor")} placeholder="#18181b" className="w-32 font-mono" />
              </div>
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Sender name" optional hint="Campaigns come from this name. One-off emails show “Your name · Sender name”.">
              {(p) => <Input {...p} value={kit.senderName} onChange={set("senderName")} placeholder="Acme" />}
            </Field>
            <Field label="Campaign reply-to" optional hint="One-off emails always reply to the sender.">
              {(p) => <Input {...p} type="email" value={kit.replyTo} onChange={set("replyTo")} placeholder="hello@acme.com" />}
            </Field>
          </div>
          <Field label="Website" optional>
            {(p) => <Input {...p} type="url" value={kit.website} onChange={set("website")} placeholder="https://acme.com" />}
          </Field>
          <Field label="Postal address" hint="Required by law (CAN-SPAM) in marketing email. Shown in every email footer.">
            {(p) => <Textarea {...p} value={kit.postalAddress} onChange={set("postalAddress")} rows={2} placeholder="123 Main St, Boise, ID 83702" />}
          </Field>
          <Field label="Signature" optional hint="Added under one-off emails. {{sender_name}} and {{sender_title}} fill in for whoever sends.">
            {(p) => <Textarea {...p} value={kit.signature} onChange={set("signature")} rows={3} placeholder={"{{sender_name}}\n{{sender_title}}\nAcme · (208) 555-0100"} className="font-mono text-[13px]" />}
          </Field>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={pending}>
              Save brand kit
            </Button>
          </div>
          {!services.email ? <p className="text-fine">Sending isn&apos;t connected: set RESEND_API_KEY and RESEND_FROM (a sender on a domain you&apos;ve verified in Resend).</p> : services.emailFrom ? <p className="text-fine">Emails send from {services.emailFrom}.</p> : null}
        </form>
        <div>
          <p className="mb-2 text-label">Preview</p>
          {preview ? <iframe title="Brand kit preview" sandbox="allow-same-origin" srcDoc={preview} className="h-[520px] w-full rounded-lg border border-line bg-white" /> : <div className="h-[520px] animate-pulse rounded-lg bg-sunken" />}
        </div>
      </div>
    </Section>
  );
}
