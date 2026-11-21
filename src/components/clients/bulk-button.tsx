"use client";

import type { ReactNode } from "react";

/** A button in the bar that appears over a table when rows are selected (People, Organizations, Clients). */
export function BulkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="h-7 rounded-md border border-white/20 bg-white/10 px-2.5 text-[12.5px] font-medium text-white hover:bg-white/20">
      {children}
    </button>
  );
}
