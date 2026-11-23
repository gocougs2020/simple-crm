"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { SparklesIcon } from "@heroicons/react/24/outline";
import { appConfig } from "@/app.config";
import { openAssistant, useAssistantState } from "./agent-store";
import { onAgentTasksChanged } from "./task-events";

// The panel (chat, markdown, voice) loads the first time someone opens it, so pages don't pay for it.
const AgentPanel = dynamic(() => import("./agent-panel").then((m) => m.AgentPanel), { ssr: false });

/** The agent's button in the bottom right corner (in the top bar on a phone: app-shell.tsx), and its panel once opened. */
export function AgentLauncher({ configured }: { configured: boolean }) {
  const { open, voice } = useAssistantState();
  const [loaded, setLoaded] = useState(false);
  if (open && !loaded) setLoaded(true);
  // A notification that background work finished links here with ?agent=tasks: open the panel on its task list.
  useEffect(() => {
    if (appConfig.agent.enabled && new URLSearchParams(window.location.search).get("agent") === "tasks") openAssistant();
  }, []);
  // Work started from a record's page (Enrich): the panel loads, closed, so its task list follows the work.
  useEffect(() => onAgentTasksChanged(() => setLoaded(true)), []);
  if (!appConfig.agent.enabled) return null;
  return (
    <>
      {loaded ? <AgentPanel configured={configured} /> : null}
      {!open ? (
        <button
          type="button"
          onClick={() => openAssistant()}
          // Steps aside while a dialog is open, so it never covers a form's buttons.
          className="agent-fab fixed right-[max(1.25rem,env(safe-area-inset-right))] bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-30 hidden size-13 items-center justify-center rounded-full bg-accent text-accent-foreground shadow-lg transition-colors hover:bg-accent-hover focus-visible:outline-offset-4 lg:flex"
          aria-label={voice ? `Open ${appConfig.agent.name}, voice chat is on` : `Open ${appConfig.agent.name}`}
          title={voice ? "Voice chat is on" : appConfig.agent.name}
        >
          <SparklesIcon className="size-6" aria-hidden />
          {voice ? <VoiceOnDot /> : null}
        </button>
      ) : null}
    </>
  );
}

/** On the agent's buttons while a minimized voice chat is still going. */
export function VoiceOnDot() {
  return (
    <span className="pointer-events-none absolute -top-0.5 -right-0.5 flex size-3.5" aria-hidden>
      <span className="absolute inset-0 rounded-full motion-safe:animate-ping bg-success opacity-60" />
      <span className="relative size-3.5 rounded-full border-2 border-surface bg-success" />
    </span>
  );
}
