import { escapeHtml } from "@/lib/email/merge-tags";

/** What new Outlook writes in: Aptos 12pt, black. Older Outlooks and other mail apps fall back to Calibri or Arial. */
export const outlookFont = "Aptos,Calibri,Arial,Helvetica,sans-serif";

/**
 * An email sent from a teammate's own Outlook mailbox: just the message and
 * their signature, the way Outlook itself would send it. No background, card,
 * logo or footer, so it reads as a person's email, not a template. The font is
 * set because Outlook on Windows shows HTML without one in Times New Roman.
 * `html` is already sanitized.
 */
export function plainEmailHtml(html: string, signature?: string | null) {
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
  const sig = signature?.trim()
    ? `<div>${signature
        .trim()
        .split("\n")
        .map((line) => escapeHtml(line) || "&nbsp;")
        .join("<br>")}</div>`
    : "";
  return `<html><head><meta charset="utf-8"></head><body><div style="font-family:${outlookFont};font-size:12pt;color:#000000">${body}${sig}</div></body></html>`;
}
