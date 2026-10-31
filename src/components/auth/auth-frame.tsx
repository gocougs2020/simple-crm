import type { ReactNode } from "react";

/** The centered card every signed-out page uses. */
export function AuthFrame({ workspace, title, description, children, footer }: { workspace?: string; title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-12">
      <div className="w-full max-w-[380px]">
        {workspace ? <p className="mb-6 text-center text-[13px] font-semibold tracking-wide text-muted">{workspace}</p> : null}
        <div className="rounded-xl border border-line bg-surface p-6 shadow-default sm:p-7">
          <h1 className="text-[20px] font-semibold tracking-tight">{title}</h1>
          {description ? <p className="mt-1 text-[14px] text-muted">{description}</p> : null}
          <div className="mt-6">{children}</div>
        </div>
        {footer ? <div className="mt-5 text-center text-[13px] text-muted">{footer}</div> : null}
      </div>
    </main>
  );
}

export function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-md border border-error-border bg-error-surface px-3 py-2 text-[13px] text-error">
      {message}
    </p>
  );
}
