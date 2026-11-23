"use client";

import clsx from "clsx";
import { useRef, useState, type ReactNode } from "react";
import { useEditor, useEditorState, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { Color, FontSize, TextStyle } from "@tiptap/extension-text-style";
import { BoldIcon, ItalicIcon, LinkIcon, MinusIcon, PhotoIcon, StrikethroughIcon, UnderlineIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Menu, MenuContent, MenuItem, MenuTrigger, Popover, PopoverAnchor, PopoverContent } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { signatureImageWidth, signatureInk, signatureSizes } from "@/lib/email/signature-style";

/**
 * The email signature editor: Tiptap with what a signature needs and nothing
 * else. Bold, italic, underline, strikethrough, links, text color and size,
 * images (uploaded or from a link, resized by dragging a corner) and a
 * divider. Lines sit close together, the way they go out under an email.
 * What it writes is sanitized again on the server (`sanitizeSignatureHtml`).
 */
export function SignatureEditor({ value, onChange, canUpload }: { value: string; onChange: (html: string) => void; canUpload: boolean }) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        code: false,
        codeBlock: false,
        link: { openOnClick: false, autolink: true, defaultProtocol: "https", HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } },
      }),
      TextStyle,
      Color,
      FontSize,
      Image.configure({ inline: true, allowBase64: false, resize: { enabled: true, directions: ["top-left", "top-right", "bottom-left", "bottom-right"], minWidth: 24, minHeight: 24, alwaysPreserveAspectRatio: true } }),
      Placeholder.configure({ placeholder: "Your name, title, phone and a link or two…" }),
    ],
    content: value,
    editorProps: { attributes: { class: "prose-signature min-h-28 px-3 py-2.5 focus:outline-none", "aria-label": "Email signature", role: "textbox", "aria-multiline": "true" } },
    onUpdate: ({ editor }) => onChange(editor.isEmpty ? "" : editor.getHTML()),
  });

  return (
    <div className="rounded-lg border border-line bg-surface focus-within:border-ring">
      {editor ? <Toolbar editor={editor} canUpload={canUpload} /> : <div className="h-10 border-b border-line" />}
      {editor ? <EditorContent editor={editor} /> : <div className="min-h-28" />}
    </div>
  );
}

