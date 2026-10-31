import { Section, Text } from "@react-email/components";
import { accentOf, EmailLayout, type EmailBrand } from "./layout";

/**
 * A one-off email from a teammate, sent from a record. Reads like a personal
 * email: the brand kit's logo on top, the message, the sender's signature.
 */
export default function DirectEmail({ brand, html, preview, signature }: { brand: EmailBrand; html: string; preview: string; signature?: string | null }) {
  return (
    <EmailLayout brand={brand} preview={preview}>
      <Section>
        <div style={{ fontSize: 15, lineHeight: "24px", color: "#27272a" }} dangerouslySetInnerHTML={{ __html: emailHtml(html, accentOf(brand)) }} />
      </Section>
      {signature ? <Text style={{ margin: "20px 0 0", fontSize: 14, lineHeight: "21px", color: "#52525b", whiteSpace: "pre-line" }}>{signature}</Text> : null}
    </EmailLayout>
  );
}

/** Inline styles per tag, since email clients ignore <style> blocks unevenly. Input is already sanitized. */
export function emailHtml(html: string, accent: string) {
  const styles: Record<string, string> = {
    p: "margin:0 0 14px",
    ul: "margin:0 0 14px;padding-left:22px",
    ol: "margin:0 0 14px;padding-left:22px",
    li: "margin:0 0 4px",
    blockquote: "margin:0 0 14px;padding-left:12px;border-left:3px solid #e4e4e7;color:#52525b",
    a: `color:${accent};text-decoration:underline`,
    h2: "margin:20px 0 8px;font-size:18px;line-height:26px;color:#09090b",
    h3: "margin:16px 0 6px;font-size:16px;line-height:24px;color:#09090b",
  };
  return html
    .replace(/<(p|ul|ol|li|blockquote|a|h2|h3)(\s[^>]*)?>/gi, (m, tag: string, attrs = "") => `<${tag}${attrs} style="${styles[tag.toLowerCase()]}">`)
    .replace(/(<p[^>]*>)\s*<\/p>/gi, "$1&nbsp;</p>");
}

DirectEmail.PreviewProps = { brand: { workspaceName: "Acme" }, preview: "Following up", html: "<p>Hi Sam,</p><p>Great talking today. Here's the <strong>proposal</strong> we discussed.</p>", signature: "Jordan Lee\nAccount Executive" };
