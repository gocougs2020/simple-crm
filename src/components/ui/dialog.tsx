"use client";

import clsx from "clsx";
import { Dialog as D } from "radix-ui";
import { XMarkIcon } from "@heroicons/react/24/outline";
import type { ReactNode } from "react";

/**
 * Modal dialog. On phones it becomes a bottom sheet. The title is required
 * (screen readers announce it); `description` is optional.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
  trigger,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  trigger?: ReactNode;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <D.Trigger asChild>{trigger}</D.Trigger> : null}
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 animate-fade-in bg-overlay" />
        <D.Content
          className={clsx(
            "fixed z-50 flex max-h-[92dvh] w-full flex-col bg-surface shadow-lg outline-none",
            "inset-x-0 bottom-0 animate-slide-up rounded-t-xl sm:inset-auto sm:top-[12vh] sm:left-1/2 sm:max-h-[80vh] sm:-translate-x-1/2 sm:animate-pop-in sm:rounded-xl",
            { sm: "sm:max-w-md", md: "sm:max-w-lg", lg: "sm:max-w-2xl", xl: "sm:max-w-4xl" }[size],
          )}
          onOpenAutoFocus={(e) => {
            // Focus the first field rather than the close button.
            const first = (e.currentTarget as HTMLElement).querySelector<HTMLElement>("input:not([type=hidden]),textarea,select,[contenteditable=true]");
            if (first) {
              e.preventDefault();
              first.focus();
            }
          }}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <D.Title className="text-section">{title}</D.Title>
              {description ? <D.Description className="mt-0.5 text-[13px] text-muted">{description}</D.Description> : <D.Description className="sr-only">{title}</D.Description>}
            </div>
            <D.Close className="-m-1 rounded-md p-1 text-faint hover:bg-sunken hover:text-primary" aria-label="Close">
              <XMarkIcon className="size-5" />
            </D.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 scroll-thin">{children}</div>
          {footer ? <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</div> : null}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export const DialogClose = D.Close;
