"use client";

import clsx from "clsx";
import dynamic from "next/dynamic";
import { createContext, useContext, useImperativeHandle, useRef, type ReactNode, type Ref } from "react";
import { Dictation } from "@/components/dictation/dictation";
import type { MentionOption } from "./mention-menu";

export type RichTextHandle = { clear: () => void; focus: () => void; insert: (html: string) => void; setContent: (html: string) => void; isEmpty: () => boolean };

export type RichTextProps = {
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
  dictation?: boolean;
  /** Teammates "@" offers (useMentionOptions), for text that notifies whoever it mentions: notes and replies. */
  mentions?: MentionOption[];
};

const loadEditor = () => import("./rich-text-editor");
let editorModule: ReturnType<typeof loadEditor> | null = null;

/**
 * Starts downloading the editor (Tiptap and ProseMirror) without showing it.
 * Called when a text box is about to open (pointer over or focus on what
 * opens it) and once when the browser is idle, so it's there before anyone
 * needs it. Safe to call any number of times.
 */
export function preloadRichText() {
  editorModule ??= loadEditor().catch((err) => {
    editorModule = null;
    throw err;
  });
  return editorModule;
}

/** Preloads the editor once the browser is idle after the first paint. */
export function preloadRichTextWhenIdle() {
  const run = () => void preloadRichText().catch(() => {});
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(run, { timeout: 4000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(run, 1500);
  return () => window.clearTimeout(id);
}

/** What the placeholder needs from the props, while the editor loads. */
const Pending = createContext<RichTextProps>({});

const Editor = dynamic(() => import("./rich-text-editor").then((m) => m.RichTextEditor), {
  ssr: false,
  loading: function Loading() {
    const p = useContext(Pending);
    return (
      <RichTextFrame
        className={p.className}
        toolbar={p.toolbar ?? true}
        tools={null}
        actions={p.actions}
        dictation={p.dictation ? <Dictation onText={() => {}} disabled /> : null}
        placeholder={p.placeholder}
        minHeight={p.minHeight ?? 88}
      >
        {null}
      </RichTextFrame>
    );
  },
});

/**
 * The rich-text box used for notes, call summaries and email bodies. Small on
 * purpose: bold, italic, lists and links. ⌘/Ctrl+Enter submits.
 *
 * The toolbar sits above the text; `actions` (like "Insert field") sit at
 * its right end. `dictation` adds a microphone there: what's said is
 * transcribed and goes in at the cursor, or at the end if nobody has placed
 * one in the text yet.
 *
 * The editor loads on demand. Until it arrives this shows an empty box of
 * the same size, and `value` is what the editor starts with when it mounts,
 * so nothing set before then is lost.
 */
export function RichText({ handle, ...props }: RichTextProps) {
  const inner = useRef<RichTextHandle>(null);
  const latest = useRef(props);
  // eslint-disable-next-line react-hooks/refs -- read by the handle's callbacks, never during render
  latest.current = props;
  // Before the editor has mounted, changes go through `onChange`, so the editor starts with them.
  useImperativeHandle(
    handle,
    () => ({
      clear: () => (inner.current ? inner.current.clear() : latest.current.onChange?.("")),
      focus: () => inner.current?.focus(),
      insert: (html: string) => (inner.current ? inner.current.insert(html) : latest.current.onChange?.(`${latest.current.value ?? ""}${html}`)),
      setContent: (html: string) => (inner.current ? inner.current.setContent(html) : latest.current.onChange?.(html)),
      isEmpty: () => (inner.current ? inner.current.isEmpty() : !latest.current.value),
    }),
    [],
  );
  return (
    <Pending.Provider value={props}>
      <Editor {...props} handle={inner} />
    </Pending.Provider>
  );
}

/**
 * The box around the editor: border, toolbar row and text area. Shared by the
 * editor and the placeholder shown while it loads, so nothing jumps when it
 * arrives. `children` is the editor; without it the box shows the placeholder text.
 */
export function RichTextFrame({
  className,
  toolbar,
  tools,
  actions,
  dictation,
  placeholder,
  minHeight,
  children,
}: {
  className?: string;
  toolbar: boolean;
  tools: ReactNode;
  actions?: ReactNode;
  dictation: ReactNode;
  placeholder?: string;
  minHeight: number;
  children: ReactNode;
}) {
  return (
    <div className={clsx("relative rounded-md border border-line bg-surface shadow-sm transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring", className)}>
      {toolbar || actions || dictation ? (
        <div className="flex min-h-[33px] flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-1.5 py-1">
          {toolbar ? (tools ?? <div className="h-6" />) : null}
          {actions || dictation ? (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {actions}
              {dictation}
            </div>
          ) : null}
        </div>
      ) : null}
      {children ?? (
        // Same size as the editor, so nothing jumps when it mounts.
        <div className="prose-crm px-3 py-2.5 text-faint" style={{ minHeight }}>
          {placeholder ?? "Write something…"}
        </div>
      )}
    </div>
  );
}
