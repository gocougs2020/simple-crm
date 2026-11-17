"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Result } from "@/lib/action";

/**
 * A table that loads more rows as it's scrolled. The page renders the first
 * rows and the total; `fetchPage` gets the rest, a page at a time.
 *
 * - New filters or sort (a different `filterKey`) start over from the
 *   page's first rows.
 * - The same filters re-rendered (after an archive, merge or edit) keep what
 *   was scrolled to: the rows past the first page are fetched again in one
 *   request, so nothing archived or merged lingers further down.
 */
export function usePagedRows<T>({ first, total, filterKey, rowId, pageSize, fetchPage }: { first: T[]; total: number; filterKey: string; rowId: (row: T) => string; pageSize: number; fetchPage: (offset: number, limit: number) => Promise<Result<T[]>> }) {
  const [rows, setRows] = useState(first);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A short page means the end, even if the total said otherwise (rows archived meanwhile).
  const [done, setDone] = useState(false);
  const state = useRef({ first, filterKey, loaded: first.length, request: 0 });
  const fetchRef = useRef(fetchPage);
  useEffect(() => {
    fetchRef.current = fetchPage;
  });

  const unique = useCallback(
    (list: T[]) => {
      const seen = new Set<string>();
      return list.filter((r) => {
        const id = rowId(r);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    },
    [rowId],
  );

  // The page re-rendered with new first rows.
  useEffect(() => {
    const s = state.current;
    if (s.first === first) return;
    const sameView = s.filterKey === filterKey;
    const loaded = s.loaded;
    s.first = first;
    s.filterKey = filterKey;
    const request = ++s.request;
    setLoading(false);
    setDone(false);
    if (!sameView || loaded <= first.length) {
      s.loaded = first.length;
      setRows(first);
      return;
    }
    // Same view, scrolled further: show the new first page now and refresh the rest behind it.
    setRows((prev) => unique([...first, ...prev.slice(first.length)]));
    // Up to 2,000 rows in one request (the most a refresh asks for); anything further loads again on scroll.
    void fetchRef.current(first.length, Math.min(loaded - first.length, 2000)).then((r) => {
      if (request !== state.current.request) return;
      if (!r.ok) return;
      state.current.loaded = first.length + r.data.length;
      setRows(unique([...first, ...r.data]));
    });
  }, [first, filterKey, unique]);

  const hasMore = !done && rows.length < total;
  const loadMore = useCallback(async () => {
    const s = state.current;
    if (loading || !hasMore) return;
    setLoading(true);
    setError(null);
    const request = s.request;
    const r = await fetchRef.current(rows.length, pageSize);
    if (request !== state.current.request) return;
    setLoading(false);
    if (!r.ok) return void setError(r.error);
    if (r.data.length < pageSize) setDone(true);
    s.loaded = rows.length + r.data.length;
    setRows((prev) => unique([...prev, ...r.data]));
  }, [loading, hasMore, rows.length, pageSize, unique]);

  return { rows, hasMore, loading, error, loadMore };
}
