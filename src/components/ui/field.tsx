import { cn } from "@/lib/cn";
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { ChevronUpDownIcon } from "@heroicons/react/20/solid";

const control =
  "w-full rounded-md border border-line bg-surface text-[14px] text-primary shadow-sm transition-colors placeholder:text-faint hover:border-line-strong focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-error aria-[invalid=true]:ring-error";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(control, "h-9 px-3", className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(control, "min-h-20 px-3 py-2 leading-relaxed", className)} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...props }, ref) {
  return (
    <div className={cn("relative", className)}>
      <select ref={ref} className={cn(control, "h-9 appearance-none pr-8 pl-3")} {...props}>
        {children}
      </select>
      <ChevronUpDownIcon className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-faint" aria-hidden />
    </div>
  );
});

/** A label, the control, and an optional hint or error underneath. The control gets the id. */
export function Field({
  label,
  hint,
  error,
  optional,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
  className?: string;
  children: (props: { id: string; "aria-invalid"?: boolean; "aria-describedby"?: string }) => ReactNode;
}) {
  const id = useId();
  const noteId = `${id}-note`;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-label">
        {label}
        {optional ? <span className="ml-1 font-normal text-muted">(optional)</span> : null}
      </label>
      {children({ id, "aria-invalid": error ? true : undefined, "aria-describedby": error || hint ? noteId : undefined })}
      {error ? (
        <p id={noteId} className="text-[12px] text-error">
          {error}
        </p>
      ) : hint ? (
        <p id={noteId} className="text-fine">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Checkbox({ label, className, ...props }: InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode }) {
  return (
    <label className={cn("inline-flex cursor-pointer items-center gap-2 text-[14px] text-secondary select-none", className)}>
      <input type="checkbox" className="size-4 cursor-pointer rounded-sm border-line-strong accent-[var(--accent)]" {...props} />
      {label}
    </label>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-line bg-surface px-1 font-sans text-[11px] font-medium text-muted", className)}>
      {children}
    </kbd>
  );
}
