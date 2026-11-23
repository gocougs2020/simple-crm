/**
 * Reading a forwarded email for who it was really between. When a teammate
 * forwards a thread into a team inbox, the message's own From is them and
 * its To is the inbox, so the people it's about only appear in the quoted
 * headers inside it: Gmail's "---------- Forwarded message ---------" block,
 * Outlook's "From: / Sent: / To:" lines, and "On …, Name <a@b> wrote:".
 */

import { htmlToText } from "@/lib/safe-html";

const ADDRESS = /[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
/** A quoted header line, as mail apps write them in plain text (Outlook bolds the label in its text part: "*From:*"). */
const HEADER_LINE = /^[\s>*]*(from|to|cc|reply-to)\s*\*?\s*:/i;
/** Gmail's and Apple Mail's attribution line above a quote. */
const WROTE_LINE = /\bwrote:\s*$/i;

/**
 * An email's text to read headers from: its plain-text part, or its HTML with
 * each block on its own line. Gmail's HTML forward puts every header in its
 * own <div>, which `htmlToText` would run together on one line.
 */
export function emailText(m: { text: string | null; html: string | null }) {
  return m.text ?? htmlToText(m.html?.replace(/<\/(div|tr)>/gi, "$&\n") ?? null);
}

/** Every address in the quoted headers of a forwarded or replied-to email, lowercased, in the order they appear, once each. */
export function forwardedAddresses(text: string | null | undefined): string[] {
  if (!text) return [];
  const found: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!HEADER_LINE.test(line) && !WROTE_LINE.test(line)) continue;
    // A long header (many recipients) wraps onto the lines below it.
    let header = line;
    for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]) && !HEADER_LINE.test(lines[j]); j++) header += ` ${lines[j]}`;
    for (const m of header.matchAll(ADDRESS)) {
      const a = m[0].toLowerCase().replace(/^[.'-]+|[.'-]+$/g, "");
      if (!found.includes(a)) found.push(a);
    }
  }
  return found;
}

/**
 * The addresses to look records up by: everyone on the thread who isn't a
 * teammate, then whoever a teammate's forward quoted. When that leaves
 * nobody (a teammate's own note to the inbox), everyone on it, as before.
 */
export function linkAddresses(participants: string[], teammates: Set<string>, forwarded: string[]) {
  const outside = [...participants, ...forwarded].filter((a, i, all) => !teammates.has(a) && all.indexOf(a) === i);
  return outside.length ? outside : participants;
}

/**
 * The addresses a thread's forwards quote, read only from the messages whose
 * sender is proven to be a teammate. A From line alone can be forged, and the
 * quoted headers decide which records the thread is filed on, so an unproven
 * "forward" never chooses them. Proof is asked for only when a message quotes
 * someone.
 */
export async function provenForwards<M>(messages: M[], quoted: (m: M) => string[], proven: (m: M) => Promise<boolean>) {
  const found: string[] = [];
  for (const m of messages) {
    const addresses = quoted(m);
    if (!addresses.length || !(await proven(m))) continue;
    for (const a of addresses) if (!found.includes(a)) found.push(a);
  }
  return found;
}
