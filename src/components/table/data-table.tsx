"use client";

import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { ArrowsUpDownIcon, BarsArrowDownIcon, BarsArrowUpIcon, ChevronDownIcon, ChevronRightIcon, ChevronUpIcon } from "@heroicons/react/20/solid";
import { useListParams } from "./use-params";

export type Column<T> = {
  key: string;
  label: string;
  /** Server sort key; omit for columns that can't be sorted. */
  sort?: string;
  align?: "right";
  className?: string;
  render: (row: T) => ReactNode;
  /**
   * On a phone the table becomes a list: the first column is each row's title.
   * "meta" columns go on the line under it, "end" on the right. Others are left
   * out there. `mobileRender` replaces `render` in the list; return null to skip
   * an empty value instead of showing a dash.
   */
  mobile?: "meta" | "end";
  mobileRender?: (row: T) => ReactNode;
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
  paging,
}: {
  columns: Column<T>[];
  rows: T[];
  rowId: (row: T) => string;
  href: (row: T) => string;
  mine?: (row: T) => boolean;
  defaultSort?: string;
  /** `ids` are the selected rows' ids; `selected` the rows themselves. */
  bulk?: (ids: string[], clear: () => void, selected: T[]) => ReactNode;
  empty?: ReactNode;
  /** Rows load as the table is scrolled (usePagedRows): `total` is how many there are in all. */
  paging?: { total: number; hasMore: boolean; loading: boolean; error: string | null; loadMore: () => void };
}) {
  const router = useRouter();
  const prefetched = useRef(new Set<string>());
  const prefetchRow = (row: T) => {
    const url = href(row);
    if (prefetched.current.has(url) || url.startsWith("/api/")) return;
    prefetched.current.add(url);
    router.prefetch(url);
  };
  const { get, set } = useListParams();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // On a phone, checkboxes show only after tapping Select, so a tap on a row opens it.
  const [selecting, setSelecting] = useState(false);
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
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const open = (e: MouseEvent, row: T) => {
    if ((e.target as HTMLElement).closest("a,button,input,label")) return;
    const url = href(row);
    if (e.metaKey || e.ctrlKey || url.startsWith("/api/")) window.open(url, "_blank");
    else router.push(url);
  };

  // Load the next page a little before the end comes into view, so scrolling doesn't stop.
  // The table scrolls in its own box; the phone list scrolls with the page. Only the one on screen intersects.
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const listSentinel = useRef<HTMLDivElement>(null);
  const loadMore = paging?.loadMore;
  const wantMore = !!paging?.hasMore && !paging.loading && !paging.error;
  useEffect(() => {
    if (!wantMore || !loadMore) return;
    const observers = [
      [sentinel.current, scroller.current],
      [listSentinel.current, null],
    ].flatMap(([target, root]) => {
      if (!target) return [];
      const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadMore(), { root, rootMargin: "0px 0px 800px 0px" });
      io.observe(target);
      return [io];
    });
    return () => observers.forEach((io) => io.disconnect());
  }, [wantMore, loadMore, rows.length]);

  const [title, ...others] = columns;
  const meta = others.filter((c) => c.mobile === "meta");
  const end = others.find((c) => c.mobile === "end");
  const sortable = columns.filter((c) => c.sort);

  if (!rows.length && empty) return <div className="px-4 lg:px-6">{empty}</div>;

  return (
    <div className="px-4 pb-6 lg:px-6">
      {bulk && selected.size ? (
        <div className="sticky top-[calc(var(--shell-top)+0.5rem)] z-20 mb-2 flex animate-pop-in items-center gap-3 rounded-lg border border-line bg-primary px-3 py-2 text-[13px] text-white shadow-md lg:top-2">
          <span className="font-medium tabular-nums">{selected.size} selected</span>
          <div className="flex flex-1 flex-wrap items-center gap-2">
            {bulk(
              [...selected],
              () => setSelected(new Set()),
              rows.filter((r) => selected.has(rowId(r))),
            )}
          </div>
          <button type="button" onClick={() => setSelected(new Set())} className="text-white/70 hover:text-white">
            Clear
          </button>
        </div>
      ) : null}
      {/* Phones: a list, sorted and selected from the row above it. */}
      <div className="sm:hidden">
        {sortable.length || bulk ? (
          <div className="mb-2 flex items-center gap-2">
            {sortable.length ? (
              <>
                <label className="relative flex h-9 min-w-0 items-center gap-1.5 rounded-md border border-line bg-surface pr-3 pl-2.5 text-[13.5px] text-secondary shadow-sm">
                  <span className="shrink-0 text-muted">Sort</span>
                  <span className="truncate font-medium text-primary">{sortable.find((c) => c.sort === sort)?.label ?? "Default"}</span>
                  <ChevronDownIcon className="size-4 shrink-0 text-faint" aria-hidden />
                  <select value={sort ?? ""} onChange={(e) => set({ sort: e.target.value || null, dir: null })} className="absolute inset-0 cursor-pointer opacity-0" aria-label="Sort by">
                    {!defaultSort ? <option value="">Default</option> : null}
                    {sortable.map((c) => (
                      <option key={c.key} value={c.sort}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                {sort ? (
                  <button
                    type="button"
                    onClick={() => set({ dir: dir === "asc" ? "desc" : "asc" })}
                    className="flex size-9 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-secondary shadow-sm active:bg-sunken"
                    aria-label={dir === "asc" ? "Ascending. Sort descending" : dir === "desc" ? "Descending. Sort ascending" : "Reverse the order"}
                  >
                    {dir === "asc" ? <BarsArrowUpIcon className="size-4" /> : dir === "desc" ? <BarsArrowDownIcon className="size-4" /> : <ArrowsUpDownIcon className="size-4" />}
                  </button>
                ) : null}
              </>
            ) : null}
            <span className="flex-1" />
            {bulk ? (
              <button
                type="button"
                onClick={() => {
                  if (selecting) setSelected(new Set());
                  setSelecting(!selecting);
                }}
                className="h-9 rounded-md px-3 text-[13.5px] font-medium text-primary active:bg-sunken"
              >
                {selecting ? "Done" : "Select"}
              </button>
            ) : null}
          </div>
        ) : null}
        <ul className="overflow-hidden rounded-xl border border-line bg-surface">
          {rows.map((row) => {
            const id = rowId(row);
            const metas = meta.map((c) => ({ key: c.key, node: (c.mobileRender ?? c.render)(row) })).filter((m) => m.node != null && m.node !== false);
            return (
              <li
                key={id}
                onPointerDown={() => prefetchRow(row)}
                onClick={(e) => {
                  if (!selecting) return open(e, row);
                  if (!(e.target as HTMLElement).closest("a,button,input,label")) toggle(id);
                }}
                className={clsx(
                  "flex min-h-14 cursor-pointer items-center gap-3 border-t border-line px-3.5 py-2.5 transition-colors first:border-t-0 active:bg-sunken",
                  selected.has(id) && "bg-accent-soft",
                  mine?.(row) && "shadow-[inset_2px_0_0_var(--accent)]",
                )}
              >
                {selecting ? <input type="checkbox" className="size-5 shrink-0 cursor-pointer accent-[var(--accent)]" checked={selected.has(id)} onChange={() => toggle(id)} aria-label="Select row" /> : null}
                <div className="min-w-0 flex-1 text-[14.5px]">
                  <div className="min-w-0">{(title.mobileRender ?? title.render)(row)}</div>
                  {metas.length ? (
                    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-muted">
                      {metas.map((m) => (
                        <span key={m.key} className="min-w-0 truncate">
                          {m.node}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
                {end ? <div className="shrink-0 text-right text-[13.5px] font-medium text-primary tabular-nums">{(end.mobileRender ?? end.render)(row)}</div> : null}
                {!selecting ? <ChevronRightIcon className="-mr-1 size-4 shrink-0 text-faint" aria-hidden /> : null}
              </li>
            );
          })}
        </ul>
        {paging ? <div ref={listSentinel} aria-hidden className="h-px" /> : null}
        {paging?.loading ? <p className="py-2.5 text-center text-fine">Loading more…</p> : null}
        {paging?.error ? (
          <p className="py-2.5 text-center text-fine">
            {paging.error}{" "}
            <button type="button" onClick={paging.loadMore} className="font-medium text-accent hover:underline">
              Try again
            </button>
          </p>
        ) : null}
      </div>
      <div ref={scroller} className="table-container hidden max-h-[calc(100dvh-11rem)] sm:block">
        <table className="w-full border-collapse text-left text-[13.5px]">
          <thead className="sticky top-0 z-10 bg-surface shadow-[0_1px_0_var(--border)]">
            <tr>
              {bulk ? (
                <th className="w-11 p-0">
                  <label className="flex h-10 cursor-pointer items-center justify-center px-3">
                    <input
                      type="checkbox"
                      className="size-[18px] cursor-pointer accent-[var(--accent)]"
                      checked={allOn}
                      ref={(el) => {
                        if (el) el.indeterminate = selected.size > 0 && !allOn;
                      }}
                      onChange={() => setSelected(allOn ? new Set() : new Set(ids))}
                      aria-label="Select all"
                    />
                  </label>
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
                  // Rows open with router.push, which doesn't prefetch: start loading the record on the way to it, once per row.
                  onPointerEnter={() => prefetchRow(row)}
                  onFocusCapture={() => prefetchRow(row)}
                  onClick={(e) => open(e, row)}
                  className={clsx("table-row-link border-t border-line first:border-t-0", selected.has(id) && "bg-accent-soft")}
                >
                  {bulk ? (
                    <td className={clsx("w-11 p-0", isMine && "shadow-[inset_2px_0_0_var(--accent)]")}>
                      <label className="flex h-11 cursor-pointer items-center justify-center px-3">
                        <input
                          type="checkbox"
                          className="size-[18px] cursor-pointer accent-[var(--accent)]"
                          checked={selected.has(id)}
                          onChange={() => toggle(id)}
                          aria-label="Select row"
                        />
                      </label>
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
        {paging ? <div ref={sentinel} aria-hidden className="h-px" /> : null}
        {paging?.loading ? <p className="border-t border-line px-3 py-2.5 text-center text-fine">Loading more…</p> : null}
        {paging?.error ? (
          <p className="border-t border-line px-3 py-2.5 text-center text-fine">
            {paging.error}{" "}
            <button type="button" onClick={paging.loadMore} className="font-medium text-accent hover:underline">
              Try again
            </button>
          </p>
        ) : null}
      </div>
      <p className="mt-2 text-fine">
        {paging ? (
          <>
            {rows.length < paging.total ? `${rows.length.toLocaleString()} of ` : null}
            {paging.total.toLocaleString()} {paging.total === 1 ? "row" : "rows"}
            {rows.length < paging.total ? " · more load as you scroll" : ""}
          </>
        ) : (
          <>
            {rows.length.toLocaleString()} {rows.length === 1 ? "row" : "rows"}
            {rows.length >= 500 ? " · showing the first 500. Search or filter to narrow it down." : ""}
          </>
        )}
      </p>
    </div>
  );
}
