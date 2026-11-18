"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { SparklesIcon } from "@heroicons/react/24/outline";
import { appConfig } from "@/app.config";
import { openAssistant, useAssistantState } from "./agent-store";

// The panel (chat, markdown, voice) loads the first time someone opens it, so pages don't pay for it.
const AgentPanel = dynamic(() => import("./agent-panel").then((m) => m.AgentPanel), { ssr: false });

/** The assistant's button in the bottom right corner, and its panel once opened. */
export function AgentLauncher({ configured }: { configured: boolean }) {
  const { open } = useAssistantState();
  const [loaded, setLoaded] = useState(false);
  if (open && !loaded) setLoaded(true);
  // A notification that background work finished links here with ?assistant=tasks: open the panel on its task list.
  useEffect(() => {
    if (appConfig.agent.enabled && new URLSearchParams(window.location.search).get("assistant") === "tasks") openAssistant();
  }, []);
  if (!appConfig.agent.enabled) return null;
  return (
    <>
      {loaded ? <AgentPanel configured={configured} /> : null}
      {!open ? (
        <button
          type="button"
          onClick={() => openAssistant()}
          // Steps aside while a dialog is open, so it never covers a form's buttons.
          className="agent-fab fixed right-[max(1.25rem,env(safe-area-inset-right))] bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-30 flex size-13 items-center justify-center rounded-full bg-accent text-accent-foreground shadow-lg transition-colors hover:bg-accent-hover focus-visible:outline-offset-4"
          aria-label={`Open ${appConfig.agent.name}`}
          title={appConfig.agent.name}
        >
          <SparklesIcon className="size-6" aria-hidden />
        </button>
      ) : null}
    </>
  );
}
