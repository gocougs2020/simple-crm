/**
 * Who a one-off email goes to. Plain rules, kept apart from the send so they
 * can be tested on their own.
 */

export type RecipientEntry = { personId: string | null; email: string };

/**
 * The To and Cc lines of one email, each address once. Addresses compare
 * without regard to case; someone on both lines stays on To, since Resend and
 * Outlook would otherwise deliver them the same email twice. `total` is what
 * counts against the limit (To and Cc together; a blind copy to the sender
 * doesn't). `otherPersonIds` is everyone it went to besides the first person
 * on To, for their timelines.
 */
export function planRecipients(input: { to: RecipientEntry[]; cc: RecipientEntry[] }) {
  const seen = new Set<string>();
  const people = new Set<string>();
  const line = (entries: RecipientEntry[]) => {
    const out: string[] = [];
    for (const e of entries) {
      const email = e.email.trim();
      const key = email.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(email);
      if (e.personId) people.add(e.personId);
    }
    return out;
  };
  const to = line(input.to);
  const cc = line(input.cc);
  const first = input.to[0]?.personId ?? null;
  return { to, cc, total: to.length + cc.length, otherPersonIds: [...people].filter((id) => id !== first) };
}
