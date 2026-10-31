/**
 * Allow-list sanitizer for rich text written in the CRM (notes, call
 * summaries, email bodies). Everything is rebuilt from scratch: only the tags
 * below survive, only `href` survives as an attribute, and only http(s),
 * mailto and tel links are kept. Text is re-escaped, so nothing the browser
 * would treat as markup gets through.
 */
const ALLOWED = new Set(["p", "br", "strong", "b", "em", "i", "u", "s", "a", "ul", "ol", "li", "blockquote", "h2", "h3", "code", "pre", "hr", "span"]);
const VOID = new Set(["br", "hr"]);
/** Content of these is dropped entirely, not just the tags. */
const DROP_CONTENT = /<(script|style|iframe|object|embed|template|noscript|svg|math)\b[\s\S]*?<\/\1\s*>/gi;

const escapeText = (s: string) => s.replace(/&(?!(?:[a-z]+|#\d+|#x[0-9a-f]+);)/gi, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function decodeEntities(s: string) {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&colon;/gi, ":")
    .replace(/&tab;/gi, "\t")
    .replace(/&newline;/gi, "\n")
    .replace(/&amp;/gi, "&");
}

export function safeHref(raw: string) {
  // Browsers ignore control characters and whitespace inside the scheme, so strip them before checking it.
  const href = decodeEntities(raw).replace(/[\u0000- \u007f-\u009f]/g, "");
  if (/^(https?:|mailto:|tel:)/i.test(href)) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  // Scheme-less "example.com" becomes an https link; relative paths stay on this site.
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  return /^[\w-]+(\.[\w-]+)+/.test(href) ? `https://${href}` : null;
}

export function sanitizeHtml(input: string | null | undefined): string {
  if (!input) return "";
  const html = input.replace(/<!--[\s\S]*?-->/g, "").replace(DROP_CONTENT, "");
  const out: string[] = [];
  const open: string[] = [];
  const tag = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g;
  let last = 0;
  for (const m of html.matchAll(tag)) {
    out.push(escapeText(html.slice(last, m.index)));
    last = m.index + m[0].length;
    const closing = !!m[1];
    const name = m[2].toLowerCase() === "b" ? "strong" : m[2].toLowerCase() === "i" ? "em" : m[2].toLowerCase();
    if (!ALLOWED.has(name)) continue;
    if (closing) {
      const at = open.lastIndexOf(name);
      if (at < 0) continue;
      // Close anything left open inside it, so the output is always well nested.
      while (open.length > at) out.push(`</${open.pop()}>`);
      continue;
    }
    if (VOID.has(name)) {
      out.push(`<${name}>`);
      continue;
    }
    if (name === "a") {
      const raw = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[3]);
      const href = raw ? safeHref(raw[2] ?? raw[3] ?? raw[4] ?? "") : null;
      out.push(href ? `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer nofollow">` : "<a>");
    } else if (name === "span") {
      // Merge tag chips from the editor keep their marker so they can be filled in at send time.
      const tagAttr = /\bdata-merge-tag\s*=\s*"([a-z_]+)"/i.exec(m[3]);
      out.push(tagAttr ? `<span data-merge-tag="${tagAttr[1]}">` : "<span>");
    } else {
      out.push(`<${name}>`);
    }
    open.push(name);
  }
  out.push(escapeText(html.slice(last)));
  while (open.length) out.push(`</${open.pop()}>`);
  return out.join("").trim();
}

/** Plain text from rich text HTML, for previews, search and validation. */
export function htmlToText(html: string | null | undefined) {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h2|h3|li|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Turns plain text (a pasted text message, say) into paragraphs. */
export function textToHtml(text: string) {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeText(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}
