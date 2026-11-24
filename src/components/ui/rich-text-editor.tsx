"use client";

import clsx from "clsx";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Selection } from "@tiptap/pm/state";
import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { BoldIcon, ItalicIcon, LinkIcon, ListBulletIcon, NumberedListIcon } from "@heroicons/react/20/solid";
import { Dictation } from "@/components/dictation/dictation";
import { matchMentions } from "@/lib/crm/mentions";
import { mentionQuery } from "@/lib/chat/format";
import { MentionMenu, type MentionOption } from "./mention-menu";
import { RichTextFrame, type RichTextHandle, type RichTextProps } from "./rich-text";

/** The "@name" being typed at the cursor: what it says, where it starts and ends in the document, and where to show the list. */
type Typing = { query: string; from: number; to: number; top: number; left: number };

/**
 * The editor itself: Tiptap and ProseMirror. Loaded on demand through
 * `RichText` (./rich-text.tsx), so pages that never show a text box don't
 * download it. Bold, italic, lists and links; ⌘/Ctrl+Enter submits.
 */
export function RichTextEditor({
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
  dictation,
  mentions,
}: RichTextProps) {
  /** Whether the teammate has put the cursor somewhere in the text (clicked, tabbed in, or typed). */
  const placed = useRef(false);
  const frame = useRef<HTMLDivElement>(null);
  const [typing, setTyping] = useState<Typing | null>(null);
  const [active, setActive] = useState(0);
  /** The "@" the teammate closed the list on with Escape: it stays closed until they type another. */
  const [dismissed, setDismissed] = useState<number | null>(null);
  const lastTyped = useRef<string | null>(null);
  const people = useMemo(() => (typing && mentions ? matchMentions(mentions, typing.query) : []), [typing, mentions]);
  const open = !!typing && people.length > 0 && dismissed !== typing.from;

  /** Finds an "@name" right before the cursor, in the paragraph it's in. */
  const detect = (ed: Editor) => {
    const { selection } = ed.state;
    const { $from } = selection;
    if (!mentions?.length || !selection.empty || !$from.parent.isTextblock) {
      setDismissed(null);
      return setTyping(null);
    }
    // Line breaks and other inline nodes count as one character each, so offsets match the document.
    const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "\n");
    const q = mentionQuery(before, before.length);
    if (!q) {
      // The "@" closed with Escape is gone (deleted, picked past, or the note was sent): the next "@" opens the list again.
      setDismissed(null);
      return setTyping(null);
    }
    const from = $from.start() + q.start;
    const at = ed.view.coordsAtPos(from);
    const box = frame.current?.getBoundingClientRect();
    const top = box ? at.bottom - box.top + 4 : 0;
    const left = box ? Math.max(0, Math.min(at.left - box.left, box.width - 256)) : 0;
    // A new "@" or more letters start the list from the top again.
    const key = `${from}:${q.query}`;
    if (lastTyped.current !== key) setActive(0);
    lastTyped.current = key;
    setTyping({ query: q.query, from, to: selection.from, top, left });
  };

  // ProseMirror's key handler is set once, so it reads the list through this.
  const menu = useRef<{ open: boolean; people: MentionOption[]; active: number; pick: (m: MentionOption) => void; typing: Typing | null }>({ open: false, people: [], active: 0, pick: () => {}, typing: null });

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
        const m = menu.current;
        if (m.open) {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => (a + (e.key === "ArrowDown" ? 1 : m.people.length - 1)) % m.people.length);
            return true;
          }
          if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") {
            e.preventDefault();
            m.pick(m.people[m.active] ?? m.people[0]);
            return true;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            setDismissed(m.typing!.from);
            return true;
          }
        }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && onSubmit) {
          e.preventDefault();
          onSubmit();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      onChange?.(editor.isEmpty ? "" : editor.getHTML());
      detect(editor);
    },
    onSelectionUpdate: ({ editor }) => detect(editor),
    onFocus: () => {
      placed.current = true;
    },
    onBlur: () => setTyping(null),
  });

  const pick = (m: MentionOption) => {
    if (!editor || !typing) return;
    editor.chain().focus().insertContentAt({ from: typing.from, to: typing.to }, { type: "text", text: `${m.insert} ` }).run();
    setTyping(null);
  };
  useEffect(() => {
    menu.current = { open, people, active, pick, typing };
  });

  /** Puts dictated text at the cursor (replacing a selection), or at the end, with spaces so it never runs into the words around it. */
  const insertSpoken = (text: string) => {
    if (!editor) return;
    const { doc, selection } = editor.state;
    const end = Selection.atEnd(doc).from;
    const from = placed.current ? selection.from : end;
    const to = placed.current ? selection.to : end;
    const before = doc.textBetween(Math.max(0, from - 1), from, "\n", "\n");
    const after = doc.textBetween(to, Math.min(doc.content.size, to + 1), "\n", "\n");
    const spaced = `${before && !/\s$/.test(before) ? " " : ""}${text}${after && !/^[\s.,;:!?)]/.test(after) ? " " : ""}`;
    editor.chain().focus().insertContentAt({ from, to }, { type: "text", text: spaced }).run();
    placed.current = true;
  };

  // No handle until the editor exists: until then RichText applies changes through `onChange`.
  useImperativeHandle(
    handle,
    () =>
      (editor
        ? {
            clear: () => {
              editor.commands.clearContent(true);
              placed.current = false;
            },
            focus: () => editor.commands.focus("end"),
            insert: (html: string) => editor.chain().focus().insertContent(html).run(),
            setContent: (html: string) => editor.commands.setContent(html, { emitUpdate: true }),
            isEmpty: () => editor.isEmpty,
          }
        : null) as RichTextHandle,
    [editor],
  );

  // Keep in step when the parent swaps the content (picking an email template).
  useEffect(() => {
    if (editor && value !== undefined && value !== (editor.isEmpty ? "" : editor.getHTML())) editor.commands.setContent(value, { emitUpdate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only external changes
  }, [value === "" ? "empty" : null, editor]);

  return (
    <RichTextFrame
      className={className}
      toolbar={toolbar}
      tools={editor ? <Toolbar editor={editor} /> : null}
      actions={actions}
      dictation={dictation ? <Dictation onText={insertSpoken} disabled={!editor} /> : null}
      placeholder={placeholder}
      minHeight={minHeight}
    >
      {editor ? <EditorContent editor={editor} /> : null}
      <div ref={frame} className="pointer-events-none absolute inset-0" aria-hidden />
      {open && typing ? <MentionMenu people={people} active={active} onPick={pick} onHover={setActive} style={{ top: typing.top, left: typing.left }} /> : null}
    </RichTextFrame>
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
