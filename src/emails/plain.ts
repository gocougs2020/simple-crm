import { escapeHtml } from "@/lib/email/merge-tags";

/** What new Outlook writes in: Aptos 12pt, black. Older Outlooks and other mail apps fall back to Calibri or Arial. */
export const outlookFont = "Aptos,Calibri,Arial,Helvetica,sans-serif";

/**
 * An email sent from a teammate's own Outlook mailbox: just the message and
 * their signature, the way Outlook itself would send it. No background, card,
 * logo or footer, so it reads as a person's email, not a template. The font is
 * set because Outlook on Windows shows HTML without one in Times New Roman.
 * `html` is already sanitized. The signature is the workspace's plain-text
 * one, or the teammate's own as HTML (already `sanitizeSignatureHtml`ed).
 */
export function plainEmailHtml(html: string, signature?: string | { html: string } | null) {
  const styles: Record<string, string> = {
    p: "margin:0 0 1em",
    ul: "margin:0 0 1em",
    ol: "margin:0 0 1em",
    blockquote: "margin:0 0 1em 0.8ex;border-left:1px solid #cccccc;padding-left:1ex",
  };
  const body = html
    .replace(/<(p|ul|ol|blockquote)(\s[^>]*)?>/gi, (m, tag: string, attrs = "") => `<${tag}${attrs} style="${styles[tag.toLowerCase()]}">`)
    // An empty line the teammate typed stays an empty line.
    .replace(/(<p[^>]*>)\s*<\/p>/gi, "$1&nbsp;</p>");
  return `<html><head><meta charset="utf-8"></head><body><div style="font-family:${outlookFont};font-size:12pt;color:#000000">${body}${signatureBlock(signature)}</div></body></html>`;
}

/** The signature under the message. A rich one keeps its lines tight, like a signature made in Outlook. */
function signatureBlock(signature: string | { html: string } | null | undefined) {
  if (!signature) return "";
  if (typeof signature !== "string") {
    if (!signature.html.trim()) return "";
    const sig = signature.html
      .replace(/<p>\s*<\/p>/gi, "<p>&nbsp;</p>")
      .replace(/<p>/gi, `<p style="margin:0">`)
      .replace(/<(ul|ol)>/gi, `<$1 style="margin:0">`)
      .replace(/<hr>/gi, `<hr style="border:none;border-top:1px solid #cccccc;margin:8px 0">`)
      // Outlook sizes images by their width attribute; the style keeps other mail apps from stretching them.
      .replace(/<img ([^>]*)>/gi, `<img $1 style="border:0;max-width:100%;height:auto">`);
    return `<div>${sig}</div>`;
  }
  return signature.trim()
    ? `<div>${signature
        .trim()
        .split("\n")
        .map((line) => escapeHtml(line) || "&nbsp;")
        .join("<br>")}</div>`
    : "";
}
