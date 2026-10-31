import "server-only";
import { MAX_FILE_BYTES } from "./constants";

/** Vercel Blob in production; files on local disk in development (no token needed). */
export const blobConfigured = () => !!process.env.BLOB_READ_WRITE_TOKEN;

export const LOCAL_UPLOAD_DIR = ".data/uploads";

/**
 * Types that could run script if opened from our own origin (HTML, SVG, XML)
 * or that are executables. Everything else is fine to store; downloads are
 * served as attachments with a sandboxing CSP anyway.
 */
const blockedExtensions = /\.(html?|xhtml|svg|xml|js|mjs|exe|msi|bat|cmd|com|scr|ps1|sh|jar|app|dmg|apk)$/i;
const blockedTypes = /^(text\/html|application\/xhtml|image\/svg|application\/(x-)?javascript|text\/javascript|application\/xml|text\/xml)/i;

export function fileProblem(name: string, size: number, type: string) {
  if (size > MAX_FILE_BYTES) return `${name} is over ${MAX_FILE_BYTES / 1024 / 1024} MB.`;
  if (size === 0) return `${name} is empty.`;
  if (blockedExtensions.test(name) || blockedTypes.test(type)) return `${name} can't be uploaded: web pages, scripts and programs aren't allowed.`;
  return null;
}

/** File names as stored: no path parts, no control characters, sensible length. */
export function cleanFileName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? "file";
  return base.replace(/[\u0000-\u001f\u007f"<>|*?:]/g, "").trim().slice(0, 180) || "file";
}

/** Shown inline in the browser; everything else downloads. */
export const inlineTypes = /^(image\/(png|jpe?g|gif|webp|avif)|application\/pdf|text\/plain)$/i;
