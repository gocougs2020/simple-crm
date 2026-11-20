"use client";

import { useState } from "react";
import { CheckIcon, ClipboardDocumentIcon } from "@heroicons/react/20/solid";

/** Copies the whole reference (/developers.md) as Markdown, to paste into a doc, a ticket or an AI tool. */
export function CopyMarkdown() {
  const [state, setState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const label = { idle: "Copy as Markdown", copying: "Copying…", copied: "Copied", failed: "Couldn't copy. Open the Markdown instead" }[state];
  return (
    <button
      type="button"
      disabled={state === "copying"}
      className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1 text-[13px] font-medium text-primary hover:bg-sunken disabled:opacity-60"
      onClick={async () => {
        setState("copying");
        try {
          // Safari only allows writing a pending promise, so the fetch happens inside the clipboard item.
          const text = fetch("/developers.md").then(async (r) => {
            if (!r.ok) throw new Error(String(r.status));
            return new Blob([await r.text()], { type: "text/plain" });
          });
          if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) await navigator.clipboard.write([new ClipboardItem({ "text/plain": text })]);
          else await navigator.clipboard.writeText(await (await text).text());
          setState("copied");
          setTimeout(() => setState("idle"), 2000);
        } catch {
          setState("failed");
        }
      }}
    >
      {state === "copied" ? <CheckIcon className="size-4" /> : <ClipboardDocumentIcon className="size-4" />}
      <span aria-live="polite">{label}</span>
    </button>
  );
}
