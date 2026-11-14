"use client";

import { useEffect, useState } from "react";
import { CheckIcon, ClipboardDocumentIcon } from "@heroicons/react/20/solid";

/** A code block with a copy button. `$CRM_URL` is shown as this site's address once the page knows it. */
export function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const origin = useOrigin();
  const shown = origin ? code.replaceAll("$CRM_URL", origin) : code;
  return (
    <div className="group relative my-3 min-w-0 overflow-hidden rounded-lg border border-line bg-sunken">
      {label ? <div className="border-b border-line px-3 py-1.5 text-[12px] font-medium text-muted">{label}</div> : null}
      <button
        type="button"
        aria-label={copied ? "Copied" : label ? `Copy ${label}` : "Copy"}
        className="absolute top-1.5 right-1.5 rounded-md p-1.5 text-faint opacity-70 hover:bg-surface hover:text-primary group-hover:opacity-100 focus-visible:opacity-100"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(shown);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            // Clipboard blocked: the text is still selectable.
          }
        }}
      >
        {copied ? <CheckIcon className="size-4" /> : <ClipboardDocumentIcon className="size-4" />}
        <span className="sr-only" aria-live="polite">
          {copied ? "Copied" : ""}
        </span>
      </button>
      <pre className="overflow-x-auto px-3 py-2.5 pr-10 font-mono text-[12.5px] leading-relaxed text-primary scroll-thin">
        <code>{shown}</code>
      </pre>
    </div>
  );
}

/** This site's address, e.g. for the MCP server URL. Blank until the page is in the browser. */
export function SiteUrl({ path = "" }: { path?: string }) {
  const origin = useOrigin();
  return <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[12.5px] text-primary">{(origin ?? "https://your-crm.example.com") + path}</code>;
}

function useOrigin() {
  const [origin, setOrigin] = useState<string | null>(null);
  // Set after hydration so the static page and the browser agree on first render.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setOrigin(window.location.origin), []);
  return origin;
}
