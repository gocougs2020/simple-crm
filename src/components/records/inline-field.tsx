"use client";

import clsx from "clsx";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { CheckIcon, ClipboardDocumentIcon, PencilIcon } from "@heroicons/react/20/solid";
import { Spinner } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";

type SaveResult = { ok: true } | { ok: false; error: string };

/**
 * A label and value that turns into its editor on click. Enter (or leaving
 * the field) saves, Escape cancels. One save per field keeps the history
 * precise: "changed Phone", not "updated person".
 */
export function InlineField<T>({
  label,
  value,
  display,
  empty = "Add",
  editor,
  onSave,
  copy,
  multiline,
  readOnly,
}: {
  label: string;
  value: T;
  display?: ReactNode;
  empty?: string;
  /** Renders the control. `commit` saves now (for selects and pickers that finish on pick). */
  editor: (p: { value: T; setValue: (v: T) => void; commit: (v?: T) => void; cancel: () => void; autoFocus: true }) => ReactNode;
  onSave: (v: T) => Promise<SaveResult>;
  copy?: string | null;
  multiline?: boolean;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [pending, start] = useTransition();
  const [copied, setCopied] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  const commit = (v: T = draft) => {
    if (JSON.stringify(v) === JSON.stringify(value)) return setEditing(false);
    start(async () => {
      const r = await onSave(v);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setEditing(false);
    });
  };
  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  useEffect(() => {
    if (!editing) return;
    // Clicking outside saves, like leaving a spreadsheet cell.
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (wrap.current && !wrap.current.contains(t) && !t.closest("[role=listbox],[data-radix-popper-content-wrapper]")) commit();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  });

  const isEmpty = value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);

  return (
    <div ref={wrap} className="group grid grid-cols-[7.5rem_minmax(0,1fr)] items-start gap-2 py-1.5">
      <dt className="pt-1.5 text-[12.5px] text-muted">{label}</dt>
      <dd className="min-w-0">
        {editing ? (
          <div
            className="flex items-start gap-1.5"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                cancel();
              }
              if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey) && !(e.target as HTMLElement).closest("[role=combobox]")) {
                e.preventDefault();
                commit();
              }
            }}
          >
            <div className="min-w-0 flex-1">{editor({ value: draft, setValue: setDraft, commit, cancel, autoFocus: true })}</div>
            {pending ? <Spinner className="mt-2.5 size-4 text-faint" /> : null}
          </div>
        ) : (
          <div className="flex min-h-8 items-center gap-1">
            <button
              type="button"
              disabled={readOnly}
              onClick={() => {
                setDraft(value);
                setEditing(true);
              }}
              className={clsx(
                "min-w-0 flex-1 rounded-md px-2 py-1.5 text-left text-[13.5px] transition-colors -mx-2",
                readOnly ? "cursor-default" : "hover:bg-sunken",
                isEmpty ? "text-faint" : "text-primary",
                multiline ? "whitespace-pre-wrap" : "truncate",
              )}
              aria-label={`Edit ${label}`}
            >
              {isEmpty ? (readOnly ? "—" : empty) : (display ?? String(value))}
            </button>
            {copy ? (
              <button
                type="button"
                onClick={async () => {
                  await navigator.clipboard.writeText(copy);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                }}
                className="rounded p-1 text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-primary focus:opacity-100"
                aria-label={`Copy ${label}`}
              >
                {copied ? <CheckIcon className="size-3.5 text-success" /> : <ClipboardDocumentIcon className="size-3.5" />}
              </button>
            ) : !readOnly ? (
              <PencilIcon className="size-3 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
            ) : null}
          </div>
        )}
      </dd>
    </div>
  );
}

/** A titled card on a record page's side column. */
export function SideCard({ title, action, children, className }: { title: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx("rounded-xl border border-line bg-surface", className)}>
      <header className="flex items-center justify-between gap-2 px-4 pt-3 pb-1">
        <h2 className="text-[13px] font-semibold text-primary">{title}</h2>
        {action}
      </header>
      <div className="px-4 pb-3">{children}</div>
    </section>
  );
}
