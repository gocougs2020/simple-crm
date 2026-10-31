"use client";

import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/20/solid";
import { useListParams } from "./use-params";

export type Column<T> = {
  key: string;
  label: string;
  /** Server sort key; omit for columns that can't be sorted. */
  sort?: string;
  align?: "right";
  className?: string;
  render: (row: T) => ReactNode;
};

/**
 * Dense, scannable table (HiringCenter "modern table"): sticky uppercase
 * header, flat hover tint, the whole row clickable, sorting in the URL. Rows
 * owned by the viewer get a subtle marker. Selection shows a bulk-action bar.
 */
export function DataTable<T>({
  columns,
  rows,
  rowId,
  href,
  mine,
  defaultSort,
  bulk,
  empty,
}: {
  columns: Column<T>[];
  rows: T[];
  rowId: (row: T) => string;
  href: (row: T) => string;
  mine?: (row: T) => boolean;
  defaultSort?: string;
  bulk?: (ids: string[], clear: () => void) => ReactNode;
  empty?: ReactNode;
}) {
  const router = useRouter();
  const { get, set } = useListParams();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const sort = get("sort") ?? defaultSort;
  const dir = get("dir");
  const ids = rows.map(rowId);
  // Drop selections that are no longer in the list (after a filter or bulk archive).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- prune selection to rows still shown
    setSelected((s) => new Set([...s].filter((id) => ids.includes(id))));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- by id list
  }, [ids.join()]);

  const toggleSort = (key: string) => {
    if (sort !== key) set({ sort: key, dir: null });
    else set({ dir: dir === "desc" ? "asc" : dir === "asc" ? "desc" : "desc" });
  };
  const allOn = rows.length > 0 && selected.size === rows.length;

  if (!rows.length && empty) return <div className="px-4 lg:px-6">{empty}</div>;

  return (
    <div className="px-4 pb-6 lg:px-6">
      {bulk && selected.size ? (
        <div className="sticky top-12 z-20 mb-2 flex animate-pop-in items-center gap-3 rounded-lg border border-line bg-primary px-3 py-2 text-[13px] text-white shadow-md lg:top-2">
          <span className="font-medium tabular-nums">{selected.size} selected</span>
          <div className="flex flex-1 flex-wrap items-center gap-2">{bulk([...selected], () => setSelected(new Set()))}</div>
          <button type="button" onClick={() => setSelected(new Set())} className="text-white/70 hover:text-white">
            Clear
          </button>
        </div>
      ) : null}
      <div className="table-container max-h-[calc(100dvh-11rem)]">
        <table className="w-full border-collapse text-left text-[13.5px]">
          <thead className="sticky top-0 z-10 bg-surface shadow-[0_1px_0_var(--border)]">
            <tr>
              {bulk ? (
                <th className="w-10 px-3 py-2">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--accent)]"
                    checked={allOn}
                    ref={(el) => {
                      if (el) el.indeterminate = selected.size > 0 && !allOn;
                    }}
                    onChange={() => setSelected(allOn ? new Set() : new Set(ids))}
                    aria-label="Select all"
                  />
                </th>
              ) : null}
              {columns.map((c) => (
                <th key={c.key} scope="col" className={clsx("h-10 px-3 text-table-header whitespace-nowrap", c.align === "right" && "text-right", c.className)} aria-sort={c.sort && sort === c.sort ? (dir === "asc" ? "ascending" : "descending") : undefined}>
                  {c.sort ? (
                    <button type="button" onClick={() => toggleSort(c.sort!)} className={clsx("inline-flex items-center gap-1 tracking-[inherit] uppercase hover:text-primary", sort === c.sort && "text-primary")}>
                      {c.label}
                      {sort === c.sort ? dir === "asc" ? <ChevronUpIcon className="size-3.5" /> : dir === "desc" ? <ChevronDownIcon className="size-3.5" /> : null : null}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const id = rowId(row);
              const isMine = mine?.(row);
              return (
                <tr
                  key={id}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("a,button,input,label")) return;
                    const url = href(row);
                    if (e.metaKey || e.ctrlKey || url.startsWith("/api/")) window.open(url, "_blank");
                    else router.push(url);
                  }}
                  className={clsx("table-row-link border-t border-line first:border-t-0", selected.has(id) && "bg-accent-soft")}
                >
                  {bulk ? (
                    <td className={clsx("w-10 px-3 py-2", isMine && "shadow-[inset_2px_0_0_var(--accent)]")}>
                      <input
                        type="checkbox"
                        className="size-4 accent-[var(--accent)]"
                        checked={selected.has(id)}
                        onChange={() =>
                          setSelected((s) => {
                            const n = new Set(s);
                            if (n.has(id)) n.delete(id);
                            else n.add(id);
                            return n;
                          })
                        }
                        aria-label="Select row"
                      />
                    </td>
                  ) : null}
                  {columns.map((c, i) => (
                    <td key={c.key} className={clsx("h-11 px-3 py-1.5 whitespace-nowrap", c.align === "right" && "text-right", !bulk && i === 0 && isMine && "shadow-[inset_2px_0_0_var(--accent)]", c.className)}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-fine">
        {rows.length.toLocaleString()} {rows.length === 1 ? "row" : "rows"}
        {rows.length >= 500 ? " · showing the first 500. Search or filter to narrow it down." : ""}
      </p>
    </div>
  );
}
