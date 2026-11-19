/** Request bodies the API and MCP accept: 1 MB. */
export const MAX_BODY_BYTES = 1024 * 1024;
/** Uploading a file (base64 in JSON) may send more, up to what a Vercel function accepts. */
export const MAX_UPLOAD_BODY_BYTES = 4.5 * 1024 * 1024;
/** The file itself, before base64 (which adds a third). */
export const MAX_API_FILE_BYTES = 3 * 1024 * 1024;

/**
 * Reads a request (or response) body as text, counting bytes as they stream in and giving
 * up as soon as there are too many, so a large or endless body (or a lying
 * Content-Length) never gets buffered whole.
 */
export async function readBodyLimited(request: { headers: Headers; body: ReadableStream<Uint8Array> | null }, max = MAX_BODY_BYTES): Promise<{ ok: true; text: string } | { ok: false }> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > max) return { ok: false };
  if (!request.body) return { ok: true, text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return { ok: false };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}
