import clsx from "clsx";
import type { ReactNode } from "react";

export type Tone = "success" | "warning" | "error" | "info" | "neutral";

const tones: Record<Tone, string> = {
  success: "bg-success-surface text-success border-success-border",
  warning: "bg-warning-surface text-warning border-warning-border",
  error: "bg-error-surface text-error border-error-border",
  info: "bg-info-surface text-info border-info-border",
  neutral: "bg-neutral-surface text-neutral border-neutral-border",
};

/** Flat status badge. Always carries a word: color is never the only signal. */
export function StatusBadge({ tone = "neutral", icon, children, className }: { tone?: Tone; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span
      className={clsx(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-md border px-1.5 text-[11.5px] leading-none font-semibold whitespace-nowrap tabular-nums [&_svg]:size-3.5",
        tones[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

/** Rounded pill for tags and labels. */
export function Tag({ children, onRemove, className }: { children: ReactNode; onRemove?: () => void; className?: string }) {
  return (
    <span className={clsx("inline-flex h-5 items-center gap-1 rounded-full border border-line bg-surface px-2 text-[12px] font-medium text-secondary", className)}>
      {children}
      {onRemove ? (
        <button type="button" onClick={onRemove} className="-mr-1 rounded-full px-0.5 text-faint hover:text-primary" aria-label="Remove">
          ×
        </button>
      ) : null}
    </span>
  );
}
