"use client";

import clsx from "clsx";
import Link from "next/link";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CheckIcon, ChevronUpDownIcon } from "@heroicons/react/20/solid";
import { useApp } from "@/components/app-context";
import { Tag } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger, Tooltip } from "@/components/ui/menu";

/**
 * Labels on records. A label is a string in a record's `tags`; its
 * definition (Settings → Labels) gives it a description, shown on hover and
 * in the picker, and can hide it from the app. A label with no definition
 * still shows: it just has nothing to explain it yet.
 */

/** Looks labels up by name, and says which ones the app shows. */
export function useLabels() {
  const { labels } = useApp();
  return useMemo(() => {
    const byName = new Map(labels.map((l) => [l.name, l]));
    return {
      all: labels,
      get: (name: string) => byName.get(name),
      shown: (names: readonly string[]) => names.filter((n) => !byName.get(n)?.hidden),
    };
  }, [labels]);
}

/** One label as a chip. Hover or focus shows what it means, and where it comes from when it's carried from an organization. */
export function LabelChip({ name, from, className, onRemove }: { name: string; from?: string | null; className?: string; onRemove?: () => void }) {
  const { get } = useLabels();
  const label = get(name);
  if (label?.hidden) return null;
  const hint = [label?.description, from ? `Carried from ${from}.` : null].filter(Boolean).join(" ");
  return (
    <Tooltip content={hint}>
      <span tabIndex={hint ? 0 : undefined} className="inline-flex rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <Tag onRemove={onRemove} className={clsx(from && "border-dashed text-muted", className)}>
          {name}
        </Tag>
      </span>
    </Tooltip>
  );
}

/** A record's labels as chips: its own, then the ones it carries from its organization. */
export function LabelChips({ names, carried, max }: { names: readonly string[]; carried?: { names: readonly string[]; from: string } | null; max?: number }) {
  const { shown } = useLabels();
  const own = shown(names);
  const extra = carried ? shown(carried.names).filter((n) => !own.includes(n)) : [];
  const all = [...own.map((n) => ({ name: n, from: null as string | null })), ...extra.map((n) => ({ name: n, from: carried!.from }))];
  if (!all.length) return null;
  const list = max ? all.slice(0, max) : all;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {list.map((l) => (
        <LabelChip key={`${l.from ?? ""}:${l.name}`} name={l.name} from={l.from} />
      ))}
      {all.length > list.length ? <span className="text-[12px] text-muted">+{all.length - list.length}</span> : null}
    </span>
  );
}

/**
 * The dropdown for a record's labels: the workspace's labels with what each
 * means, the record's own checked. It opens as soon as the field is edited
 * and saves when it closes (Escape closes it without saving). Hidden labels the record already has aren't
 * listed, and stay on it.
 */
export function LabelPicker({ value, onChange, onDone }: { value: string[]; onChange: (next: string[]) => void; onDone: (next: string[]) => void }) {
  const { all, get } = useLabels();
  const { isAdmin } = useApp();
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState(value);
  const [q, setQ] = useState("");
  // The workspace's labels, plus any on this record that have no definition yet.
  const options = useMemo(() => {
    const defined = all.filter((l) => !l.hidden).map((l) => ({ name: l.name, description: l.description }));
    const loose = value.filter((n) => !get(n)).map((n) => ({ name: n, description: null as string | null }));
    return [...defined, ...loose].sort((a, b) => a.name.localeCompare(b.name));
  }, [all, get, value]);
  const term = q.trim().toLowerCase();
  const matches = term ? options.filter((o) => o.name.includes(term) || o.description?.toLowerCase().includes(term)) : options;
  const visible = selected.filter((n) => !get(n)?.hidden);
  // Escape closes without saving, like the other fields.
  const discard = useRef(false);
  // The field around this saves on Enter. Here Enter (and Space) pick an option or open the list, so they stay inside the picker.
  const keepKeys = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") e.stopPropagation();
  };
  // Each pick is reported as it's made, so the field has the current choice however it ends up closing (a click elsewhere on the page included).
  const toggle = (name: string) => {
    const next = selected.includes(name) ? selected.filter((x) => x !== name) : [...selected, name];
    setSelected(next);
    onChange(next);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) onDone(discard.current ? value : selected);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Labels"
          onKeyDown={keepKeys}
          className="flex min-h-8 w-full items-center gap-1.5 rounded-md border border-ring bg-surface py-1 pr-1.5 pl-2 text-left text-[13.5px] ring-1 ring-ring"
        >
          <span className="flex min-w-0 flex-1 flex-wrap gap-1">
            {visible.length ? visible.map((n) => <Tag key={n}>{n}</Tag>) : <span className="text-faint">Select labels</span>}
          </span>
          <ChevronUpDownIcon className="size-4 shrink-0 text-faint" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[max(var(--radix-popover-trigger-width),17rem)] p-1"
        onKeyDown={keepKeys}
        onEscapeKeyDown={() => {
          discard.current = true;
          onChange(value);
        }}
      >
        {options.length > 8 ? (
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a label"
            aria-label="Find a label"
            autoFocus
            className="mb-1 h-8 w-full rounded-md border border-line bg-surface px-2 text-[13px] text-primary placeholder:text-faint focus:border-ring focus:outline-none"
          />
        ) : null}
        {options.length ? (
          <ul role="listbox" aria-multiselectable aria-label="Labels" className="max-h-72 overflow-y-auto">
            {matches.map((o) => {
              const on = selected.includes(o.name);
              return (
                <li key={o.name} role="option" aria-selected={on}>
                  <button type="button" onClick={() => toggle(o.name)} className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-sunken focus-visible:bg-sunken focus-visible:outline-none">
                    <span className={clsx("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm border", on ? "border-accent bg-accent text-accent-foreground" : "border-line-strong bg-surface")}>
                      {on ? <CheckIcon className="size-3.5" aria-hidden /> : null}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium text-primary">{o.name}</span>
                      {o.description ? <span className="block text-[12px] leading-snug text-muted">{o.description}</span> : null}
                    </span>
                  </button>
                </li>
              );
            })}
            {!matches.length ? <li className="px-2 py-2 text-[12.5px] text-muted">No label matches that.</li> : null}
          </ul>
        ) : (
          <p className="px-2 py-2 text-[12.5px] text-muted">No labels yet. {isAdmin ? "Add the first one in Settings." : "An admin can add them in Settings, under Labels."}</p>
        )}
        {isAdmin ? (
          <Link href="/settings/labels" className="mt-1 block rounded-md border-t border-line px-2 pt-2 pb-1 text-[12.5px] font-medium text-secondary hover:text-primary">
            Manage labels
          </Link>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
