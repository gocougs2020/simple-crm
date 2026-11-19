"use client";

import { PlusIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { Select } from "@/components/ui/field";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";

/** Someone an activity can be with: on a client's page, its contact, the people added to it and everyone at its organization. */
export type Contact = { personId: string; name: string; email: string | null; phone?: string | null; textOptedOut?: boolean; /** Their job title, or how they relate to the record. */ detail?: string | null };

/** Picks the one person a call, text or logged email is with. Starts on the record's contact. */
export function WhoSelect({ id, label, contacts, value, onChange, needs }: { id: string; label: string; contacts: Contact[]; value: string | null; onChange: (personId: string) => void; needs?: "phone" | "email" }) {
  if (contacts.length < 2) return null;
  return (
    <div className="mb-3 flex items-center gap-2 text-[13px]">
      <label htmlFor={id} className="shrink-0 text-muted">
        {label}
      </label>
      <Select id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value)} className="max-w-full min-w-0 [&_select]:h-8 [&_select]:text-[13px]">
        {contacts.map((c) => (
          <option key={c.personId} value={c.personId}>
            {c.name}
            {c.detail ? ` · ${c.detail}` : ""}
            {needs && !c[needs] ? ` (no ${needs === "phone" ? "phone number" : "email address"})` : ""}
          </option>
        ))}
      </Select>
    </div>
  );
}

/**
 * Several people as chips, with a menu to add more from `contacts`: a
 * meeting's attendees, an email's To and Cc lines. `unavailable` says why
 * someone can't be picked ("No email address"); `full` stops adding.
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
  const picked = value.flatMap((id) => contacts.find((c) => c.personId === id) ?? []);
  const rest = contacts.filter((c) => !value.includes(c.personId) && !exclude.includes(c.personId));
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
      {picked.map((c) => (
        <span key={c.personId} className="inline-flex h-7 max-w-56 items-center gap-0.5 rounded-full border border-line bg-sunken pr-1 pl-2.5 text-[12.5px] text-primary">
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
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className="inline-flex h-7 items-center gap-0.5 rounded-full border border-dashed border-line-strong pr-2.5 pl-1.5 text-[12.5px] font-medium text-secondary hover:border-accent hover:text-primary">
              <PlusIcon className="size-3.5" aria-hidden />
              {addLabel}
            </button>
          </MenuTrigger>
          <MenuContent align="start" className="max-h-72 w-72 overflow-auto">
            <MenuLabel>{menuLabel}</MenuLabel>
            {rest.map((c) => {
              const why = unavailable?.(c) ?? null;
              return (
                <MenuItem key={c.personId} className="h-auto py-1" disabled={!!why} onSelect={() => onChange([...value, c.personId])}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{c.name}</span>
                    <span className="block truncate text-[11.5px] text-muted">{why ?? c.detail ?? c.email ?? ""}</span>
                  </span>
                </MenuItem>
              );
            })}
          </MenuContent>
        </Menu>
      ) : null}
    </div>
  );
}
