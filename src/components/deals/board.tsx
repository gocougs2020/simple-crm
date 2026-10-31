"use client";

import clsx from "clsx";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ExclamationTriangleIcon, PlusIcon, TrophyIcon, XCircleIcon } from "@heroicons/react/20/solid";
import { moveDeal, setDealStatus } from "@/actions/records";
import { useApp } from "@/components/app-context";
import { openCreate } from "@/components/shell/create-store";
import { NextActivityCell } from "@/components/table/cells";
import { Avatar } from "@/components/ui/avatar";
import { Tooltip } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import type { DealRow } from "@/lib/crm/records";
import type { Pipeline } from "@/lib/crm/context";
import { daysSince } from "@/lib/format";

type Columns = Record<string, DealRow[]>;

function group(deals: DealRow[], pipeline: Pipeline): Columns {
  const cols: Columns = Object.fromEntries(pipeline.stages.map((s) => [s.id, [] as DealRow[]]));
  for (const d of deals) if (d.deal.status === "open") cols[d.deal.stageId]?.push(d);
  return cols;
}

/**
 * The pipeline board. Drag a card to another stage (or within one to
 * reorder); drop it on Won or Lost to close it. Keyboard: focus a card, Space
 * to pick it up, arrows to move, Space to drop. Every move is undoable.
 */
export function DealsBoard({ deals, pipeline }: { deals: DealRow[]; pipeline: Pipeline }) {
  const { money } = useApp();
  const [cols, setCols] = useState(() => group(deals, pipeline));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [origin, setOrigin] = useState<string | null>(null);
  // Server data wins whenever it changes (after a save or someone else's edit).
  // eslint-disable-next-line react-hooks/set-state-in-effect -- re-sync local board with fresh server data
  useEffect(() => setCols(group(deals, pipeline)), [deals, pipeline]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const findCol = (id: string) => (id in cols ? id : Object.keys(cols).find((k) => cols[k].some((d) => d.deal.id === id)));
  const active = useMemo(() => (activeId ? Object.values(cols).flat().find((d) => d.deal.id === activeId) : null), [activeId, cols]);

  const onStart = (e: DragStartEvent) => {
    setActiveId(String(e.active.id));
    setOrigin(findCol(String(e.active.id)) ?? null);
  };

  // Moving between columns while dragging, so the card shows where it'll land.
  const onOver = (e: DragOverEvent) => {
    const id = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    if (!overId || overId === "won" || overId === "lost") return;
    const from = findCol(id);
    const to = findCol(overId);
    if (!from || !to || from === to) return;
    setCols((c) => {
      const card = c[from].find((d) => d.deal.id === id)!;
      const target = [...c[to]];
      const at = overId === to ? target.length : Math.max(0, target.findIndex((d) => d.deal.id === overId));
      target.splice(at, 0, { ...card, deal: { ...card.deal, stageId: to } });
      return { ...c, [from]: c[from].filter((d) => d.deal.id !== id), [to]: target };
    });
  };

  const onEnd = async (e: DragEndEvent) => {
    const id = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    setActiveId(null);
    if (!overId) return setCols(group(deals, pipeline));

    if (overId === "won" || overId === "lost") {
      const card = Object.values(cols).flat().find((d) => d.deal.id === id);
      setCols((c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.filter((d) => d.deal.id !== id)])));
      const r = await setDealStatus(id, { status: overId });
      if (!r.ok) {
        setCols(group(deals, pipeline));
        return void toast.error(r.error);
      }
      toast.success(`${card?.deal.title ?? "Deal"} marked ${overId}`, { label: "Undo", onClick: () => setDealStatus(id, { status: "open" }) });
      return;
    }

    const col = findCol(id);
    if (!col) return;
    let list = cols[col];
    const from = list.findIndex((d) => d.deal.id === id);
    const to = overId === col ? list.length - 1 : list.findIndex((d) => d.deal.id === overId);
    if (to >= 0 && from !== to) {
      list = [...list];
      const [card] = list.splice(from, 1);
      list.splice(to, 0, card);
      setCols((c) => ({ ...c, [col]: list }));
    }
    const at = list.findIndex((d) => d.deal.id === id);
    if (col === origin && at === from && from === to) return;
    const r = await moveDeal(id, col, { beforeId: list[at - 1]?.deal.id ?? null, afterId: list[at + 1]?.deal.id ?? null });
    if (!r.ok) {
      setCols(group(deals, pipeline));
      return void toast.error(r.error);
    }
    if (col !== origin) {
      const stageName = pipeline.stages.find((s) => s.id === col)?.name;
      const back = origin;
      toast.success(`Moved to ${stageName}`, back ? { label: "Undo", onClick: () => moveDeal(id, back) } : undefined);
    }
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onStart} onDragOver={onOver} onDragEnd={onEnd} onDragCancel={() => (setActiveId(null), setCols(group(deals, pipeline)))}>
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 pb-4 lg:px-6 scroll-visible snap-x snap-mandatory lg:snap-none">
        {pipeline.stages.map((s) => {
          const list = cols[s.id] ?? [];
          const total = list.reduce((sum, d) => sum + d.deal.value, 0);
          return (
            <Column key={s.id} id={s.id}>
              <header className="flex items-start justify-between gap-2 px-3 pt-2.5 pb-2">
                <div className="min-w-0">
                  <h2 className="truncate text-[13px] font-semibold text-primary">{s.name}</h2>
                  <p className="text-[12px] text-muted tabular-nums">
                    {money(total)} · {list.length} {list.length === 1 ? "deal" : "deals"}
                  </p>
                </div>
                <Tooltip content={`Add a deal to ${s.name}`}>
                  <button
                    type="button"
                    onClick={() => openCreate({ kind: "deal", defaults: { stageId: s.id, pipelineId: pipeline.id } })}
                    className="rounded-md p-1 text-faint hover:bg-surface hover:text-primary"
                    aria-label={`Add a deal to ${s.name}`}
                  >
                    <PlusIcon className="size-4" />
                  </button>
                </Tooltip>
              </header>
              <SortableContext id={s.id} items={list.map((d) => d.deal.id)} strategy={verticalListSortingStrategy}>
                <ul className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2 scroll-thin">
                  {list.map((d) => (
                    <SortableCard key={d.deal.id} row={d} rottingDays={s.rottingDays} />
                  ))}
                  {!list.length ? <li className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-line py-6 text-[12px] text-faint">Drop deals here</li> : null}
                </ul>
              </SortableContext>
            </Column>
          );
        })}
      </div>
      {activeId ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center gap-3 px-4">
          <DropZone id="won" label="Won" icon={<TrophyIcon className="size-4" />} tone="success" />
          <DropZone id="lost" label="Lost" icon={<XCircleIcon className="size-4" />} tone="error" />
        </div>
      ) : null}
      <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }}>{active ? <Card row={active} dragging /> : null}</DragOverlay>
    </DndContext>
  );
}

