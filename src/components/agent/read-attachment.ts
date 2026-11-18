import { attachmentKind, attachmentRefusal, extensionOf, fitText, type Attachment } from "@/lib/agent/attachments";

/**
 * Reads a file the teammate attached to a chat message, in the browser, into
 * the text the agent gets. The file itself is never uploaded.
 */

/** A file's text isn't text: binary data saved with a .csv or .txt name. */
const looksBinary = (text: string) => text.slice(0, 4000).includes("\u0000");

async function readTable(file: File) {
  const { default: readXlsxFile } = await import("read-excel-file/browser");
  const { default: Papa } = await import("papaparse");
  const workbook = await readXlsxFile(file).catch(() => {
    throw new Error(`${file.name} couldn't be opened. Save it again as .xlsx, or export it as CSV.`);
  });
  const sheets = workbook
    .map((s) => ({ name: s.sheet, cells: s.data.map((r) => r.map((c) => (c instanceof Date ? c.toISOString().slice(0, 10) : c == null ? "" : String(c).trim()))).filter((r) => r.some(Boolean)) }))
    .filter((s) => s.cells.length);
  if (!sheets.length) throw new Error(`${file.name} has no data in it.`);
  const rows = sheets.reduce((n, s) => n + Math.max(0, s.cells.length - 1), 0);
  const text = sheets.map((s) => (sheets.length > 1 ? `# Sheet: ${s.name}\n` : "") + Papa.unparse(s.cells)).join("\n\n");
  return { text, rows };
}

export async function readAttachment(file: File): Promise<Attachment> {
  const refusal = attachmentRefusal(file);
  if (refusal) throw new Error(refusal);
  const kind = attachmentKind(file.name)!;
  const ext = extensionOf(file.name);
  let raw: string;
  let rows: number | undefined;
  if (ext === "xlsx") {
    ({ text: raw, rows } = await readTable(file));
  } else if (ext === "docx") {
    const { docxText } = await import("@/lib/agent/docx");
    raw = await docxText(await file.arrayBuffer()).catch(() => {
      throw new Error(`${file.name} couldn't be opened. Save it again as a Word Document (.docx).`);
    });
  } else {
    raw = await file.text();
    if (looksBinary(raw)) throw new Error(`${file.name} isn't a text file. Attach a CSV, Excel (.xlsx), Word (.docx) or text file.`);
    if (kind === "table") rows = Math.max(0, raw.split(/\r\n?|\n/).filter((l) => l.trim()).length - 1);
  }
  const { text, truncated } = fitText(raw);
  if (!text) throw new Error(`${file.name} has no text in it.`);
  return { name: file.name, kind, text, ...(rows === undefined ? {} : { rows }), ...(truncated ? { truncated: true } : {}) };
}
