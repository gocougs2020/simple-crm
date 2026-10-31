"use client";

import { useApp } from "@/components/app-context";
import { Select } from "@/components/ui/field";

/** Pick a teammate. Deactivated teammates still show when they're the current value, so nothing silently changes. */
export function OwnerSelect({ value, onChange, id, allowNone = true, noneLabel = "No owner", className }: { value: string | null; onChange: (v: string | null) => void; id?: string; allowNone?: boolean; noneLabel?: string; className?: string }) {
  const { team, viewer } = useApp();
  const options = team.filter((m) => m.active || m.id === value);
  return (
    <Select id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} className={className}>
      {allowNone ? <option value="">{noneLabel}</option> : null}
      {options.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
          {m.id === viewer.id ? " (you)" : ""}
          {!m.active ? " (inactive)" : ""}
        </option>
      ))}
    </Select>
  );
}
