import "server-only";
import type { DescribeKind } from "@/lib/file-describe-rules";

/** Files read for their text on the server: anything bigger isn't read. */
const MAX_READ_BYTES = 10 * 1024 * 1024;
/** What a workbook may inflate to before it's parsed, so a small file built to expand can't exhaust memory. */
const MAX_WORKBOOK_BYTES = 40 * 1024 * 1024;

/** A file's text isn't text: binary data saved under a .csv or .txt name. */
const looksBinary = (text: string) => text.slice(0, 4000).includes("\u0000");

/**
 * The text inside a text, Word or Excel file, read on the server. Nothing in
 * the file runs: a .docx is read for its body XML only, a workbook for its
 * cell values. Returns null for kinds read as a whole by the model (PDFs,
 * pictures) and for files that turn out not to be text.
 */
export async function fileText(bytes: Buffer, kind: DescribeKind): Promise<string | null> {
  if (bytes.length > MAX_READ_BYTES) return null;
  if (kind === "text") {
    const text = bytes.toString("utf8");
    return looksBinary(text) ? null : text;
  }
  if (kind === "docx") {
    const { docxText } = await import("@/lib/agent/docx");
    return docxText(new Uint8Array(bytes)).catch(() => null);
  }
  if (kind === "xlsx") {
    const { zipFitsUnder } = await import("@/lib/agent/docx");
    if (!(await zipFitsUnder(new Uint8Array(bytes), MAX_WORKBOOK_BYTES))) return null;
    const { default: readXlsxFile } = await import("read-excel-file/node");
    const { default: Papa } = await import("papaparse");
    const workbook = await readXlsxFile(bytes).catch(() => null);
    if (!workbook) return null;
    const sheets = workbook
      .map((s) => ({ name: s.sheet, cells: s.data.map((r) => r.map((c) => (c instanceof Date ? c.toISOString().slice(0, 10) : c == null ? "" : String(c).trim()))).filter((r) => r.some(Boolean)) }))
      .filter((s) => s.cells.length);
    return sheets.map((s) => (sheets.length > 1 ? `# Sheet: ${s.name}\n` : "") + Papa.unparse(s.cells)).join("\n\n") || null;
  }
  return null;
}
