"use client";

import clsx from "clsx";
import { DropdownMenu as M, Popover as P, Slot, Tooltip as T } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";

export const Menu = M.Root;
export const MenuTrigger = M.Trigger;

export function MenuContent({ className, align = "end", ...props }: ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content
        align={align}
        sideOffset={4}
        className={clsx("z-50 min-w-44 animate-pop-in rounded-lg border border-line bg-surface p-1 shadow-md", className)}
        {...props}
      />
    </M.Portal>
  );
}

export function MenuItem({ className, destructive, icon, children, asChild, ...props }: ComponentProps<typeof M.Item> & { destructive?: boolean; icon?: ReactNode }) {
  return (
    <M.Item
      className={clsx(
        "flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-[13px] outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-sunken [&_svg]:size-4",
        destructive ? "text-error" : "text-secondary data-[highlighted]:text-primary",
        className,
      )}
      asChild={asChild}
      {...props}
    >
      {icon}
      {/* With asChild the item renders as its child (a link, say), so the icon has to go inside it: Slottable marks which element that is. */}
      {asChild ? <Slot.Slottable>{children}</Slot.Slottable> : children}
    </M.Item>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <M.Label className="px-2 pt-1.5 pb-1 text-[11px] font-semibold tracking-wide text-faint uppercase">{children}</M.Label>;
}

export const MenuSeparator = () => <M.Separator className="-mx-1 my-1 h-px bg-line" />;

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;
export const PopoverClose = P.Close;

export function PopoverContent({ className, align = "start", ...props }: ComponentProps<typeof P.Content>) {
  return (
    <P.Portal>
      <P.Content
        align={align}
        sideOffset={4}
        collisionPadding={12}
        className={clsx("z-50 animate-pop-in rounded-lg border border-line bg-surface shadow-md outline-none", className)}
        {...props}
      />
    </P.Portal>
  );
}

/** Short hint on hover/focus. Never put essential information only in a tooltip. */
export function Tooltip({ content, children, side = "top" }: { content: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  if (!content) return <>{children}</>;
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content side={side} sideOffset={6} className="z-[60] max-w-xs animate-fade-in rounded-md bg-primary px-2 py-1 text-[12px] text-white shadow-md">
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}

export const TooltipProvider = T.Provider;
