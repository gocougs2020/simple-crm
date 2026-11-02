"use client";

import clsx from "clsx";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { PlusIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { lookupRecords } from "@/actions/records";
import { Spinner } from "@/components/ui/button";

export type PickedRecord = { id: string; label: string; detail?: string; organizationId?: string | null; personId?: string | null };
/** A picked record, or the name of one to create on save. */
export type PickerValue = { record: PickedRecord } | { create: string } | null;

/**
 * Typeahead for linking a person, organization or client. Typing a name that
 * doesn't exist offers to create it, so nobody has to leave the form.
 */
export function RecordPicker({
  kind,
  value,
  onChange,
  placeholder,
  allowCreate = true,
  id,
  autoFocus,
}: {
  kind: "person" | "organization" | "client";
  value: PickerValue;
  onChange: (v: PickerValue) => void;
  placeholder?: string;
  allowCreate?: boolean;
  id?: string;
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<PickedRecord[]>([]);
  const [active, setActive] = useState(0);
  const [pending, start] = useTransition();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => start(async () => setResults(await lookupRecords(kind, q))), q ? 120 : 0);
    return () => clearTimeout(t);
  }, [q, open, kind]);

  const term = q.trim();
  const showCreate = allowCreate && term.length > 0 && !results.some((r) => r.label.toLowerCase() === term.toLowerCase());
  const options = [...results.map((r) => ({ type: "record" as const, r })), ...(showCreate ? [{ type: "create" as const }] : [])];

  const choose = (i: number) => {
    const o = options[i];
    if (!o) return;
    onChange(o.type === "record" ? { record: o.r } : { create: term });
    setQ("");
    setOpen(false);
  };

  if (value) {
    const label = "record" in value ? value.record.label : value.create;
    return (
      <div className="flex h-9 items-center gap-2 rounded-md border border-line bg-surface pr-1 pl-3 shadow-sm">
        <span className="min-w-0 flex-1 truncate text-[14px] text-primary">
          {label}
          {"create" in value ? <span className="ml-1.5 text-[12px] text-muted">new</span> : "record" in value && value.record.detail ? <span className="ml-1.5 text-[12px] text-muted">{value.record.detail}</span> : null}
        </span>
        <button
          type="button"
          onClick={() => {
            onChange(null);
            setTimeout(() => inputRef.current?.focus());
          }}
          className="rounded p-1 text-faint hover:bg-sunken hover:text-primary"
          aria-label="Clear"
        >
          <XMarkIcon className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <input
        ref={inputRef}
        id={id}
        autoFocus={autoFocus}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, options.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && options.length) {
            e.preventDefault();
            choose(active);
          } else if (e.key === "Escape") {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        placeholder={placeholder ?? (kind === "person" ? "Search people" : kind === "organization" ? "Search organizations" : "Search clients")}
        className="h-9 w-full rounded-md border border-line bg-surface px-3 text-[14px] text-primary shadow-sm placeholder:text-faint hover:border-line-strong focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
      />
      {pending ? <Spinner className="absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-faint" /> : null}
      {open && (options.length > 0 || term) ? (
        <ul id={listId} role="listbox" className="absolute top-full right-0 left-0 z-50 mt-1 max-h-64 animate-pop-in overflow-auto rounded-lg border border-line bg-surface p-1 shadow-md">
          {options.map((o, i) => (
            <li
              key={o.type === "record" ? o.r.id : "create"}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(i)}
              onMouseMove={() => setActive(i)}
              className={clsx("flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-[13.5px]", i === active ? "bg-sunken text-primary" : "text-secondary")}
            >
              {o.type === "record" ? (
                <>
                  <span className="truncate">{o.r.label}</span>
                  {o.r.detail ? <span className="truncate text-[12px] text-muted">{o.r.detail}</span> : null}
                </>
              ) : (
                <>
                  <PlusIcon className="size-4 text-muted" aria-hidden />
                  <span className="truncate">
                    Add “{term}” as a new {kind}
                  </span>
                </>
              )}
            </li>
          ))}
          {!options.length && !pending ? <li className="px-2 py-1.5 text-[13px] text-muted">No matches</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