function Column({ id, children }: { id: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <section ref={setNodeRef} className={clsx("flex w-[280px] shrink-0 snap-start flex-col rounded-xl border border-line bg-sunken/60 transition-colors", isOver && "bg-accent-soft")} aria-label={id}>
      {children}
    </section>
  );
}

function DropZone({ id, label, icon, tone }: { id: string; label: string; icon: React.ReactNode; tone: "success" | "error" }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={clsx(
        "pointer-events-auto flex h-14 w-44 animate-slide-up items-center justify-center gap-2 rounded-xl border-2 border-dashed bg-surface text-[14px] font-semibold shadow-lg transition-all",
        tone === "success" ? "border-success-border text-success" : "border-error-border text-error",
        isOver && (tone === "success" ? "scale-105 bg-success-surface" : "scale-105 bg-error-surface"),
      )}
    >
      {icon}
      {label}
    </div>
  );
}

function SortableCard({ row, rottingDays }: { row: DealRow; rottingDays: number | null }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.deal.id });
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} {...attributes} {...listeners} className={clsx("outline-none", isDragging && "opacity-40")}>
      <Card row={row} rottingDays={rottingDays} />
    </li>
  );
}

/** Title, who it's with, value, owner, and the next step. Flags deals with nothing planned or that have sat too long. */
function Card({ row, dragging, rottingDays }: { row: DealRow; dragging?: boolean; rottingDays?: number | null }) {
  const { money, member } = useApp();
  const d = row.deal;
  const owner = member(d.ownerId);
  const who = row.organizationName ?? ([row.personFirstName, row.personLastName].filter(Boolean).join(" ") || null);
  const days = daysSince(d.stageChangedAt);
  const rotting = rottingDays != null && days >= rottingDays;
  return (
    <article
      className={clsx(
        "group relative rounded-xl border bg-surface px-3 py-2.5 transition-[transform,box-shadow] duration-200",
        dragging ? "rotate-[1.5deg] border-line-strong shadow-[var(--shadow-card-drag)]" : "border-line shadow-sm hover:-translate-y-0.5 hover:shadow-md",
        rotting && !dragging && "border-warning-border",
      )}
    >
      <Link href={`/deals/${d.id}`} className="block text-[13.5px] leading-snug font-medium text-primary hover:underline" draggable={false} onClick={(e) => dragging && e.preventDefault()}>
        {d.title}
      </Link>
      {who ? <p className="mt-0.5 truncate text-[12.5px] text-muted">{who}</p> : null}
      <div className="mt-2 flex items-center gap-2">
        <span className="text-[13px] font-medium text-secondary tabular-nums">{money(d.value)}</span>
        {rotting ? (
          <Tooltip content={`In this stage for ${days} days`}>
            <span className="inline-flex items-center gap-0.5 text-[11.5px] font-medium text-warning">
              <ExclamationTriangleIcon className="size-3" aria-hidden />
              {days}d
            </span>
          </Tooltip>
        ) : null}
        <span className="ml-auto">{owner ? <Avatar name={owner.name} size="xs" /> : null}</span>
      </div>
      <div className="mt-2 border-t border-line pt-2 text-[12px]">
        <NextActivityCell next={row.next} warnIfNone />
      </div>
    </article>
  );
}
