"use client";

import clsx from "clsx";
import { useState, useTransition } from "react";
import { PhoneIcon, StarIcon as StarSolid } from "@heroicons/react/20/solid";
import { StarIcon as StarOutline } from "@heroicons/react/24/outline";
import { updatePerson } from "@/actions/records";
import { useApp } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Tooltip } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { appConfig } from "@/app.config";
import { formatPhone } from "@/lib/phone/numbers";
import { preloadRichText } from "@/components/ui/rich-text";
import { placeCall } from "./call-store";

/** The call panel's notes box opens with the call: start loading its editor on the way to the button. */
const preload = () => void preloadRichText().catch(() => {});

type Target = { name: string; phone: string | null | undefined; personId?: string | null; organizationId?: string | null; clientId?: string | null };

/**
 * Calls a record's phone from the browser, through one of the team's
 * numbers. With several numbers it asks which to call from (the last one
 * used first). Hidden when calling isn't set up, the viewer has no number,
 * or there's no phone on file.
 */
export function CallButton({ target, size = "sm", variant = "outline", label = "Call" }: { target: Target; size?: "sm" | "md"; variant?: "outline" | "ghost" | "primary"; label?: string }) {
  const { comms } = useApp();
  if (!comms.calling || !target.phone) return null;
  const call = async (phoneNumberId: string) => {
    const r = await placeCall({ phoneNumberId, name: target.name, to: target.phone, personId: target.personId, organizationId: target.organizationId, clientId: target.clientId });
    if (!r.ok) toast.error(r.error);
  };
  const others = comms.numbers.filter((n) => n.id !== comms.defaultNumberId);
  const preferred = comms.numbers.find((n) => n.id === comms.defaultNumberId) ?? comms.numbers[0];
  if (!others.length || !preferred) {
    return (
      <Tooltip content={`Call ${formatPhone(target.phone)} from ${preferred ? formatPhone(preferred.number) : "the team's number"}`}>
        <Button size={size} variant={variant} onClick={() => preferred && call(preferred.id)} onPointerEnter={preload} onFocus={preload}>
          <PhoneIcon />
          {label}
        </Button>
      </Tooltip>
    );
  }
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size={size} variant={variant} onPointerEnter={preload} onFocus={preload}>
          <PhoneIcon />
          {label}
        </Button>
      </MenuTrigger>
      <MenuContent className="w-60">
        <MenuLabel>Call {formatPhone(target.phone)} from</MenuLabel>
        {[preferred, ...others].map((n) => (
          <MenuItem key={n.id} onSelect={() => call(n.id)}>
            <span className="min-w-0 flex-1 truncate">{n.label}</span>
            <span className="text-[12px] text-muted tabular-nums">{formatPhone(n.number)}</span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

/** Stars a person at their organization as someone who makes or signs off on the decision. */
export function StarToggle({ personId, starred, name, className }: { personId: string; starred: boolean; name: string; className?: string }) {
  const { canEdit } = useApp();
  const [on, setOn] = useState(starred);
  const [pending, start] = useTransition();
  const label = appConfig.records.keyContactLabel;
  const Icon = on ? StarSolid : StarOutline;
  const toggle = () =>
    start(async () => {
      const next = !on;
      setOn(next);
      const r = await updatePerson(personId, { decisionMaker: next });
      if (!r.ok) {
        setOn(!next);
        toast.error(r.error);
      }
    });
  const tip = on ? `${label}${canEdit ? ". Click to unstar." : ""}` : canEdit ? `Star ${name} as a ${label.toLowerCase()}` : `Not a ${label.toLowerCase()}`;
  return (
    <Tooltip content={tip}>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (canEdit) toggle();
        }}
        disabled={pending || !canEdit}
        aria-pressed={on}
        aria-label={on ? `${name} is a ${label.toLowerCase()}` : `Star ${name} as a ${label.toLowerCase()}`}
        className={clsx("rounded-md p-1 transition-colors disabled:cursor-default", on ? "text-warning" : "text-faint hover:text-secondary", !canEdit && !on && "invisible", className)}
      >
        <Icon className="size-4" />
      </button>
    </Tooltip>
  );
}
