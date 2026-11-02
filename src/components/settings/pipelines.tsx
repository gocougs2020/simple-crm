"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Bars2Icon, PlusIcon, TrashIcon } from "@heroicons/react/20/solid";
import { createPipeline, deletePipeline, deleteStage, renamePipeline, reorderStages, saveStage } from "@/actions/settings";
import { useApp } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { clientCategories, clientCategoryLabels } from "@/lib/constants";
import type { Stage } from "@/lib/crm/context";
import { Section } from "./nav";

/** Pipelines grouped by client category: each category moves through its own stages. */
export function PipelineSettings({ clientCounts }: { clientCounts: Record<string, number> }) {
  const { pipelines } = useApp();
  const [, start] = useTransition();
  return (
    <>
      {clientCategories.map((c) => (
        <div key={c} className="mb-10">
          <div className="mb-4 flex items-end justify-between gap-4 border-b border-line pb-2">
            <div>
              <h2 className="text-[15px] font-semibold text-primary">{clientCategoryLabels[c].one} clients</h2>
              <p className="mt-0.5 max-w-xl text-[13px] text-muted">{clientCategoryLabels[c].hint}</p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const name = prompt(`Name the new pipeline for ${clientCategoryLabels[c].one.toLowerCase()} clients`);
                if (name) start(async () => void toastResult(await createPipeline(name, c), `${name} pipeline added`));
              }}
            >
              <PlusIcon />
              Add pipeline
            </Button>
          </div>
          {pipelines
            .filter((p) => p.category === c)
            .map((p) => (
              <PipelineCard key={p.id} pipelineId={p.id} clientCounts={clientCounts} />
            ))}
        </div>
      ))}
    </>
  );
}

function toastResult(r: { ok: boolean; error?: string }, message: string) {
  if (r.ok) toast.success(message);
  else toast.error(r.error ?? "Something went wrong.");
}

function PipelineCard({ pipelineId, clientCounts }: { pipelineId: string; clientCounts: Record<string, number> }) {
  const { pipelines } = useApp();
  const pipeline = pipelines.find((p) => p.id === pipelineId)!;
  const prospects = pipeline.category === "prospective";
  const siblings = pipelines.filter((p) => p.category === pipeline.category);
  const grid = prospects ? "grid-cols-[28px_minmax(0,1fr)_96px_120px_64px_36px]" : "grid-cols-[28px_minmax(0,1fr)_120px_64px_36px]";
  const [order, setOrder] = useState(pipeline.stages.map((s) => s.id));
  // eslint-disable-next-line react-hooks/set-state-in-effect -- follow server order after saves
  useEffect(() => setOrder(pipeline.stages.map((s) => s.id)), [pipeline.stages]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const [adding, setAdding] = useState(false);
  const dndId = useId();
  const total = pipeline.stages.reduce((n, s) => n + (clientCounts[s.id] ?? 0), 0);

  const onEnd = async (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const next = arrayMove(order, order.indexOf(String(e.active.id)), order.indexOf(String(e.over.id)));
    setOrder(next);
    const r = await reorderStages(pipeline.id, next);
    if (!r.ok) toast.error(r.error);
  };

  return (
    <Section
      title={pipeline.name}
      description={`${pipeline.stages.length} stages · ${total} client${total === 1 ? "" : "s"}. Drag to reorder.${prospects ? " Probability drives the weighted value." : ""} Clients that sit longer than the "needs attention" days get flagged on the board.`}
      action={
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              const name = prompt("Rename pipeline", pipeline.name);
              if (name && name !== pipeline.name) toastResult(await renamePipeline(pipeline.id, name), "Pipeline renamed");
            }}
          >
            Rename
          </Button>
          {siblings.length > 1 ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                if (confirm(`Delete the ${pipeline.name} pipeline?`)) toastResult(await deletePipeline(pipeline.id), "Pipeline deleted");
              }}
            >
              Delete
            </Button>
          ) : null}
        </div>
      }
    >
      <div className={`grid ${grid} items-center gap-2 border-b border-line px-3 py-2 text-table-header`}>
        <span />
        <span>Stage</span>
        {prospects ? <span>Probability</span> : null}
        <span>Needs attention</span>
        <span className="text-right">Clients</span>
        <span />
      </div>
      <DndContext id={dndId} sensors={sensors} collisionDetection={closestCenter} onDragEnd={onEnd}>
        <SortableContext items={order} strategy={verticalListSortingStrategy}>
          <ul className="divide-y divide-line">
            {order.map((id) => {
              const s = pipeline.stages.find((x) => x.id === id);
              return s ? <StageRow key={id} stage={s} clients={clientCounts[id] ?? 0} others={pipeline.stages.filter((x) => x.id !== id)} grid={grid} probability={prospects} /> : null;
            })}
          </ul>
        </SortableContext>
      </DndContext>
      <div className="border-t border-line p-2">
        {adding ? (
          <NewStage pipelineId={pipeline.id} onDone={() => setAdding(false)} />
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
            <PlusIcon />
            Add stage
          </Button>
        )}
      </div>
    </Section>
  );
}

