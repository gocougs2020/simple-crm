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