function Tool({ label, active, onClick, children, disabled }: { label: string; active?: boolean; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      className={clsx("rounded p-1.5 transition-colors disabled:opacity-40", active ? "bg-sunken text-primary" : "text-faint hover:bg-sunken hover:text-secondary")}
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

const Divider = () => <span className="mx-1 h-5 w-px bg-line" aria-hidden />;

function Toolbar({ editor, canUpload }: { editor: Editor; canUpload: boolean }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      link: e.isActive("link"),
      href: (e.getAttributes("link").href as string | undefined) ?? "",
      color: (e.getAttributes("textStyle").color as string | undefined) ?? "",
      size: (e.getAttributes("textStyle").fontSize as string | undefined) ?? "",
    }),
  });
  const [asking, setAsking] = useState<"link" | "image" | null>(null);
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const upload = async (f: File) => {
    setUploading(true);
    const form = new FormData();
    form.set("file", f);
    const res = await fetch("/api/signature/image", { method: "POST", body: form }).catch(() => null);
    const json = res ? await res.json().catch(() => ({})) : {};
    setUploading(false);
    if (!res?.ok) return void toast.error(json.error ?? "Couldn't upload the image. Try again, or add it from a link.");
    addImage(json.url);
  };
  // A new image starts no wider than a signature needs; drag a corner to resize it.
  const addImage = (src: string) => {
    const probe = new window.Image();
    probe.onload = () => {
      const width = Math.min(probe.naturalWidth || signatureImageWidth, signatureImageWidth);
      const height = probe.naturalWidth ? Math.round((probe.naturalHeight / probe.naturalWidth) * width) : undefined;
      editor.chain().focus().setImage({ src, alt: "", width, height }).run();
    };
    probe.onerror = () => toast.error("That image didn't load. Check the link is to an image anyone can open.");
    probe.src = src;
  };

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-line px-1.5 py-1">
      <Tool label="Bold" active={state.bold} onClick={() => editor.chain().focus().toggleBold().run()}>
        <BoldIcon className="size-4" />
      </Tool>
      <Tool label="Italic" active={state.italic} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <ItalicIcon className="size-4" />
      </Tool>
      <Tool label="Underline" active={state.underline} onClick={() => editor.chain().focus().toggleUnderline().run()}>
        <UnderlineIcon className="size-4" />
      </Tool>
      <Tool label="Strikethrough" active={state.strike} onClick={() => editor.chain().focus().toggleStrike().run()}>
        <StrikethroughIcon className="size-4" />
      </Tool>
      <Divider />
      <label className="relative flex items-center rounded p-1.5 text-faint hover:bg-sunken hover:text-secondary" title="Text color">
        <span className="sr-only">Text color</span>
        <span className="flex size-4 flex-col items-center justify-center text-[13px] leading-none font-semibold" aria-hidden>
          A
          <span className="mt-0.5 h-1 w-4 rounded-sm border border-line" style={{ background: state.color || signatureInk }} />
        </span>
        <input type="color" className="absolute inset-0 cursor-pointer opacity-0" value={state.color || signatureInk} onChange={(e) => editor.chain().focus().setColor(e.target.value).run()} />
      </label>
      {state.color ? (
        <Tool label="Default color" onClick={() => editor.chain().focus().unsetColor().run()}>
          <XMarkIcon className="size-3.5" />
        </Tool>
      ) : null}
      <Select
        aria-label="Text size"
        value={state.size}
        onChange={(e) => (e.target.value ? editor.chain().focus().setFontSize(e.target.value).run() : editor.chain().focus().unsetFontSize().run())}
        className="w-24 [&_select]:h-7 [&_select]:text-[12.5px]"
      >
        {signatureSizes.map((s) => (
          <option key={s.label} value={s.value}>
            {s.label}
          </option>
        ))}
      </Select>
      <Divider />
      <Popover open={asking !== null} onOpenChange={(o) => !o && setAsking(null)}>
        <PopoverAnchor asChild>
          <span className="flex items-center gap-0.5">
            <Tool
              label={state.link ? "Remove link" : "Link"}
              active={state.link}
              onClick={() => (state.link ? editor.chain().focus().extendMarkRange("link").unsetLink().run() : setAsking("link"))}
            >
              <LinkIcon className="size-4" />
            </Tool>
            {canUpload ? (
              <Menu>
                <MenuTrigger asChild>
                  <button type="button" className="rounded p-1.5 text-faint transition-colors hover:bg-sunken hover:text-secondary disabled:opacity-40" aria-label="Image" title="Image" disabled={uploading}>
                    <PhotoIcon className="size-4" />
                  </button>
                </MenuTrigger>
                <MenuContent align="start" className="w-48">
                  <MenuItem onSelect={() => file.current?.click()}>Upload an image</MenuItem>
                  <MenuItem onSelect={() => setAsking("image")}>Add from a link</MenuItem>
                </MenuContent>
              </Menu>
            ) : (
              <Tool label="Image" onClick={() => setAsking("image")}>
                <PhotoIcon className="size-4" />
              </Tool>
            )}
          </span>
        </PopoverAnchor>
        <PopoverContent className="w-80 p-3" onOpenAutoFocus={(e) => e.preventDefault()}>
          {asking ? (
            <UrlForm
              key={asking}
              label={asking === "link" ? "Link to" : "Image address"}
              placeholder={asking === "link" ? "https://acme.com or name@acme.com" : "https://…/headshot.png"}
              onSubmit={(url, typed) => {
                setAsking(null);
                if (asking === "image") return addImage(url);
                const href = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(url) ? `mailto:${url}` : url;
                if (editor.state.selection.empty) editor.chain().focus().insertContent({ type: "text", text: typed, marks: [{ type: "link", attrs: { href } }] }).run();
                else editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
              }}
            />
          ) : null}
        </PopoverContent>
      </Popover>
      <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void upload(f);
        }}
      />
      <Tool label="Divider line" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
        <MinusIcon className="size-4" />
      </Tool>
      <span className="ml-auto">
        <Button size="sm" variant="ghost" className="h-7 text-muted" onClick={() => editor.chain().focus().unsetAllMarks().run()}>
          Clear formatting
        </Button>
      </span>
      {uploading ? <span className="w-full px-1.5 pb-0.5 text-fine">Uploading the image…</span> : null}
    </div>
  );
}

/** Asks for an address. `onSubmit` gets it with a scheme added when it had none, and as typed, for a link's text. */
function UrlForm({ label, placeholder, onSubmit }: { label: string; placeholder: string; onSubmit: (url: string, typed: string) => void }) {
  const [url, setUrl] = useState("");
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const v = url.trim();
        if (!v) return;
        onSubmit(/^[a-z][a-z0-9+.-]*:/i.test(v) || v.includes("@") ? v : `https://${v}`, v);
      }}
    >
      <label className="text-[12.5px] font-medium text-secondary" htmlFor="signature-url">
        {label}
      </label>
      <div className="flex gap-2">
        <Input id="signature-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={placeholder} autoFocus className="h-8 text-[13px]" />
        <Button type="submit" size="sm" variant="primary" disabled={!url.trim()}>
          Add
        </Button>
      </div>
    </form>
  );
}
