/**
 * The text of a Word document (.docx), read without a library. Pure: runs in
 * the browser (where the agent's attachments are read) and in tests.
 *
 * A .docx is a zip whose `word/document.xml` holds the body. Only that one
 * entry is opened, and its size is capped while it inflates, so a file built
 * to expand without end stops early. Nothing in the file is run: macros,
 * embedded objects and images are never touched.
 */

const MAX_XML_BYTES = 30 * 1024 * 1024;
const BODY = "word/document.xml";

export class DocxError extends Error {}

const u16 = (v: DataView, at: number) => v.getUint16(at, true);
const u32 = (v: DataView, at: number) => v.getUint32(at, true);

/** Where one zip entry's bytes are, from the central directory at the end of the file. */
function findEntry(bytes: Uint8Array, name: string) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--) {
    if (u32(v, i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new DocxError("not a zip");
  const count = u16(v, end + 10);
  let at = u32(v, end + 16);
  const decoder = new TextDecoder();
  for (let n = 0; n < count && at + 46 <= bytes.length; n++) {
    if (u32(v, at) !== 0x02014b50) break;
    const method = u16(v, at + 10);
    const compressed = u32(v, at + 20);
    const nameLength = u16(v, at + 28);
    const entryName = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (entryName === name) {
      const local = u32(v, at + 42);
      if (local + 30 > bytes.length || u32(v, local) !== 0x04034b50) throw new DocxError("bad entry");
      const start = local + 30 + u16(v, local + 26) + u16(v, local + 28);
      if (start + compressed > bytes.length) throw new DocxError("bad entry");
      return { method, data: bytes.subarray(start, start + compressed) };
    }
    at += 46 + nameLength + u16(v, at + 30) + u16(v, at + 32);
  }
  return null;
}

async function inflate(data: Uint8Array, max: number) {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new DocxError("too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] !== "#") return entities[e.toLowerCase()] ?? all;
    const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });

/** The body's text: a line per paragraph, a tab between table cells, a line per table row. */
export function documentXmlToText(xml: string) {
  const token = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>|<\/w:(p|tc|tr)>/g;
  let out = "";
  for (let m = token.exec(xml); m; m = token.exec(xml)) {
    if (m[1] !== undefined) out += decodeEntities(m[1]);
    else if (m[2] === "tab") out += "\t";
    else if (m[2]) out += "\n";
    else if (m[3] === "p") out += "\n";
    // A cell's last paragraph ends the cell, not the line.
    else if (m[3] === "tc") out = `${out.replace(/\n+$/, "")}\t`;
    else out = `${out.replace(/\t+$/, "")}\n`;
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The text of a .docx file. Throws DocxError when it isn't one. */
export async function docxText(file: ArrayBuffer | Uint8Array) {
  const bytes = file instanceof Uint8Array ? file : new Uint8Array(file);
  const entry = findEntry(bytes, BODY);
  if (!entry) throw new DocxError("no document body");
  const xml = entry.method === 0 ? entry.data : entry.method === 8 ? await inflate(entry.data, MAX_XML_BYTES) : null;
  if (!xml || xml.length > MAX_XML_BYTES) throw new DocxError("unsupported");
  return documentXmlToText(new TextDecoder().decode(xml));
}
