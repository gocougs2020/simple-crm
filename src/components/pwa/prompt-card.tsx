"use client";

import clsx from "clsx";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { useId, type ReactNode } from "react";

/**
 * A card pinned to the bottom of a phone's screen that doesn't block the page
 * (install the app, turn on notifications). It sits above the tab bar when
 * there is one.
 */
export function PromptCard({ title, icon, children, onDismiss, className }: { title: string; icon?: ReactNode; children: ReactNode; onDismiss: () => void; className?: string }) {
  const id = useId();
  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-labelledby={id}
      className={clsx(
        "pointer-events-none fixed inset-x-0 bottom-0 z-[45] animate-slide-up px-3 pr-[max(0.75rem,env(safe-area-inset-right))] pb-[max(0.75rem,env(safe-area-inset-bottom),calc(var(--shell-bottom)+0.5rem))] pl-[max(0.75rem,env(safe-area-inset-left))]",
        className,
      )}
    >
      {/* Only the card takes taps: the padding around it sits over the tab bar. */}
      <div className="pointer-events-auto mx-auto max-w-md rounded-xl border border-line bg-surface p-4 shadow-lg">
        <div className="flex items-start gap-3">
          {icon ? <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground [&_svg]:size-5">{icon}</span> : null}
          <h2 id={id} className="min-w-0 flex-1 pt-1.5 text-section">
            {title}
          </h2>
          <button type="button" onClick={onDismiss} className="-m-1.5 rounded-md p-2 text-faint hover:bg-sunken hover:text-primary" aria-label="Close">
            <XMarkIcon className="size-5" />
          </button>
        </div>
        <div className="mt-2.5 text-[14px] text-secondary">{children}</div>
      </div>
    </section>
  );
}

/** Remembers that a prompt was closed, for `days`, in this browser only. Storage can be unavailable (private mode): then it asks again next visit. */
export function dismissedRecently(key: string, days: number) {
  try {
    const at = Number(window.localStorage.getItem(key));
    return !!at && Date.now() - at < days * 86_400_000;
  } catch {
    return false;
  }
}

export function rememberDismissed(key: string) {
  try {
    window.localStorage.setItem(key, String(Date.now()));
  } catch {
    // Nothing to remember it in; it shows again next time.
  }
}
