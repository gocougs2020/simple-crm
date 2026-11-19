import "server-only";
import type { User } from "@/lib/auth";
import { microsoftConfigured } from "@/lib/microsoft/config";
import { accountOf } from "@/lib/microsoft/graph";
import { numbersFor } from "@/lib/twilio/access";
import { phoneConfigured } from "@/lib/twilio/config";
import { voiceCredentials } from "@/lib/twilio/setup";

/**
 * What the signed-in teammate can call, text and email from, for the
 * interface: their phone numbers, whether browser calling is set up, and
 * their connected mailbox. Loaded once in the app layout.
 */
export async function commsFor(user: User) {
  const phone = phoneConfigured();
  const microsoft = microsoftConfigured();
  const [numbers, voice, account] = await Promise.all([phone ? numbersFor(user) : [], phone ? voiceCredentials() : null, microsoft ? accountOf(user.id) : null]);
  const list = numbers.map((n) => ({ id: n.id, label: n.label, number: n.number }));
  return {
    /** Texting and calling are set up on this deployment (a Twilio account). */
    phone,
    numbers: list,
    /** The number they used last, else the first. */
    defaultNumberId: (list.find((n) => n.id === user.prefs.phoneNumberId) ?? list.at(0))?.id ?? (null as string | null),
    texting: phone && list.length > 0,
    calling: phone && !!voice && list.length > 0,
    /** Microsoft 365 can be connected here. */
    microsoft,
    /** They connected a mailbox, so Email offers the list of what was copied from it. */
    outlook: !!account,
    /** Their own mailbox, when connected and allowed to send. */
    mailbox: account && account.sendMail ? { email: account.email, needsReconnect: account.status !== "active" } : null,
  };
}

export type Comms = Awaited<ReturnType<typeof commsFor>>;
