"use client";

import clsx from "clsx";
import { useEffect, useState, type ReactNode } from "react";
import { MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { useApp } from "@/components/app-context";
import { Spinner } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { useListParams } from "./use-params";

/** Search box bound to ?q=, debounced so the list updates as you type without a request per keystroke. */
export function SearchBox({ placeholder }: { placeholder: string }) {
  const { get, set, pending } = useListParams();
  const [q, setQ] = useState(get("q") ?? "");
  useEffect(() => {
    const t = setTimeout(() => {
      if ((get("q") ?? "") !== q.trim()) set({ q: q.trim() || null });
    }, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the text changes
  }, [q]);
  return (
    <div className="relative w-full sm:w-64">
      {pending ? (
        <Spinner className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint" />
      ) : (
        <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint" aria-hidden />
      )}
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setQ("")}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-8 w-full rounded-md border border-line bg-surface pr-8 pl-8 text-[13px] text-primary shadow-sm placeholder:text-faint hover:border-line-strong focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {q ? (
        <button type="button" onClick={() => setQ("")} className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-faint hover:text-primary" aria-label="Clear search">
          <XMarkIcon className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

/** Owner filter bound to ?owner= ("me", a teammate's id, "none", or everyone). */
export function OwnerFilter({ label = "Owner" }: { label?: string }) {
  const { team, viewer } = useApp();
  const { get, set } = useListParams();
  return (
    <Select value={get("owner") ?? ""} onChange={(e) => set({ owner: e.target.value || null })} aria-label={label} className="w-40 [&_select]:h-8 [&_select]:text-[13px]">
      <option value="">Everyone</option>
      <option value="me">Mine</option>
      <optgroup label="Teammates">
        {team
          .filter((m) => m.id !== viewer.id && m.active)
          .map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
      </optgroup>
      <option value="none">No owner</option>
    </Select>
  );
}

/** A row of pill tabs bound to a URL param. */
export function FilterTabs({ param, options, fallback }: { param: string; options: { value: string; label: ReactNode }[]; fallback: string }) {
  const { get, set } = useListParams();
  const value = get(param) ?? fallback;
  return (
    <div className="inline-flex rounded-md border border-line bg-sunken p-0.5" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => set({ [param]: o.value === fallback ? null : o.value })}
          className={clsx("h-7 rounded-[5px] px-2.5 text-[12.5px] font-medium transition-colors", value === o.value ? "bg-surface text-primary shadow-sm" : "text-muted hover:text-secondary")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 px-4 py-3 lg:px-6">{children}</div>;
}
