"use client";

import clsx from "clsx";
import Link from "next/link";
import type { AnchorHTMLAttributes } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { UIMessage } from "ai";
import { ArrowPathIcon, CheckIcon, ExclamationTriangleIcon, NoSymbolIcon } from "@heroicons/react/24/outline";

/** How a tool shows in the conversation: "Create task", "Search". */
export function toolLabel(name: string) {
  const words = name.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

type ToolPart = {
  type: string;
  toolName?: string;
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: { id: string; approved?: boolean; reason?: string; requestReason?: string; isAutomatic?: boolean };
};

const isTool = (p: { type: string }): p is ToolPart => p.type === "dynamic-tool" || p.type.startsWith("tool-");
const nameOf = (p: ToolPart) => p.toolName ?? p.type.slice("tool-".length);
const outputError = (o: unknown) => (o && typeof o === "object" && "error" in o && typeof (o as { error: unknown }).error === "string" ? (o as { error: string }).error : null);

/**
 * Links in answers are model output. Paths on this site navigate in place;
 * anything else opens in a new tab without access to this one.
 */
function MarkdownLink({ href, children, onNavigate, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { onNavigate?: () => void }) {
  if (href && /^\/(?!\/)/.test(href) && !href.includes("\\"))
    return (
      <Link href={href} onClick={onNavigate} {...props}>
        {children}
      </Link>
    );
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  );
}

export function Markdown({ text, onNavigate }: { text: string; onNavigate?: () => void }) {
  return (
    <div className="prose-crm prose-agent">
      {/* No images: a loaded image URL could carry CRM data to another site if text the agent read told it to write one. */}
      <ReactMarkdown remarkPlugins={[remarkGfm]} disallowedElements={["img"]} unwrapDisallowed components={{ a: (props) => <MarkdownLink {...props} onNavigate={onNavigate} /> }}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** One tool call: running, done, failed, or waiting for the teammate to confirm. */
function ToolActivity({ part, onApprove }: { part: ToolPart; onApprove: (id: string, approved: boolean) => void }) {
  const label = toolLabel(nameOf(part));
  if (part.state === "approval-requested" && part.approval && !part.approval.isAutomatic) {
    return (
      <div className="rounded-lg border border-warning-border bg-warning-surface px-3 py-2.5 text-[13px] text-primary" role="group" aria-label={`Confirm: ${label}`}>
        <p className="font-medium">{label}?</p>
        <p className="mt-0.5 text-[12.5px] text-secondary">{part.approval.requestReason ?? "This changes your CRM."}</p>
        <div className="mt-2 flex gap-2">
          <button type="button" onClick={() => onApprove(part.approval!.id, true)} className="inline-flex h-7 items-center rounded-md bg-accent px-2.5 text-[12.5px] font-medium text-accent-foreground hover:bg-accent-hover">
            {label}
          </button>
          <button type="button" onClick={() => onApprove(part.approval!.id, false)} className="inline-flex h-7 items-center rounded-md border border-line bg-surface px-2.5 text-[12.5px] font-medium text-primary hover:bg-sunken">
            Cancel
          </button>
        </div>
      </div>
    );
  }
  const error = part.state === "output-error" ? (part.errorText ?? "It didn't work.") : part.state === "output-available" ? outputError(part.output) : null;
  const denied = part.state === "output-denied" || (part.state === "approval-responded" && part.approval?.approved === false);
  const running = !error && !denied && part.state !== "output-available";
  return (
    <div className={clsx("flex items-start gap-1.5 text-[12.5px]", error ? "text-error" : "text-muted")}>
      {running ? (
        <ArrowPathIcon className="mt-0.5 size-3.5 shrink-0 animate-spin" aria-hidden />
      ) : error ? (
        <ExclamationTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      ) : denied ? (
        <NoSymbolIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      ) : (
        <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
      )}
      <span className="min-w-0">
        {denied ? `${label}: cancelled` : running ? `${label}…` : label}
        {error ? <span className="block text-secondary">{error}</span> : null}
      </span>
    </div>
  );
}

/** An agent turn: its text, with each tool it used shown where it used it. */
export function AssistantParts({ message, onApprove, onNavigate }: { message: UIMessage; onApprove: (id: string, approved: boolean) => void; onNavigate?: () => void }) {
  const blocks = message.parts.map((p, i) => {
    if (p.type === "text") return p.text.trim() ? <Markdown key={i} text={p.text} onNavigate={onNavigate} /> : null;
    if (isTool(p)) return <ToolActivity key={p.toolCallId ?? i} part={p} onApprove={onApprove} />;
    return null;
  });
  return <div className="flex flex-col gap-2">{blocks}</div>;
}

export const hasVisibleContent = (m: UIMessage) => m.parts.some((p) => (p.type === "text" && p.text.trim()) || isTool(p));
export const textOf = (m: UIMessage) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
export const awaitingApproval = (m: UIMessage | undefined) => !!m && m.role === "assistant" && m.parts.some((p) => isTool(p) && p.state === "approval-requested");
