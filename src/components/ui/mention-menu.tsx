"use client";

import clsx from "clsx";
import { useEffect, useMemo, useRef } from "react";
import { SparklesIcon } from "@heroicons/react/20/solid";
import { appConfig } from "@/app.config";
import { useApp } from "@/components/app-context";
import { Avatar } from "@/components/ui/avatar";
import { AGENT_MENTION_ID, agentMentionNames, mentionOptions } from "@/lib/crm/mentions";
import type { TeamMember } from "@/lib/crm/context";

/** Someone "@" can offer: what picking them puts in, and the names that mention them. `agent` marks the agent itself. */
export type MentionOption = TeamMember & { insert: string; aliases: string[]; agent?: boolean };

/** The agent, as the @ list offers it: its handle ("Agent"), with its full name beside it when that's different. */
function agentOption(): MentionOption {
  const names = agentMentionNames();
  const full = appConfig.agent.name.trim();
  return {
    id: AGENT_MENTION_ID,
    name: names[0],
    email: "",
    role: "agent",
    title: full && full.toLowerCase() !== names[0].toLowerCase() ? full : "Hand it something to do",
    active: true,
    insert: `@${names[0]}`,
    aliases: names,
    agent: true,
  };
}

/**
 * Who an "@" can mention: the agent first, where it can take work from this teammate (background work is
 * on and they can edit), then the active teammates other than the viewer, alphabetically.
 */
export function useMentionOptions(): MentionOption[] {
  const { team, viewer, services, canEdit } = useApp();
  const withAgent = services.ai.background && canEdit;
  return useMemo(() => [...(withAgent ? [agentOption()] : []), ...mentionOptions(team, viewer.id)], [team, viewer.id, withAgent]);
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
    <ul ref={list} role="listbox" aria-label="Mention a teammate or the agent" style={style} className={clsx("absolute z-30 max-h-64 w-64 animate-pop-in overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-md scroll-thin", className)}>
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
          {m.agent ? (
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent" aria-hidden>
              <SparklesIcon className="size-3" />
            </span>
          ) : (
            <Avatar name={m.name} size="xs" />
          )}
          <span className="truncate">{m.name}</span>
          {m.title ? <span className="truncate text-[12px] text-muted">{m.title}</span> : null}
        </li>
      ))}
    </ul>
  );
}
