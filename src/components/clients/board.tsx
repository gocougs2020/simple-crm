"use client";

import clsx from "clsx";
import Link from "next/link";
import { useEffect, useId, useMemo, useState } from "react";
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
import { ArrowRightStartOnRectangleIcon, ArrowUturnLeftIcon, CheckBadgeIcon, ExclamationTriangleIcon, PlusIcon } from "@heroicons/react/20/solid";
import { moveClient } from "@/actions/clients";
import { useApp } from "@/components/app-context";
import { openCreate } from "@/components/shell/create-store";
import { NextActivityCell } from "@/components/table/cells";
import { Avatar } from "@/components/ui/avatar";
import { Tooltip } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import type { ClientRow } from "@/lib/crm/records";
import type { Pipeline } from "@/lib/crm/context";
import type { ClientCategory } from "@/lib/constants";
import { daysSince } from "@/lib/format";
import { ChangeCategoryDialog, HealthBadge, moves } from "./client-controls";

type Columns = Record<string, ClientRow[]>;

function group(rows: ClientRow[], pipeline: Pipeline): Columns {
  const cols: Columns = Object.fromEntries(pipeline.stages.map((s) => [s.id, [] as ClientRow[]]));
  for (const d of rows) cols[d.client.stageId]?.push(d);
  return cols;
}

const zoneIcons: Record<ClientCategory, React.ReactNode> = {
  current: <CheckBadgeIcon className="size-4" />,
  past: <ArrowRightStartOnRectangleIcon className="size-4" />,
  prospective: <ArrowUturnLeftIcon className="size-4" />,
};

/**
 * A category's pipeline board. Drag a card to another stage (or within one to
 * reorder); drop it on a zone at the bottom to move it to another category
 * (signed, left, won back), which asks for the details first. Keyboard: focus
 * a card, Space to pick it up, arrows to move, Space to drop.
 */
export function ClientsBoard({ rows, pipeline, category }: { rows: ClientRow[]; pipeline: Pipeline; category: ClientCategory }) {
  const [cols, setCols] = useState(() => group(rows, pipeline));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [origin, setOrigin] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ id: string; name: string; to: ClientCategory } | null>(null);
  // A stable id keeps dnd-kit's accessibility ids the same on the server and in the browser.
  const dndId = useId();
  // Server data wins whenever it changes (after a save or someone else's edit).
  // eslint-disable-next-line react-hooks/set-state-in-effect -- re-sync local board with fresh server data
  useEffect(() => setCols(group(rows, pipeline)), [rows, pipeline]);
  const zones = moves[category];
  const isZone = (id: string | null) => !!id && id.startsWith("move:");

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const findCol = (id: string) => (id in cols ? id : Object.keys(cols).find((k) => cols[k].some((d) => d.client.id === id)));
  const active = useMemo(() => (activeId ? Object.values(cols).flat().find((d) => d.client.id === activeId) : null), [activeId, cols]);

  const onStart = (e: DragStartEvent) => {
    setActiveId(String(e.active.id));
    setOrigin(findCol(String(e.active.id)) ?? null);
  };

  // Moving between columns while dragging, so the card shows where it'll land.
  const onOver = (e: DragOverEvent) => {
    const id = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    if (!overId || isZone(overId)) return;
    const from = findCol(id);
    const to = findCol(overId);
    if (!from || !to || from === to) return;
    setCols((c) => {
      const card = c[from].find((d) => d.client.id === id)!;
      const target = [...c[to]];
      const at = overId === to ? target.length : Math.max(0, target.findIndex((d) => d.client.id === overId));
      target.splice(at, 0, { ...card, client: { ...card.client, stageId: to } });
      return { ...c, [from]: c[from].filter((d) => d.client.id !== id), [to]: target };
    });
  };

  const onEnd = async (e: DragEndEvent) => {
    const id = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    setActiveId(null);
    if (!overId) return setCols(group(rows, pipeline));

    if (isZone(overId)) {
      const card = Object.values(cols).flat().find((d) => d.client.id === id);
      setCols(group(rows, pipeline));
      if (card) setMoving({ id, name: card.client.name, to: overId.slice(5) as ClientCategory });
      return;
    }

    const col = findCol(id);
    if (!col) return;
    let list = cols[col];
    const from = list.findIndex((d) => d.client.id === id);
    const to = overId === col ? list.length - 1 : list.findIndex((d) => d.client.id === overId);
    if (to >= 0 && from !== to) {
      list = [...list];
      const [card] = list.splice(from, 1);
      list.splice(to, 0, card);
      setCols((c) => ({ ...c, [col]: list }));
    }
    const at = list.findIndex((d) => d.client.id === id);
    if (col === origin && at === from && from === to) return;
    const r = await moveClient(id, col, { beforeId: list[at - 1]?.client.id ?? null, afterId: list[at + 1]?.client.id ?? null });
    if (!r.ok) {
      setCols(group(rows, pipeline));
      return void toast.error(r.error);
    }
    if (col !== origin) {
      const stageName = pipeline.stages.find((s) => s.id === col)?.name;
      const back = origin;
      toast.success(`Moved to ${stageName}`, back ? { label: "Undo", onClick: () => moveClient(id, back) } : undefined);
    }
  };

  return (
    <DndContext id={dndId} sensors={sensors} collisionDetection={closestCorners} onDragStart={onStart} onDragOver={onOver} onDragEnd={onEnd} onDragCancel={() => (setActiveId(null), setCols(group(rows, pipeline)))}>
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 pb-4 lg:px-6 scroll-visible snap-x snap-mandatory lg:snap-none">
        {pipeline.stages.map((s) => {
          const list = cols[s.id] ?? [];
          return (
            <Column key={s.id} id={s.id}>
              <header className="flex items-start justify-between gap-2 px-3 pt-2.5 pb-2">
                <div className="min-w-0">
                  <h2 className="truncate text-[13px] font-semibold text-primary">{s.name}</h2>
                  <ColumnTotal rows={list} category={category} />
                </div>
                <Tooltip content={`Add a client to ${s.name}`}>
                  <button
                    type="button"
                    onClick={() => openCreate({ kind: "client", defaults: { category, stageId: s.id } })}
                    className="rounded-md p-1 text-faint hover:bg-surface hover:text-primary"
                    aria-label={`Add a client to ${s.name}`}
                  >
                    <PlusIcon className="size-4" />
                  </button>
                </Tooltip>
              </header>
              <SortableContext id={s.id} items={list.map((d) => d.client.id)} strategy={verticalListSortingStrategy}>
                <ul className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2 scroll-thin">
                  {list.map((d) => (
                    <SortableCard key={d.client.id} row={d} rottingDays={s.rottingDays} category={category} />
                  ))}
                  {!list.length ? <li className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-line py-6 text-[12px] text-faint">Drop clients here</li> : null}
                </ul>
              </SortableContext>
            </Column>
          );
        })}
      </div>
      {activeId ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center gap-3 px-4">
          {zones.map((z) => (
            <DropZone key={z.to} id={`move:${z.to}`} label={z.label} icon={zoneIcons[z.to]} tone={z.to === "past" ? "error" : z.to === "current" ? "success" : "neutral"} />
          ))}
        </div>
      ) : null}
      <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }}>{active ? <Card row={active} dragging category={category} /> : null}</DragOverlay>
      {moving ? <ChangeCategoryDialog clientId={moving.id} name={moving.name} from={category} to={moving.to} onClose={() => setMoving(null)} /> : null}
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

