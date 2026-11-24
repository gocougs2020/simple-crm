"use client";

import clsx from "clsx";
import { useEffect, useMemo, useRef } from "react";
import { useApp } from "@/components/app-context";
import { Avatar } from "@/components/ui/avatar";
import { mentionOptions } from "@/lib/crm/mentions";
import type { TeamMember } from "@/lib/crm/context";

/** A teammate "@" can offer: what picking them puts in, and the names that mention them. */
export type MentionOption = TeamMember & { insert: string; aliases: string[] };

/** Who an "@" can mention, alphabetically: the active teammates other than the viewer, with what picking each inserts. */
export function useMentionOptions(): MentionOption[] {
  const { team, viewer } = useApp();
  return useMemo(() => mentionOptions(team, viewer.id), [team, viewer.id]);
}

/**
 * The list an "@" opens: teammates by name, the highlighted one kept in view
 * as the arrow keys move through it. Clicking picks without taking focus
 * from the text.
 */
export function MentionMenu({
  people,
  active,
  onPick,
  onHover,
  className,
  style,
}: {
  people: MentionOption[];
  active: number;
  onPick: (m: MentionOption) => void;
  onHover: (i: number) => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <ul ref={list} role="listbox" aria-label="Mention a teammate" style={style} className={clsx("absolute z-30 max-h-64 w-64 animate-pop-in overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-md scroll-thin", className)}>
      {people.map((m, i) => (
        <li
          key={m.id}
          role="option"
          aria-selected={i === active}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(m)}
          onMouseMove={() => onHover(i)}
          className={clsx("flex h-9 shrink-0 cursor-default items-center gap-2 rounded-md px-2 text-[13.5px]", i === active ? "bg-sunken text-primary" : "text-secondary")}
        >
          <Avatar name={m.name} size="xs" />
          <span className="truncate">{m.name}</span>
          {m.title ? <span className="truncate text-[12px] text-muted">{m.title}</span> : null}
        </li>
      ))}
    </ul>
  );
}
