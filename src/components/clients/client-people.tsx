"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { EllipsisHorizontalIcon, PlusIcon, StarIcon } from "@heroicons/react/20/solid";
import { addClientPerson, removeClientPerson, updateClient } from "@/actions/clients";
import { useApp } from "@/components/app-context";
import { SideCard } from "@/components/records/inline-field";
import { RecordPicker } from "@/components/records/record-picker";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger, Tooltip } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { appConfig } from "@/app.config";

export type ClientPersonRow = {
  id: string;
  name: string;
  title: string | null;
  email: string | null;
  decisionMaker: boolean;
  /** Its contact, added to the client by hand, or at its organization. */
  source: "contact" | "added" | "organization";
};

/** How many show before "Show all": the card is a preview, the composer's dropdowns hold everyone. */
const PREVIEW = 5;

/**
 * Everyone associated with a client: its contact, people added to it here,
 * and everyone at its organization. Any of them can be called, emailed,
 * texted or put on a meeting from the composer beside it.
 */
export function ClientPeopleCard({ clientId, people, organizationName }: { clientId: string; people: ClientPersonRow[]; organizationName: string | null }) {
  const { canEdit } = useApp();
  const [adding, setAdding] = useState(false);
  const [all, setAll] = useState(false);
  const [pending, start] = useTransition();
  const shown = all ? people : people.slice(0, PREVIEW);
  const act = (work: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string) =>
    start(async () => {
      const r = await work();
      if (!r.ok) return void toast.error(r.error);
      toast.success(done);
    });

  return (
    <SideCard
      title={
        <>
          People <span className="font-medium text-muted tabular-nums">{people.length || ""}</span>
        </>
      }
      action={
        canEdit && !adding ? (
          <Button size="sm" variant="ghost" className="-mr-2" onClick={() => setAdding(true)}>
            <PlusIcon />
            Person
          </Button>
        ) : null
      }
    >
      {adding ? (
        <div className="mb-2 flex flex-col gap-1.5">
          <RecordPicker
            kind="person"
            value={null}
            allowCreate={false}
            autoFocus
            placeholder="Find a person to add"
            onChange={(v) => {
              if (!v || !("record" in v)) return;
              const { id, label } = v.record;
              setAdding(false);
              if (people.some((p) => p.id === id)) return void toast.success(`${label} is already on this client`);
              act(() => addClientPerson(clientId, id), `${label} added to this client`);
            }}
          />
          <button type="button" className="self-start text-[12px] text-muted hover:text-primary" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </div>
      ) : null}
      {people.length ? (
        <ul className="-mx-2">
          {shown.map((p) => (
            <li key={p.id} className="group flex items-center rounded-md hover:bg-sunken">
              <Link href={`/people/${p.id}`} className="flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pl-2">
                <Avatar name={p.name} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1">
                    <span className="truncate text-[13px] font-medium text-primary">{p.name}</span>
                    {p.decisionMaker ? (
                      <Tooltip content={appConfig.records.keyContactLabel}>
                        <StarIcon className="size-3.5 shrink-0 text-warning" aria-label={appConfig.records.keyContactLabel} />
                      </Tooltip>
                    ) : null}
                  </span>
                  <span className="block truncate text-[11.5px] text-muted">
                    {[p.source === "contact" ? "Contact" : p.source === "added" ? "Added to this client" : null, p.title ?? p.email].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </Link>
              {canEdit && p.source !== "contact" ? (
                <Menu>
                  <MenuTrigger asChild>
                    <button
                      type="button"
                      disabled={pending}
                      aria-label={`Options for ${p.name}`}
                      className="mr-1 rounded-md p-1 text-faint opacity-0 group-hover:opacity-100 hover:text-primary focus-visible:opacity-100 data-[state=open]:opacity-100"
                    >
                      <EllipsisHorizontalIcon className="size-4" />
                    </button>
                  </MenuTrigger>
                  <MenuContent className="w-52">
                    <MenuItem onSelect={() => act(() => updateClient(clientId, { personId: p.id }), `${p.name} is now the contact`)}>Make contact</MenuItem>
                    {p.source === "added" ? (
                      <MenuItem destructive onSelect={() => act(() => removeClientPerson(clientId, p.id), `${p.name} taken off this client`)}>
                        Take off this client
                      </MenuItem>
                    ) : null}
                  </MenuContent>
                </Menu>
              ) : null}
            </li>
          ))}
        </ul>
      ) : adding ? null : (
        <p className="py-1 text-[12.5px] text-muted">
          No people yet. Add the people you work with here{organizationName ? `, or add them to ${organizationName}` : ""}, and you can call, email or text any of them from this page.
        </p>
      )}
      {people.length > PREVIEW ? (
        <button type="button" className="mt-1 text-[12.5px] font-medium text-secondary hover:text-primary" onClick={() => setAll(!all)} aria-expanded={all}>
          {all ? "Show fewer" : `Show all ${people.length}`}
        </button>
      ) : null}
    </SideCard>
  );
}
