import clsx from "clsx";

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx("animate-pulse rounded-md bg-sunken", className)} aria-hidden />;
}

/** Placeholder for a page while its data loads: header, toolbar and rows. */
export function PageSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="px-4 py-5 lg:px-6" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="mt-5 h-9 w-full max-w-md" />
      <div className="mt-5 space-y-2">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}
