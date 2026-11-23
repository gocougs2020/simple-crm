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

const SIGNATURE_ALLOWED = new Set(["p", "br", "strong", "em", "u", "s", "a", "ul", "ol", "li", "hr", "span", "img"]);
const SIGNATURE_VOID = new Set(["br", "hr", "img"]);

/** Only a color and a font size survive on a span: `color:#1f2937` or `rgb(…)`, `font-size:14px`. */
function signatureStyle(attrs: string) {
  const raw = /\bstyle\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
  if (!raw) return "";
  const kept: string[] = [];
  for (const rule of decodeEntities(raw[2] ?? raw[3] ?? "").split(";")) {
    const [prop, ...rest] = rule.split(":");
    const name = prop?.trim().toLowerCase();
    const value = rest.join(":").trim().toLowerCase();
    if (name === "color" && /^(#[0-9a-f]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/.test(value)) kept.push(`color:${value.replace(/\s+/g, "")}`);
    if (name === "font-size" && /^\d{1,2}px$/.test(value) && Number.parseInt(value) >= 8) kept.push(`font-size:${value}`);
  }
  return kept.join(";");
}

/** An image's address: http(s) only, never data: or javascript:, so it loads in every inbox and carries nothing. */
function imageSrc(attrs: string) {
  const raw = /\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  const src = raw ? decodeEntities(raw[2] ?? raw[3] ?? raw[4] ?? "").trim() : "";
  return /^https?:\/\/[^\s"'<>]+$/i.test(src) ? src : null;
}

const attr = (attrs: string, name: string) => {
  const raw = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
  return raw ? decodeEntities(raw[2] ?? raw[3] ?? raw[4] ?? "") : null;
};

/**
 * Allow-list sanitizer for a teammate's email signature. Like `sanitizeHtml`,
 * everything is rebuilt from scratch, with a little more allowed because a
 * signature is about how it looks: images (http(s) only, with a size and
 * alt text), and a color and font size on text. No other attribute or style
 * survives.
 */
export function sanitizeSignatureHtml(input: string | null | undefined): string {
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
    const lower = m[2].toLowerCase();
    const name = lower === "b" ? "strong" : lower === "i" ? "em" : lower === "div" ? "p" : lower;
    if (!SIGNATURE_ALLOWED.has(name)) continue;
    if (closing) {
      const at = open.lastIndexOf(name);
      if (at < 0) continue;
      while (open.length > at) out.push(`</${open.pop()}>`);
      continue;
    }
    if (name === "img") {
      const src = imageSrc(m[3]);
      if (!src) continue;
      const size = (n: string) => {
        const v = Number.parseInt(attr(m[3], n) ?? "", 10);
        return v > 0 && v <= 1200 ? ` ${n}="${v}"` : "";
      };
      const alt = attr(m[3], "alt");
      out.push(`<img src="${escapeAttr(src)}" alt="${escapeAttr(alt ?? "")}"${size("width")}${size("height")}>`);
      continue;
    }
    if (SIGNATURE_VOID.has(name)) {
      out.push(`<${name}>`);
      continue;
    }
    if (name === "a") {
      const href = safeHref(attr(m[3], "href") ?? "");
      out.push(href && !href.startsWith("/") ? `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">` : "<a>");
    } else if (name === "span") {
      const style = signatureStyle(m[3]);
      out.push(style ? `<span style="${escapeAttr(style)}">` : "<span>");
    } else {
      out.push(`<${name}>`);
    }
    open.push(name);
  }
  out.push(escapeText(html.slice(last)));
  while (open.length) out.push(`</${open.pop()}>`);
  return out.join("").trim();
}

/** Whether a signature has anything in it: words or an image. */
export const signatureHasContent = (html: string | null | undefined) => !!html && (!!htmlToText(html) || /<img\s/i.test(html));

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
