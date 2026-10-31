import clsx from "clsx";
import type { ComponentType, ReactNode } from "react";

/** Says what's missing, then the next step. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  variant = "default",
  className,
}: {
  icon?: ComponentType<{ className?: string }>;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  variant?: "default" | "subtle" | "minimal";
  className?: string;
}) {
  return (
    <div
      className={clsx(
        "flex flex-col items-center justify-center rounded-lg px-6 text-center",
        variant === "default" && "bg-sunken/60 py-14",
        variant === "subtle" && "bg-sunken/40 py-8",
        variant === "minimal" && "py-8",
        className,
      )}
    >
      {Icon ? (
        <span className={clsx("mb-3 flex items-center justify-center rounded-full bg-surface ring-1 ring-line", variant === "subtle" ? "size-10" : "size-12")}>
          <Icon className="size-5 text-muted" aria-hidden />
        </span>
      ) : null}
      <p className={clsx("font-medium text-primary", variant === "default" ? "text-[15px]" : "text-[14px]")}>{title}</p>
      {description ? <p className="mt-1 max-w-sm text-[13px] text-muted">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