function StageRow({ stage, clients, others, grid, probability: showProbability }: { stage: Stage; clients: number; others: Stage[]; grid: string; probability: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: stage.id });
  const [name, setName] = useState(stage.name);
  const [probability, setProbability] = useState(String(stage.probability));
  const [rotting, setRotting] = useState(stage.rottingDays ? String(stage.rottingDays) : "");
  const [deleting, setDeleting] = useState(false);
  const save = async () => {
    const input = { name, probability: Math.min(100, Math.max(0, Number(probability) || 0)), rottingDays: rotting ? Number(rotting) : null };
    if (input.name === stage.name && input.probability === stage.probability && input.rottingDays === stage.rottingDays) return;
    const r = await saveStage(stage.pipelineId, stage.id, input);
    if (!r.ok) toast.error(r.error);
  };
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={isDragging ? "relative z-10 bg-surface shadow-md" : ""}>
      <div className={`grid ${grid} items-center gap-2 px-3 py-1.5`}>
        <button type="button" {...attributes} {...listeners} className="cursor-grab rounded p-1 text-faint hover:text-primary active:cursor-grabbing" aria-label={`Reorder ${stage.name}`}>
          <Bars2Icon className="size-4" />
        </button>
        <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={save} className="h-8 text-[13.5px]" aria-label="Stage name" />
        {showProbability ? (
          <div className="relative">
            <Input value={probability} onChange={(e) => setProbability(e.target.value.replace(/\D/g, ""))} onBlur={save} inputMode="numeric" className="h-8 pr-6 text-[13.5px]" aria-label="Probability" />
            <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[12px] text-muted">%</span>
          </div>
        ) : null}
        <div className="relative">
          <Input value={rotting} onChange={(e) => setRotting(e.target.value.replace(/\D/g, ""))} onBlur={save} inputMode="numeric" placeholder="Off" className="h-8 pr-11 text-[13.5px]" aria-label="Days before a client needs attention" />
          <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[12px] text-muted">days</span>
        </div>
        <span className="text-right text-[13px] text-muted tabular-nums">{clients}</span>
        <button type="button" onClick={() => setDeleting(true)} className="rounded p-1.5 text-faint hover:bg-sunken hover:text-error" aria-label={`Delete ${stage.name}`} disabled={!others.length}>
          <TrashIcon className="size-4" />
        </button>
      </div>
      {deleting ? <DeleteStage stage={stage} clients={clients} others={others} onClose={() => setDeleting(false)} /> : null}
    </li>
  );
}

function DeleteStage({ stage, clients, others, onClose }: { stage: Stage; clients: number; others: Stage[]; onClose: () => void }) {
  const [moveTo, setMoveTo] = useState(others[0]?.id ?? "");
  const [pending, start] = useTransition();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Delete ${stage.name}?`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" loading={pending} onClick={() => start(async () => (toastResult(await deleteStage(stage.id, moveTo), "Stage deleted"), onClose()))}>
            Delete stage
          </Button>
        </>
      }
    >
      {clients ? (
        <Field label={`Move its ${clients} client${clients === 1 ? "" : "s"} to`}>
          {(p) => (
            <Select id={p.id} value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : (
        <p className="text-[14px]">No clients are in this stage.</p>
      )}
    </Dialog>
  );
}

function NewStage({ pipelineId, onDone }: { pipelineId: string; onDone: () => void }) {
  const [name, setName] = useState("");
  const [pending, start] = useTransition();
  const save = () =>
    start(async () => {
      const r = await saveStage(pipelineId, null, { name, probability: 50, rottingDays: null });
      if (!r.ok) return void toast.error(r.error);
      setName("");
      onDone();
    });
  return (
    <div className="flex gap-2 px-1">
      <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => (e.key === "Enter" ? save() : e.key === "Escape" ? onDone() : null)} placeholder="Stage name" className="h-8 max-w-xs text-[13.5px]" />
      <Button size="sm" variant="primary" loading={pending} onClick={save}>
        Add
      </Button>
      <Button size="sm" variant="ghost" onClick={onDone}>
        Cancel
      </Button>
    </div>
  );
}
