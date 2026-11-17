"use client";

import clsx from "clsx";
import { useState, useTransition } from "react";
import { mergeRecords } from "@/actions/records";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";

/** One of the records picked for a merge, as the dialog shows it. */
export type MergeCandidate = {
  id: string;
  title: string;
  /** Under the title: an email, a website. */
  subtitle?: string | null;
  createdAt: Date;
  lastActivityAt: Date | null;
  /** The fields compared, in order. A blank value is one the kept record can get from the others. */
  fields: { label: string; value: string | null | undefined }[];
  /** What's on it besides fields: "12 people", "3 clients". */
  extras?: string[];
};

const blank = (v: string | null | undefined) => !v?.trim();
const filled = (c: MergeCandidate) => c.fields.filter((f) => !blank(f.value)).length;
/** The order the others fill the kept record's blanks in, the same as the server's: most recently active first, then newest. */
const donorOrder = (a: MergeCandidate, b: MergeCandidate) => (b.lastActivityAt?.getTime() ?? 0) - (a.lastActivityAt?.getTime() ?? 0) || b.createdAt.getTime() - a.createdAt.getTime();

/**
 * Pick which of the selected records is kept. It keeps its own values; its
 * blanks come from the others; everything on the others moves to it and they
 * are deleted. The preview shows the result before anything changes.
 */
export function MergeDialog({ entity, candidates, onClose, onMerged }: { entity: "person" | "organization"; candidates: MergeCandidate[]; onClose: () => void; onMerged: () => void }) {
  const noun = entity === "person" ? { one: "person", many: "people" } : { one: "organization", many: "organizations" };
  // Start with the most complete record, the oldest of those tied.
  const [keepId, setKeepId] = useState(() => [...candidates].sort((a, b) => filled(b) - filled(a) || a.createdAt.getTime() - b.createdAt.getTime())[0]?.id);
  const [pending, start] = useTransition();
  const keep = candidates.find((c) => c.id === keepId) ?? candidates[0];
  const donors = candidates.filter((c) => c.id !== keep.id).sort(donorOrder);
  const others = candidates.length - 1;

  const merge = () =>
    start(async () => {
      const r = await mergeRecords(
        entity,
        keep.id,
        donors.map((d) => d.id),
      );
      if (!r.ok) return void toast.error(r.error);
      const clients = r.data.clientsMerged ? `, and combined ${r.data.clientsMerged === 1 ? "a duplicate client" : `${r.data.clientsMerged} duplicate clients`}` : "";
      toast.success(`Merged ${r.data.merged === 1 ? `1 ${noun.one}` : `${r.data.merged} ${noun.many}`} into ${keep.title}${clients}`);
      onMerged();
    });

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !pending && onClose()}
      size="xl"
      title={`Merge ${candidates.length} ${noun.many}`}
      description={`Pick the ${noun.one} to keep. It keeps its own details, and anything it's missing is filled in from the others.`}
      footer={
        <>
          <p className="mr-auto text-[12.5px] text-muted">
            {others === 1 ? `The other ${noun.one} is` : `The other ${others} ${noun.many} are`} deleted once everything on {others === 1 ? "it" : "them"} has moved. This can&apos;t be undone.
          </p>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={merge} disabled={pending}>
            {pending ? "Merging…" : `Merge into ${keep.title}`}
          </Button>
        </>
      }
    >
      <fieldset>
        <legend className="mb-2 text-[12px] font-medium tracking-wide text-muted uppercase">Keep</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {candidates.map((c) => {
            const on = c.id === keep.id;
            return (
              <label key={c.id} className={clsx("flex cursor-pointer gap-3 rounded-lg border p-3 text-[13px]", on ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong")}>
                <input type="radio" name="keep" className="mt-0.5 size-4 accent-[var(--accent)]" checked={on} onChange={() => setKeepId(c.id)} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-medium text-primary">{c.title}</span>
                    {on ? <span className="shrink-0 text-[11.5px] font-medium text-accent-soft-foreground">Kept</span> : <span className="shrink-0 text-[11.5px] text-muted">Merged in</span>}
                  </span>
                  {c.subtitle ? <span className="block truncate text-muted">{c.subtitle}</span> : null}
                  <span className="mt-1 block text-[12px] text-faint">
                    Added {c.createdAt.toLocaleDateString()}
                    {c.extras?.length ? ` · ${c.extras.join(" · ")}` : ""}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <h3 className="mt-5 mb-2 text-[12px] font-medium tracking-wide text-muted uppercase">After the merge</h3>
      <div className="overflow-hidden rounded-lg border border-line">
        <table className="w-full text-left text-[13px]">
          <tbody>
            {keep.fields.map((f, i) => {
              const own = !blank(f.value);
              const from = own ? null : donors.find((d) => !blank(d.fields[i]?.value));
              const value = own ? f.value : from?.fields[i]?.value;
              return (
                <tr key={f.label} className="border-t border-line first:border-t-0">
                  <th scope="row" className="w-40 px-3 py-2 align-top font-normal text-muted">
                    {f.label}
                  </th>
                  <td className="px-3 py-2 break-words text-primary">{value?.trim() ? value : <span className="text-faint">—</span>}</td>
                  <td className="w-44 px-3 py-2 text-right align-top text-[12px] text-muted">{from ? `from ${from.title}` : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[12.5px] text-muted">
        {entity === "organization"
          ? "Their people, clients, notes, tasks, meetings, emails, calls, texts, files and history move to the organization you keep. If that leaves it with more than one client, those clients are combined into the one furthest along."
          : "Their notes, tasks, meetings, emails, calls, texts, files, clients and history move to the person you keep, along with every email address, phone number and organization they had. If anyone opted out of email or texts, the merged person has too."}
      </p>
    </Dialog>
  );
}
