"use client";

import clsx from "clsx";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { useEffect, useImperativeHandle, type ReactNode, type Ref } from "react";
import { BoldIcon, ItalicIcon, LinkIcon, ListBulletIcon, NumberedListIcon } from "@heroicons/react/20/solid";

export type RichTextHandle = { clear: () => void; focus: () => void; insert: (html: string) => void; setContent: (html: string) => void; isEmpty: () => boolean };

/**
 * The rich-text box used for notes, call summaries and email bodies. Small on
 * purpose: bold, italic, lists and links. ⌘/Ctrl+Enter submits.
 *
 * The toolbar sits above the text, and `actions` (a form's submit button,
 * "Insert field") sit at its right end, so the text is always the last thing
 * in the box, with no row of controls underneath it.
 */
export function RichText({
  value,
  onChange,
  onSubmit,
  placeholder,
  minHeight = 88,
  autoFocus,
  handle,
  className,
  toolbar = true,
  actions,
}: {
  value?: string;
  onChange?: (html: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  minHeight?: number;
  autoFocus?: boolean;
  handle?: Ref<RichTextHandle>;
  className?: string;
  toolbar?: boolean;
  actions?: ReactNode;
}) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        link: { openOnClick: false, autolink: true, defaultProtocol: "https", HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" } },
      }),
      Placeholder.configure({ placeholder: placeholder ?? "Write something…" }),
    ],
    content: value ?? "",
    autofocus: autoFocus ? "end" : false,
    editorProps: {
      attributes: { class: "prose-crm px-3 py-2.5 focus:outline-none", style: `min-height:${minHeight}px` },
      handleKeyDown: (_view, e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && onSubmit) {
          e.preventDefault();
          onSubmit();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => onChange?.(editor.isEmpty ? "" : editor.getHTML()),
  });

  useImperativeHandle(
    handle,
    () => ({
      clear: () => editor?.commands.clearContent(true),
      focus: () => editor?.commands.focus("end"),
      insert: (html: string) => editor?.chain().focus().insertContent(html).run(),
      setContent: (html: string) => editor?.commands.setContent(html, { emitUpdate: true }),
      isEmpty: () => editor?.isEmpty ?? true,
    }),
    [editor],
  );

  // Keep in step when the parent swaps the content (picking an email template).
  useEffect(() => {
    if (editor && value !== undefined && value !== (editor.isEmpty ? "" : editor.getHTML())) editor.commands.setContent(value, { emitUpdate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only external changes
  }, [value === "" ? "empty" : null, editor]);

  return (
    <div className={clsx("rounded-md border border-line bg-surface shadow-sm transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring", className)}>
      {toolbar || actions ? (
        <div className="flex min-h-[33px] flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-1.5 py-1">
          {toolbar ? editor ? <Toolbar editor={editor} /> : <div className="h-6" /> : null}
          {actions ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {editor ? (
        <EditorContent editor={editor} />
      ) : (
        // Same size as the editor, so nothing jumps when it mounts.
        <div className="prose-crm px-3 py-2.5 text-faint" style={{ minHeight }}>
          {placeholder ?? "Write something…"}
        </div>
      )}
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const btn = (active: boolean) => clsx("rounded p-1 transition-colors", active ? "bg-sunken text-primary" : "text-faint hover:bg-sunken hover:text-secondary");
  return (
    <div className="flex items-center gap-0.5">
      <button type="button" className={btn(editor.isActive("bold"))} onClick={() => editor.chain().focus().toggleBold().run()} aria-label="Bold" aria-pressed={editor.isActive("bold")}>
        <BoldIcon className="size-4" />
      </button>
      <button type="button" className={btn(editor.isActive("italic"))} onClick={() => editor.chain().focus().toggleItalic().run()} aria-label="Italic" aria-pressed={editor.isActive("italic")}>
        <ItalicIcon className="size-4" />
      </button>
      <button type="button" className={btn(editor.isActive("bulletList"))} onClick={() => editor.chain().focus().toggleBulletList().run()} aria-label="Bulleted list">
        <ListBulletIcon className="size-4" />
      </button>
      <button type="button" className={btn(editor.isActive("orderedList"))} onClick={() => editor.chain().focus().toggleOrderedList().run()} aria-label="Numbered list">
        <NumberedListIcon className="size-4" />
      </button>
      <button
        type="button"
        className={btn(editor.isActive("link"))}
        onClick={() => {
          if (editor.isActive("link")) return editor.chain().focus().unsetLink().run();
          const href = window.prompt("Link to");
          if (href) editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
        }}
        aria-label="Link"
      >
        <LinkIcon className="size-4" />
      </button>
    </div>
  );
}
