import { cn } from "@/lib/cn";
import { Slot } from "radix-ui";
import { forwardRef, type ButtonHTMLAttributes } from "react";

const variants = {
  /** One per view region: save, create, send. */
  primary: "bg-accent text-accent-foreground hover:bg-accent-hover shadow-sm",
  /** Cancel and everything else. */
  outline: "border border-line bg-surface text-primary shadow-sm hover:bg-sunken",
  ghost: "text-secondary hover:bg-sunken hover:text-primary",
  destructive: "bg-error text-white hover:bg-[color-mix(in_srgb,var(--error)_88%,black)] shadow-sm",
  link: "text-primary underline-offset-4 hover:underline px-0 h-auto",
};

const sizes = {
  sm: "h-8 px-2.5 text-[13px] gap-1.5 [&_svg]:size-4",
  md: "h-9 px-3.5 text-[14px] gap-2 [&_svg]:size-4",
  lg: "h-10 px-5 text-[14px] gap-2 [&_svg]:size-4",
  icon: "size-9 [&_svg]:size-[18px]",
  "icon-sm": "size-8 [&_svg]:size-4",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
  asChild?: boolean;
  loading?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "outline", size = "md", asChild, loading, className, children, disabled, type = "button", ...props },
  ref,
) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md font-medium whitespace-nowrap transition-colors select-none",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0",
        variants[variant],
        variant !== "link" && sizes[size],
        className,
      )}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {loading ? <Spinner /> : null}
          {children}
        </>
      )}
    </Comp>
  );
});

export function Spinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cn("size-4 animate-spin", className)} aria-hidden>
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
