"use client";

import clsx from "clsx";
import { useRouter } from "next/navigation";
import { Dialog as D } from "radix-ui";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition, type ComponentType } from "react";
import {
  BuildingOffice2Icon,
  CheckCircleIcon,
  Cog6ToothIcon,
  BriefcaseIcon,
  EnvelopeIcon,
  FolderIcon,
  HomeIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  UserIcon,
} from "@heroicons/react/24/outline";
import { searchEverything } from "@/actions/records";
import { Kbd } from "@/components/ui/field";
import { Spinner } from "@/components/ui/button";
import { openCreate } from "./create-store";

let open = false;
const listeners = new Set<() => void>();
const setOpen = (v: boolean) => {
  open = v;
  listeners.forEach((l) => l());
};
export const openPalette = () => setOpen(true);

type Item = { id: string; group: string; label: string; detail?: string; icon: ComponentType<{ className?: string }>; run: () => void };

/** ⌘K: find any person, organization or client, jump anywhere, or create something. */
export function CommandPalette() {
  const isOpen = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
    () => false,
  );
  const router = useRouter();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Awaited<ReturnType<typeof searchEverything>> | null>(null);
  const [active, setActive] = useState(0);
  const [pending, start] = useTransition();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!open);
      }
      // "/" opens search unless someone is typing.
      if (e.key === "/" && !(e.target as HTMLElement).closest("input,textarea,select,[contenteditable=true]")) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (!term) return;
    const t = setTimeout(() => start(async () => setResults(await searchEverything(term))), 120);
    return () => clearTimeout(t);
  }, [q]);

  const go = (href: string) => () => {
    setOpen(false);
    router.push(href);
  };

  const items = useMemo<Item[]>(() => {
    if (!q.trim()) {
      return [
        { id: "new-client", group: "Create", label: "New client", icon: PlusIcon, run: () => (setOpen(false), openCreate({ kind: "client" })) },
        { id: "new-person", group: "Create", label: "New person", icon: PlusIcon, run: () => (setOpen(false), openCreate({ kind: "person" })) },
        { id: "new-org", group: "Create", label: "New organization", icon: PlusIcon, run: () => (setOpen(false), openCreate({ kind: "organization" })) },
        { id: "go-home", group: "Go to", label: "Home", icon: HomeIcon, run: go("/") },
        { id: "go-clients", group: "Go to", label: "Clients", icon: BriefcaseIcon, run: go("/clients") },
        { id: "go-current", group: "Go to", label: "Current clients", icon: BriefcaseIcon, run: go("/clients?category=current") },
        { id: "go-past", group: "Go to", label: "Past clients", icon: BriefcaseIcon, run: go("/clients?category=past") },
        { id: "go-people", group: "Go to", label: "People", icon: UserIcon, run: go("/people") },
        { id: "go-orgs", group: "Go to", label: "Organizations", icon: BuildingOffice2Icon, run: go("/organizations") },
        { id: "go-activities", group: "Go to", label: "Activities", icon: CheckCircleIcon, run: go("/activities") },
        { id: "go-files", group: "Go to", label: "Files", icon: FolderIcon, run: go("/files") },
        { id: "go-email", group: "Go to", label: "Inbox", icon: EnvelopeIcon, run: go("/email") },
        { id: "go-settings", group: "Go to", label: "Settings", icon: Cog6ToothIcon, run: go("/settings") },
      ];
    }
    if (!results) return [];
    const term = q.trim();
    return [
      ...results.clients.map((r): Item => ({ id: `c${r.id}`, group: "Clients", label: r.label, detail: r.detail, icon: BriefcaseIcon, run: go(`/clients/${r.id}`) })),
      ...results.people.map((r): Item => ({ id: `p${r.id}`, group: "People", label: r.label, detail: r.detail, icon: UserIcon, run: go(`/people/${r.id}`) })),
      ...results.organizations.map((r): Item => ({ id: `o${r.id}`, group: "Organizations", label: r.label, detail: r.detail, icon: BuildingOffice2Icon, run: go(`/organizations/${r.id}`) })),
      { id: "create-person", group: "Create", label: `New person “${term}”`, icon: PlusIcon, run: () => (setOpen(false), openCreate({ kind: "person", defaults: { firstName: term } })) },
      { id: "create-org", group: "Create", label: `New organization “${term}”`, icon: PlusIcon, run: () => (setOpen(false), openCreate({ kind: "organization", defaults: { name: term } })) },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `go` only closes over the router
  }, [q, results]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- keep the highlight on the first result as results change
  useEffect(() => setActive(0), [items]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const groups = [...new Set(items.map((i) => i.group))];

  return (
    <D.Root
      open={isOpen}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          setQ("");
          setResults(null);
        }
      }}
    >
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 animate-fade-in bg-overlay" />
        <D.Content className="fixed top-[10vh] left-1/2 z-50 w-[calc(100%-24px)] max-w-xl -translate-x-1/2 animate-pop-in overflow-hidden rounded-xl border border-line bg-surface shadow-lg outline-none">
          <D.Title className="sr-only">Search</D.Title>
          <D.Description className="sr-only">Find people, organizations and clients, or jump to a page.</D.Description>
          <div className="flex items-center gap-2.5 border-b border-line px-4">
            {pending ? <Spinner className="text-faint" /> : <MagnifyingGlassIcon className="size-4 text-faint" aria-hidden />}
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((a) => Math.min(a + 1, items.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => Math.max(a - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  items[active]?.run();
                }
              }}
              placeholder="Search people, organizations, clients…"
              className="h-12 flex-1 bg-transparent text-[15px] text-primary outline-none placeholder:text-faint"
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-list"
              aria-activedescendant={items[active] ? `palette-${items[active].id}` : undefined}
            />
            <Kbd>esc</Kbd>
          </div>
          <div ref={listRef} id="palette-list" role="listbox" className="max-h-[min(60vh,420px)] overflow-y-auto p-1.5 scroll-thin">
            {q.trim() && results && items.length <= 2 && !pending ? <p className="px-3 py-6 text-center text-[13px] text-muted">No matches for “{q.trim()}”.</p> : null}
            {groups.map((g) => (
              <div key={g} role="group" aria-label={g}>
                <p className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-faint uppercase">{g}</p>
                {items
                  .filter((i) => i.group === g)
                  .map((i) => {
                    const index = items.indexOf(i);
                    return (
                      <div
                        key={i.id}
                        id={`palette-${i.id}`}
                        role="option"
                        aria-selected={index === active}
                        data-index={index}
                        onMouseMove={() => setActive(index)}
                        onClick={i.run}
                        className={clsx("flex h-9 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[14px]", index === active ? "bg-sunken text-primary" : "text-secondary")}
                      >
                        <i.icon className="size-4 shrink-0 text-muted" aria-hidden />
                        <span className="truncate">{i.label}</span>
                        {i.detail ? <span className="truncate text-[12.5px] text-muted">{i.detail}</span> : null}
                      </div>
                    );
                  })}
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11.5px] text-muted">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> to move
            </span>
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd> to open
            </span>
            <span className="ml-auto flex items-center gap-1">
              <Kbd>/</Kbd> opens search anywhere
            </span>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
