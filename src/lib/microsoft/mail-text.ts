/**
 * Cleaning up Outlook's plain-text bodies before they go on a timeline. Pure,
 * so it's tested on its own.
 */

/** Lines where a reply's quoted history starts, in Outlook, Gmail and Apple Mail. */
const QUOTE_START = [
  /^_{10,}\s*$/, // Outlook's divider before "From: … Sent: …"
  /^-{2,}\s*Original Message\s*-{2,}/i,
  /^-{2,}\s*Forwarded message\s*-{2,}/i,
  /^On .{6,200}wrote:\s*$/i,
  /^From:\s.+\n(?:Sent|Date):\s/im,
];

/** The new part of an email: everything before the quoted thread it replies to. Forwards keep their content. */
export function stripQuoted(text: string) {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const rest = lines.slice(i, i + 2).join("\n");
    if (/^-{2,}\s*Forwarded message/i.test(lines[i])) return normalized.trim();
    if (QUOTE_START.some((re) => re.test(re.flags.includes("m") ? rest : lines[i]))) {
      const kept = lines.slice(0, i).join("\n").trim();
      return kept || normalized.trim();
    }
  }
  return normalized.trim();
}

/** "Sam Lee <sam@acme.com>" for a Graph emailAddress. */
export function graphAddress(a: { emailAddress?: { name?: string | null; address?: string | null } | null } | null | undefined) {
  const address = a?.emailAddress?.address?.trim().toLowerCase() ?? "";
  const name = a?.emailAddress?.name?.trim();
  return { address, display: name && name.toLowerCase() !== address ? `${name} <${address}>` : address };
}

/** PidTagSensitivity: where Outlook keeps a message's Normal / Personal / Private / Confidential label. */
export const SENSITIVITY_PROPERTY = "Integer 0x0036";
const SENSITIVITY = ["normal", "personal", "private", "confidential"] as const;

/** A message's Outlook sensitivity label when it's anything but Normal, from its extended properties. Null when it's normal or not set. */
export function outlookSensitivity(props: { id: string; value: string }[] | null | undefined): "personal" | "private" | "confidential" | null {
  // Graph may hand the id back without the leading zeros ("Integer 0x36").
  const raw = props?.find((p) => /^integer\s+0x0*36$/i.test(p.id.trim()))?.value;
  const label = SENSITIVITY[Number(raw)];
  return label && label !== "normal" ? label : null;
}
