import "server-only";
import type { User } from "@/lib/auth";
import { escapeHtml } from "@/lib/email/merge-tags";
import { sanitizeSignatureHtml, signatureHasContent } from "@/lib/safe-html";

/**
 * The signature on email a teammate sends from their own Outlook. Their own
 * (Settings → Email and calendar) when they made one, going on every email
 * to start with if they chose that; otherwise the workspace's plain-text one
 * from the brand kit, which always starts on. Either way they can add it to
 * or take it off one email in the composer.
 */

type Signer = Pick<User, "name" | "title" | "emailSignature" | "signatureAuto">;

/** The teammate's own signature, or null when they haven't made one. Sanitized again on the way out, whatever was stored. */
export function ownSignature(user: Signer) {
  const html = sanitizeSignatureHtml(user.emailSignature);
  return signatureHasContent(html) ? html : null;
}

/** The workspace's plain-text signature with the sender's name and title in; other merge tags are left to `fill`. */
export function workspaceSignature(template: string | null | undefined, user: Pick<User, "name" | "title">, fill: (text: string) => string = (t) => t) {
  if (!template) return null;
  const text = fill(template.replace(/\{\{\s*sender_name\s*\}\}/gi, user.name).replace(/\{\{\s*sender_title\s*\}\}/gi, user.title ?? ""))
    .replace(/\n{2,}/g, "\n")
    .trim();
  return text || null;
}

/** What the composer shows under an Outlook email: the signature as HTML, whose it is, and whether it starts on. */
export function composerSignature(user: Signer, workspaceTemplate: string | null | undefined) {
  const own = ownSignature(user);
  if (own) return { html: own, own: true, auto: user.signatureAuto };
  const text = workspaceSignature(workspaceTemplate, user);
  if (!text) return null;
  return { html: `<p>${text.split("\n").map(escapeHtml).join("<br>")}</p>`, own: false, auto: true };
}

/**
 * The signature an Outlook email goes out with. `include` is what the
 * teammate chose in the composer; left out, it's their default.
 */
export function outlookSignature(user: Signer, workspaceText: string | null, include?: boolean): string | { html: string } | null {
  const own = ownSignature(user);
  if (!(include ?? (own ? user.signatureAuto : true))) return null;
  return own ? { html: own } : workspaceText;
}
