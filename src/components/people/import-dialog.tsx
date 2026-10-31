"use client";

import clsx from "clsx";
import { useMemo, useRef, useState } from "react";
import { ArrowUpTrayIcon, CheckCircleIcon, ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import { finishImport, importChunk, startImport, undoPeopleImport } from "@/actions/import";
import { useApp } from "@/components/app-context";
import { OwnerSelect } from "@/components/records/owner-select";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Select } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { guessField, importFields, parseOptIn, splitTags, type ImportFieldKey, type ImportRow } from "@/lib/crm/import-fields";

type Table = { name: string; headings: string[]; rows: string[][] };
type Step = "upload" | "map" | "importing" | "done";
type Summary = { id: string; created: number; updated: number; unchanged: number; organizations: number; skipped: { row: number; reason: string }[]; error?: string };

const MAX_ROWS = 10_000;

/**
 * Spreadsheet import: pick a CSV or Excel file, check how its columns match
 * up, then import in batches with a progress bar. People match by email, so
 * importing the same file twice updates rather than duplicates. Undoable.
 */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const { viewer } = useApp();
  const [step, setStep] = useState<Step>("upload");
  const [fileName, setFileName] = useState("");
  const [tables, setTables] = useState<Table[]>([]);
  const [sheet, setSheet] = useState(0);
  const [mapping, setMapping] = useState<(ImportFieldKey | null)[]>([]);
  const [tag, setTag] = useState("");
  const [ownerId, setOwnerId] = useState<string | null>(viewer.id);
  const [optIn, setOptIn] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [summary, setSummary] = useState<Summary | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const table = tables[sheet];

  const pickSheet = (i: number, list = tables) => {
    setSheet(i);
    const seen = new Set<ImportFieldKey>();
    setMapping(
      list[i].headings.map((h) => {
        const f = guessField(h);
        if (!f || seen.has(f)) return null;
        seen.add(f);
        return f;
      }),
    );
  };

  const load = async (file: File) => {
    setError(null);
    try {
      const found = (await readSpreadsheet(file)).filter((t) => t.rows.length);
      if (!found.length) throw new Error("We couldn't find any rows in that file. Make sure the first row has column headings.");
      if (found.some((t) => t.rows.length > MAX_ROWS)) throw new Error(`That's more than ${MAX_ROWS.toLocaleString()} rows. Split it into smaller files.`);
      setFileName(file.name);
      setTables(found);
      pickSheet(0, found);
      setStep("map");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const rows = useMemo(() => (table ? buildRows(table, mapping, tag) : []), [table, mapping, tag]);
  const hasIdentity = mapping.some((m) => m === "name" || m === "firstName" || m === "email");

  const run = async () => {
    setStep("importing");
    setProgress({ done: 0, total: rows.length });
    const total: Summary = { id: "", created: 0, updated: 0, unchanged: 0, organizations: 0, skipped: [] };
    const started = await startImport(fileName);
    if (!started.ok) {
      setSummary({ ...total, error: started.error });
      return setStep("done");
    }
    total.id = started.data.id;
    let done = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const r = await importChunk(total.id, chunk, { ownerId, marketingOptIn: optIn });
      if (!r.ok) {
        total.error = `${r.error} The rows before row ${chunk[0].row} were imported.`;
        break;
      }
      total.created += r.data.created;
      total.updated += r.data.updated;
      total.unchanged += r.data.unchanged;
      total.organizations += r.data.organizations;
      total.skipped.push(...r.data.skipped);
      done += chunk.length;
      setProgress({ done, total: rows.length });
    }
    await finishImport();
    setSummary(total);
    setStep("done");
  };

  const undo = async () => {
    if (!summary?.id) return;
    const r = await undoPeopleImport(summary.id);
    if (!r.ok) return void toast.error(r.error);
    toast.success(`Import undone: removed ${r.data.removed} people and restored ${r.data.restored}`);
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && step !== "importing" && onClose()}
      title="Import people"
      description={step === "upload" ? "From a CSV or Excel file. The first row should be column headings." : fileName}
      size="xl"
      footer={
        step === "map" ? (
          <>
            <Button variant="ghost" onClick={() => setStep("upload")} className="mr-auto">
              Choose another file
            </Button>
            <Button variant="primary" disabled={!hasIdentity || !rows.length} onClick={run}>
              Import {rows.length.toLocaleString()} {rows.length === 1 ? "row" : "rows"}
            </Button>
          </>
        ) : step === "done" ? (
          <>
            {summary?.id ? (
              <Button variant="ghost" onClick={undo} className="mr-auto">
                Undo import
              </Button>
            ) : null}
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        ) : undefined
      }
    >
      {step === "upload" ? (
        <div>
          {error ? (
            <p role="alert" className="mb-3 rounded-md border border-error-border bg-error-surface px-3 py-2 text-[13px] text-error">
              {error}
            </p>
          ) : null}
          <input ref={input} type="file" accept=".csv,.tsv,.txt,.xlsx,.xlsm" hidden onChange={(e) => e.target.files?.[0] && load(e.target.files[0])} />
          <button
            type="button"
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              if (e.dataTransfer.files[0]) load(e.dataTransfer.files[0]);
            }}
            className={clsx("flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed py-12 transition-colors", over ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong")}
          >
            <ArrowUpTrayIcon className="size-6 text-muted" />
            <span className="text-[14px] font-medium text-primary">Drop a spreadsheet here, or click to choose one</span>
            <span className="text-[12.5px] text-muted">CSV or Excel (.xlsx), up to {MAX_ROWS.toLocaleString()} rows</span>
          </button>
          <p className="mt-3 text-fine">People are matched by email: anyone already here gets new details added, never erased. Organizations are matched by name and created if they&apos;re new.</p>
        </div>
      ) : null}

      {step === "map" && table ? (
        <div className="flex flex-col gap-5">
          {tables.length > 1 ? (
            <Field label="Sheet">
              {(p) => (
                <Select id={p.id} value={sheet} onChange={(e) => pickSheet(Number(e.target.value))} className="w-60">
                  {tables.map((t, i) => (
                    <option key={t.name} value={i}>
                      {t.name} ({t.rows.length} rows)
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
          <div>
            <p className="mb-2 text-label">Match columns</p>
            {!hasIdentity ? <p className="mb-2 text-[12.5px] text-warning">Match at least a name or an email column.</p> : null}
            <div className="table-container">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-line bg-sunken/50">
                    <th className="px-3 py-2 text-left text-table-header">Column in your file</th>
                    <th className="px-3 py-2 text-left text-table-header">Example</th>
                    <th className="px-3 py-2 text-left text-table-header">Imports as</th>
                  </tr>
                </thead>
                <tbody>
                  {table.headings.map((h, i) => (
                    <tr key={i} className="border-b border-line last:border-0">
                      <td className="px-3 py-1.5 font-medium text-primary">{h}</td>
                      <td className="max-w-56 truncate px-3 py-1.5 text-muted">{table.rows.find((r) => r[i])?.[i] ?? "—"}</td>
                      <td className="px-3 py-1.5">
                        <Select
                          value={mapping[i] ?? ""}
                          onChange={(e) => setMapping((m) => m.map((x, j) => (j === i ? ((e.target.value || null) as ImportFieldKey | null) : x === e.target.value ? null : x)))}
                          aria-label={`Field for ${h}`}
                          className="w-44 [&_select]:h-8 [&_select]:text-[13px]"
                        >
                          <option value="">Don&apos;t import</option>
                          {importFields.map((f) => (
                            <option key={f.key} value={f.key}>
                              {f.label}
                            </option>
                          ))}
                        </Select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Owner of new people">{(p) => <OwnerSelect id={p.id} value={ownerId} onChange={setOwnerId} />}</Field>
            <Field label="Tag everyone" optional hint="e.g. trade-show-2026">
              {(p) => <Input {...p} value={tag} onChange={(e) => setTag(e.target.value)} />}
            </Field>
            <div className="flex items-end pb-2">
              <Checkbox checked={optIn} onChange={(e) => setOptIn(e.target.checked)} label="New people get campaigns" />
            </div>
          </div>
        </div>
      ) : null}

      {step === "importing" ? (
        <div className="py-10 text-center" role="status">
          <p className="text-[14px] font-medium text-primary">
            Importing {progress.done.toLocaleString()} of {progress.total.toLocaleString()}…
          </p>
          <div className="mx-auto mt-3 h-2 max-w-sm overflow-hidden rounded-full bg-sunken">
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${(progress.done / Math.max(progress.total, 1)) * 100}%` }} />
          </div>
          <p className="mt-3 text-fine">Keep this window open until it finishes.</p>
        </div>
      ) : null}

      {step === "done" && summary ? (
        <div className="flex flex-col gap-3">
          {summary.error ? (
            <p className="flex items-start gap-2 rounded-md border border-error-border bg-error-surface px-3 py-2 text-[13px] text-error">
              <ExclamationTriangleIcon className="mt-0.5 size-4 shrink-0" />
              {summary.error}
            </p>
          ) : (
            <p className="flex items-center gap-2 text-[14px] font-medium text-primary">
              <CheckCircleIcon className="size-5 text-success" />
              Import finished
            </p>
          )}
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ["Added", summary.created],
              ["Updated", summary.updated],
              ["Already up to date", summary.unchanged],
              ["New organizations", summary.organizations],
            ].map(([label, n]) => (
              <div key={label} className="rounded-lg border border-line px-3 py-2">
                <dt className="text-[12px] text-muted">{label}</dt>
                <dd className="text-[18px] font-semibold text-primary tabular-nums">{Number(n).toLocaleString()}</dd>
              </div>
            ))}
          </dl>
          {summary.skipped.length ? (
            <details className="rounded-lg border border-line px-3 py-2 text-[13px]">
              <summary className="cursor-pointer font-medium text-warning">{summary.skipped.length} rows skipped</summary>
              <ul className="mt-2 max-h-40 overflow-auto text-muted">
                {summary.skipped.slice(0, 200).map((s) => (
                  <li key={s.row}>
                    Row {s.row}: {s.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}

async function readSpreadsheet(file: File): Promise<Table[]> {
  const ext = file.name.split(".").pop()?.toLowerCase();
  let sheets: { name: string; cells: string[][] }[];
  if (ext === "xls") throw new Error("That's an older Excel file (.xls). In Excel, choose File › Save As › Excel Workbook (.xlsx), then import that.");
  if (ext === "xlsx" || ext === "xlsm") {
    const { default: readXlsxFile } = await import("read-excel-file/browser");
    const workbook = await readXlsxFile(file).catch(() => {
      throw new Error("We couldn't open that Excel file. Try saving it again as .xlsx, or export it as CSV.");
    });
    sheets = workbook.map((s) => ({ name: s.sheet, cells: s.data.map((r) => r.map((c) => (c instanceof Date ? c.toISOString().slice(0, 10) : c == null ? "" : String(c)))) }));
  } else if (ext === "csv" || ext === "tsv" || ext === "txt" || file.type.startsWith("text/")) {
    const { default: Papa } = await import("papaparse");
    const { data } = Papa.parse<string[]>((await file.text()).replace(/^﻿/, ""), { skipEmptyLines: "greedy" });
    sheets = [{ name: file.name, cells: data }];
  } else {
    throw new Error("Choose a CSV or Excel (.xlsx) file.");
  }
  return sheets.map(({ name, cells }) => {
    const filled = cells.map((r) => r.map((c) => (c ?? "").toString().trim())).filter((r) => r.some(Boolean));
    const [head = [], ...rows] = filled;
    const width = Math.max(head.length, ...rows.map((r) => r.length));
    return { name, headings: Array.from({ length: width }, (_, i) => head[i] || `Column ${i + 1}`), rows };
  });
}

function buildRows(table: Table, mapping: (ImportFieldKey | null)[], tag: string): ImportRow[] {
  const extraTags = splitTags(tag);
  return table.rows.map((cells, n) => {
    const r: ImportRow = { row: n + 2 };
    let full = "";
    const notes: string[] = [];
    const tags = new Set(extraTags);
    mapping.forEach((field, i) => {
      const v = cells[i]?.trim();
      if (!field || !v) return;
      if (field === "name") full = v;
      else if (field === "notes") notes.push(v);
      else if (field === "tags") splitTags(v).forEach((t) => tags.add(t));
      else if (field === "marketingOptIn") r.marketingOptIn = parseOptIn(v);
      else r[field] = v;
    });
    // "Mary Ann Smith" in a single name column: everything before the last space is the first name.
    if (full && !r.firstName) {
      const at = full.lastIndexOf(" ");
      r.firstName = at > 0 ? full.slice(0, at) : full;
      if (at > 0 && !r.lastName) r.lastName = full.slice(at + 1);
    }
    if (notes.length) r.notes = notes.join("\n");
    if (tags.size) r.tags = [...tags].slice(0, 30);
    return r;
  });
}
