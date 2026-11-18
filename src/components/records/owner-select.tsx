"use client";

import { appConfig } from "@/app.config";
import { useApp } from "@/components/app-context";
import { Select } from "@/components/ui/field";

/** The picker's value for "give this task to the assistant". Never saved as an assignee: the task stays the teammate's, and the assistant works on it for them. */
export const ASSISTANT_ASSIGNEE = "assistant";

/**
 * Pick a teammate. Deactivated teammates still show when they're the current value, so nothing silently changes.
 * `assistant` adds the assistant as a choice, for tasks it can do in the background (docs/AGENT.md).
 */
export function OwnerSelect({
  value,
  onChange,
  id,
  allowNone = true,
  noneLabel = "No owner",
  className,
  assistant = false,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  id?: string;
  allowNone?: boolean;
  noneLabel?: string;
  className?: string;
  assistant?: boolean;
}) {
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
      {assistant ? <option value={ASSISTANT_ASSIGNEE}>{appConfig.agent.name} (does it for you)</option> : null}
    </Select>
  );
}
