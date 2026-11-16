/**
 * A little TwiML (Twilio's call instructions, as XML) without a dependency.
 * Every value is escaped, so a caller's number or a typed message can't
 * change the instructions.
 */

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export type Node = { tag: string; attrs?: Record<string, string | number | boolean | null | undefined>; children?: (Node | string)[] };

export const el = (tag: string, attrs?: Node["attrs"], ...children: (Node | string)[]): Node => ({ tag, attrs, children });

function render(n: Node | string): string {
  if (typeof n === "string") return escape(n);
  const attrs = Object.entries(n.attrs ?? {})
    .filter(([, v]) => v !== null && v !== undefined && v !== false)
    .map(([k, v]) => ` ${k}="${escape(String(v))}"`)
    .join("");
  const inner = (n.children ?? []).map(render).join("");
  return inner ? `<${n.tag}${attrs}>${inner}</${n.tag}>` : `<${n.tag}${attrs}/>`;
}

/** A whole TwiML document. */
export function twiml(...children: Node[]) {
  return `<?xml version="1.0" encoding="UTF-8"?>${render(el("Response", undefined, ...children))}`;
}

export function twimlResponse(xml: string, status = 200) {
  return new Response(xml, { status, headers: { "content-type": "text/xml; charset=utf-8" } });
}
