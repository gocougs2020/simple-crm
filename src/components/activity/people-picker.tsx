"use client";

import clsx from "clsx";
import { useId, useState } from "react";
import { CheckIcon, ChevronUpDownIcon, MagnifyingGlassIcon, PlusIcon, StarIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { appConfig } from "@/app.config";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/menu";
import { matchesPerson } from "@/lib/crm/people-order";

/**
 * Someone an activity can be with: on a client's page, its contact, the people added to it and everyone at its organization.
 * Lists of them come in the order `orderPeople` gives (src/lib/crm/people-order.ts): the contact, then decision makers, then everyone else.
 */
export type Contact = {
  personId: string;
  name: string;
  email: string | null;
  phone?: string | null;
  textOptedOut?: boolean;
  /** Their job title, or how they relate to the record. */
  detail?: string | null;
  /** Starred as a decision maker. */
  starred?: boolean;
};

/** Picks the one person a call, text or logged email is with. Starts on the record's contact. */
export function WhoSelect({ id, label, contacts, value, onChange, needs }: { id: string; label: string; contacts: Contact[]; value: string | null; onChange: (personId: string) => void; needs?: "phone" | "email" }) {
  const [open, setOpen] = useState(false);
  if (contacts.length < 2) return null;
  const current = contacts.find((c) => c.personId === value);
  const missing = (c: Contact) => (needs && !c[needs] ? `No ${needs === "phone" ? "phone number" : "email address"}` : null);
  const currentMissing = current ? missing(current) : null;
  return (
    <div className="mb-3 flex items-center gap-2 text-[13px]">
      <label htmlFor={id} className="shrink-0 text-muted">
        {label}
      </label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            id={id}
            type="button"
            className="relative flex h-8 max-w-full min-w-0 items-center rounded-md border border-line bg-surface pr-8 pl-3 text-left text-[13px] text-primary shadow-sm transition-colors hover:border-line-strong focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none"
          >
            <span className="truncate">
              {current ? current.name : "Pick a person"}
              {current?.detail ? <span className="text-muted"> · {current.detail}</span> : null}
              {currentMissing ? <span className="text-muted"> ({currentMissing.toLowerCase()})</span> : null}
            </span>
            <ChevronUpDownIcon className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-faint" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-1">
          <PersonSearch
            contacts={contacts}
            selected={value ? [value] : []}
            hint={missing}
            label={label === "To" ? "Who it's to" : "Who it's with"}
            onPick={(personId) => {
              onChange(personId);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * Several people as chips, with a searchable list to add more from
 * `contacts`: a meeting's attendees, an email's To and Cc lines.
 * `unavailable` says why someone can't be picked ("No email address");
 * `full` stops adding.
 */
export function PeopleChips({
  contacts,
  value,
  onChange,
  addLabel,
  menuLabel,
  exclude = [],
  unavailable,
  full,
  min = 0,
}: {
  contacts: Contact[];
  value: string[];
  onChange: (personIds: string[]) => void;
  addLabel: string;
  menuLabel: string;
  /** People already picked somewhere else (on the other line of the email). */
  exclude?: string[];
  unavailable?: (c: Contact) => string | null;
  full?: boolean;
  /** How many must stay picked. */
  min?: number;
}) {
  const [open, setOpen] = useState(false);
  const picked = value.flatMap((id) => contacts.find((c) => c.personId === id) ?? []);
  const rest = contacts.filter((c) => !value.includes(c.personId) && !exclude.includes(c.personId));
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
      {picked.map((c) => (
        <span key={c.personId} title={c.email ?? undefined} className="inline-flex h-7 max-w-56 items-center gap-0.5 rounded-full border border-line bg-sunken pr-1 pl-2.5 text-[12.5px] text-primary">
          <span className="truncate">{c.name}</span>
          {picked.length > min ? (
            <button type="button" onClick={() => onChange(value.filter((id) => id !== c.personId))} className="rounded-full p-0.5 text-faint hover:text-primary" aria-label={`Remove ${c.name}`}>
              <XMarkIcon className="size-3.5" />
            </button>
          ) : (
            <span className="w-1.5" />
          )}
        </span>
      ))}
      {rest.length && !full ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button type="button" className="inline-flex h-7 items-center gap-0.5 rounded-full border border-dashed border-line-strong pr-2.5 pl-1.5 text-[12.5px] font-medium text-secondary hover:border-accent hover:text-primary">
              <PlusIcon className="size-3.5" aria-hidden />
              {addLabel}
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-1">
            <PersonSearch
              contacts={rest}
              label={menuLabel}
              disabled={unavailable}
              onPick={(personId) => {
                onChange([...value, personId]);
                setOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}

/**
 * A search box over a list of people, for records with dozens or hundreds of
 * them. Typing narrows the list by name, title or email; arrow keys and Enter
 * pick without the mouse. The list keeps the order it's given.
 */
function PersonSearch({
  contacts,
  label,
  onPick,
  selected = [],
  disabled,
  hint,
}: {
  contacts: Contact[];
  label: string;
  onPick: (personId: string) => void;
  selected?: string[];
  /** Why someone can't be picked; they're shown greyed out. */
  disabled?: (c: Contact) => string | null;
  /** A note under someone who can still be picked. */
  hint?: (c: Contact) => string | null;
}) {
  const [q, setQ] = useState("");
  const shown = contacts.filter((c) => matchesPerson(q, c));
  const firstPickable = (list: Contact[]) => Math.max(0, list.findIndex((c) => !disabled?.(c)));
  const [active, setActive] = useState(() => firstPickable(shown));
  const listId = useId();
  const at = Math.min(active, shown.length - 1);
  const move = (step: 1 | -1) => {
    for (let i = at + step; i >= 0 && i < shown.length; i += step) if (!disabled?.(shown[i])) return setActive(i);
  };
  const pick = (c: Contact | undefined) => {
    if (c && !disabled?.(c)) onPick(c.personId);
  };
  return (
    <div className="flex flex-col">
      <div className="relative p-1 pb-1.5">
        <MagnifyingGlassIcon className="pointer-events-none absolute top-[calc(50%-1px)] left-3.5 size-4 -translate-y-1/2 text-faint" aria-hidden />
        <input
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(firstPickable(contacts.filter((c) => matchesPerson(e.target.value, c))));
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              move(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              move(-1);
            } else if (e.key === "Enter") {
              e.preventDefault();
              pick(shown[at]);
            }
          }}
          placeholder={`Search ${contacts.length} ${contacts.length === 1 ? "person" : "people"}`}
          aria-label={`Search: ${label}`}
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={shown[at] ? `${listId}-${shown[at].personId}` : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          className="h-8 w-full rounded-md border border-line bg-surface pr-2 pl-8 text-[13px] text-primary placeholder:text-faint focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none"
        />
      </div>
      <p className="px-2 pt-0.5 pb-1 text-[11px] font-semibold tracking-wide text-faint uppercase">{label}</p>
      <ul id={listId} role="listbox" aria-label={label} className="max-h-64 overflow-auto">
        {shown.map((c, i) => {
          const why = disabled?.(c) ?? null;
          const note = why ?? hint?.(c) ?? null;
          const isSelected = selected.includes(c.personId);
          return (
            <li
              key={c.personId}
              id={`${listId}-${c.personId}`}
              role="option"
              aria-selected={isSelected}
              aria-disabled={why ? true : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => !why && setActive(i)}
              onClick={() => pick(c)}
              className={clsx("flex cursor-default items-center gap-2 rounded-md px-2 py-1 text-[13px]", why ? "opacity-50" : i === at ? "bg-sunken text-primary" : "text-secondary")}
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1">
                  <span className="truncate">{c.name}</span>
                  {c.starred ? <StarIcon className="size-3.5 shrink-0 text-warning" aria-label={appConfig.records.keyContactLabel} /> : null}
                </span>
                <span className="block truncate text-[11.5px] text-muted">{[note, c.detail ?? c.email].filter(Boolean).join(" · ")}</span>
              </span>
              {isSelected ? <CheckIcon className="size-4 shrink-0 text-accent" aria-hidden /> : null}
            </li>
          );
        })}
        {!shown.length ? <li className="px-2 py-1.5 text-[13px] text-muted">Nobody matches “{q.trim()}”. Check the spelling, or search by email or title.</li> : null}
      </ul>
    </div>
  );
}