/** What a column adds up to: potential value for prospects, monthly revenue for current clients, what past ones paid. */
function ColumnTotal({ rows, category }: { rows: ClientRow[]; category: ClientCategory }) {
  const { money } = useApp();
  const n = `${rows.length} ${rows.length === 1 ? "client" : "clients"}`;
  const total = category === "prospective" ? rows.reduce((s, r) => s + r.client.value, 0) : rows.reduce((s, r) => s + Number(category === "current" ? r.mrr : r.formerMrr), 0);
  return (
    <p className="text-[12px] text-muted tabular-nums">
      {total ? `${money(total)}${category === "prospective" ? "" : "/mo"} · ` : ""}
      {n}
    </p>
  );
}

function DropZone({ id, label, icon, tone }: { id: string; label: string; icon: React.ReactNode; tone: "success" | "error" | "neutral" }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={clsx(
        "pointer-events-auto flex h-14 w-44 animate-slide-up items-center justify-center gap-2 rounded-xl border-2 border-dashed bg-surface text-[14px] font-semibold shadow-lg transition-all",
        tone === "success" ? "border-success-border text-success" : tone === "error" ? "border-error-border text-error" : "border-line-strong text-secondary",
        isOver && (tone === "success" ? "scale-105 bg-success-surface" : tone === "error" ? "scale-105 bg-error-surface" : "scale-105 bg-sunken"),
      )}
    >
      {icon}
      {label}
    </div>
  );
}

function SortableCard({ row, rottingDays, category }: { row: ClientRow; rottingDays: number | null; category: ClientCategory }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.client.id });
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} {...attributes} {...listeners} className={clsx("outline-none", isDragging && "opacity-40")}>
      <Card row={row} rottingDays={rottingDays} category={category} />
    </li>
  );
}

/** Name, who it's with, what they're worth, owner, and the next step. Flags clients with nothing planned or that have sat too long. */
function Card({ row, dragging, rottingDays, category }: { row: ClientRow; dragging?: boolean; rottingDays?: number | null; category: ClientCategory }) {
  const { money, member } = useApp();
  const d = row.client;
  const owner = member(d.ownerId);
  const person = [row.personFirstName, row.personLastName].filter(Boolean).join(" ") || null;
  const who = row.organizationName && row.organizationName !== d.name ? row.organizationName : person;
  const days = daysSince(d.stageChangedAt);
  const rotting = rottingDays != null && days >= rottingDays;
  const amount = category === "prospective" ? d.value : Number(category === "current" ? row.mrr : row.formerMrr);
  return (
    <article
      className={clsx(
        "group relative rounded-xl border bg-surface px-3 py-2.5 transition-[transform,box-shadow] duration-200",
        dragging ? "rotate-[1.5deg] border-line-strong shadow-[var(--shadow-card-drag)]" : "border-line shadow-sm hover:-translate-y-0.5 hover:shadow-md",
        rotting && !dragging && "border-warning-border",
      )}
    >
      <Link href={`/clients/${d.id}`} className="block text-[13.5px] leading-snug font-medium text-primary hover:underline" draggable={false} onClick={(e) => dragging && e.preventDefault()}>
        {d.name}
      </Link>
      {who ? <p className="mt-0.5 truncate text-[12.5px] text-muted">{who}</p> : null}
      {category === "past" && d.churnReason ? <p className="mt-0.5 truncate text-[12px] text-muted">Left: {d.churnReason}</p> : null}
      <div className="mt-2 flex items-center gap-2">
        {amount ? (
          <span className="text-[13px] font-medium text-secondary tabular-nums">
            {money(amount)}
            {category === "prospective" ? "" : <span className="font-normal text-muted">/mo</span>}
          </span>
        ) : null}
        {category === "current" ? <HealthBadge health={d.health} /> : null}
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
        <NextActivityCell next={row.next} warnIfNone={category !== "past"} />
      </div>
    </article>
  );
}
