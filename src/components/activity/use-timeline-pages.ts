"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadTimeline } from "@/actions/timeline";
import type { EntityType } from "@/lib/constants";
import type { TimelineFilter, TimelineItem } from "@/lib/crm/activities";

type View = { items: TimelineItem[]; hasMore: boolean };

const keyOf = (i: TimelineItem) => (i.kind === "activity" ? `a:${i.row.activity.id}` : i.kind === "event" ? `e:${i.event.id}` : i.kind === "file" ? `f:${i.file.id}` : `m:${i.mail.id}`);

/** The first of each entry, newest first. */
function unique(items: TimelineItem[]) {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = keyOf(i);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Where to read on from: the oldest entry's time, and how many entries at exactly that time are already shown. */
function cursor(items: TimelineItem[]) {
  const before = items.at(-1)?.at;
  return { before, skip: before ? items.filter((i) => i.at === before).length : 0 };
}

/**
 * A record's past, a page at a time (`timelinePage` on the server). The page
 * renders the first entries; more load as the timeline is scrolled, and a
 * filter loads its own pages (until everything is loaded, when it just
 * filters what's there).
 *
 * When the page re-renders (a live update, the teammate's own change), the
 * new first page shows at once and whatever was loaded below it is read
 * again behind it in one request, so an edit or deletion further down shows
 * too.
 */
export function useTimelinePages({ entity, id, first, hasMore, filter }: { entity: EntityType; id: string; first: TimelineItem[]; hasMore: boolean; filter: TimelineFilter }) {
  const [views, setViews] = useState<Partial<Record<TimelineFilter, View>>>({ all: { items: first, hasMore } });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = useRef({ first, request: 0 });
  const viewsRef = useRef(views);
  useEffect(() => {
    viewsRef.current = views;
  });

  // The page re-rendered with a new first page.
  useEffect(() => {
    const s = state.current;
    if (s.first === first) return;
    const before = viewsRef.current.all?.items ?? [];
    const below = before.length - s.first.length;
    s.first = first;
    const request = ++s.request;
    setLoading(false);
    setError(null);
    if (below <= 0 || !first.length) return void setViews({ all: { items: first, hasMore } });
    const { before: at, skip } = cursor(first);
    // Show the new first page with what was loaded below it now; read that part again behind it.
    // Everything loaded that's at or older than the new page's last entry: entries pushed below it by new ones included.
    const older = before.filter((i) => i.at <= at!);
    setViews({ all: { items: unique([...first, ...older]), hasMore: viewsRef.current.all?.hasMore ?? hasMore } });
    void loadTimeline({ entity, id, before: at, skip, limit: Math.min(Math.max(older.length, 1), 1000) }).then((r) => {
      if (request !== state.current.request || !r.ok) return;
      setViews((v) => {
        const fresh = unique([...first, ...r.data.items]);
        // A page scrolled in while this was read goes on below what was read again.
        const end = fresh.at(-1)?.at;
        const later = r.data.hasMore && end ? (v.all?.items ?? []).filter((i) => i.at <= end) : [];
        const more = later.some((i) => i.at < end!);
        return { all: { items: unique([...fresh, ...later]), hasMore: more ? (v.all?.hasMore ?? r.data.hasMore) : r.data.hasMore } };
      });
    });
  }, [first, hasMore, entity, id]);

  const all = views.all ?? { items: first, hasMore };
  // Everything is loaded: a filter just filters it. Otherwise it reads its own pages.
  const view: View | undefined = filter === "all" || !all.hasMore ? all : views[filter];

  const load = useCallback(
    async (which: TimelineFilter, from: TimelineItem[]) => {
      const s = state.current;
      const request = s.request;
      setLoading(true);
      setError(null);
      const r = await loadTimeline({ entity, id, filter: which, ...cursor(from) });
      if (request !== state.current.request) return;
      setLoading(false);
      if (!r.ok) return void setError(r.error);
      // Onto what's shown now (a live refresh may have read it again meanwhile).
      setViews((v) => ({ ...v, [which]: { items: unique([...(v[which]?.items ?? from), ...r.data.items]), hasMore: r.data.hasMore } }));
    },
    [entity, id],
  );

  // A filter shown for the first time, with more to load than what's here: read its first page.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetching a filter's first page when it's picked
    if (!view && !loading && !error) void load(filter, []);
  }, [view, loading, error, filter, load]);

  const loadMore = useCallback(() => {
    if (loading) return;
    // A filter whose first page failed: "Try again" reads it again.
    if (!view) return void load(filter, []);
    if (!view.hasMore) return;
    void load(filter === "all" || !all.hasMore ? "all" : filter, view.items);
  }, [loading, view, filter, all.hasMore, load]);

  return { items: view?.items ?? [], hasMore: view ? view.hasMore : true, loading: loading || (!view && !error), error, loadMore };
}
