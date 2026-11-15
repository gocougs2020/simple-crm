import type { DeliveryStatus } from "@/db/schema";

/**
 * The parts of delivery tracking that are plain rules, kept apart from the
 * database code so they can be tested on their own.
 */

/** Reports can arrive late or twice; a status only ever moves forward along this order. */
export const deliveryRank: Record<DeliveryStatus, number> = { sent: 1, delayed: 2, delivered: 3, failed: 4, suppressed: 4, bounced: 5, complained: 6 };

/** Resend webhook event → the status it moves an email to. Opens and clicks are counted separately (and mean it was delivered). */
export const eventStatus: Record<string, DeliveryStatus> = {
  "email.sent": "sent",
  "email.delivery_delayed": "delayed",
  "email.delivered": "delivered",
  "email.opened": "delivered",
  "email.clicked": "delivered",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
  "email.suppressed": "suppressed",
};

/** The events the CRM's Resend webhook subscribes to for delivery reports. */
export const deliveryEvents = Object.keys(eventStatus);

/** Whether a report should replace the status an email already has. */
export function movesForward(current: DeliveryStatus | null | undefined, next: DeliveryStatus) {
  return !current || deliveryRank[current] <= deliveryRank[next];
}

/** Resend's `last_event` on GET /emails/:id → our status, for the hourly check. Queued and scheduled aren't news yet. */
const lastEventStatus: Partial<Record<string, DeliveryStatus>> = {
  sent: "sent",
  delivery_delayed: "delayed",
  delivered: "delivered",
  opened: "delivered",
  clicked: "delivered",
  bounced: "bounced",
  complained: "complained",
  failed: "failed",
  canceled: "failed",
  suppressed: "suppressed",
};

export function statusFromLastEvent(lastEvent: string | null | undefined): DeliveryStatus | null {
  return (lastEvent && lastEventStatus[lastEvent]) || null;
}

export type EmailEventData = {
  email_id?: string;
  to?: string[];
  created_at?: string;
  bounce?: { message?: string; subType?: string; type?: string };
  failed?: { reason?: string };
  suppressed?: { message?: string; type?: string };
  tags?: Record<string, string> | { name: string; value: string }[];
};

/** Why an email didn't arrive, in Resend's words, for the timeline and the campaign report. */
export function deliveryDetail(status: DeliveryStatus, d: EmailEventData): string | null {
  if (status === "bounced") return [d.bounce?.type, d.bounce?.subType, d.bounce?.message].filter(Boolean).join(": ") || null;
  if (status === "failed") return d.failed?.reason ?? null;
  if (status === "suppressed") return d.suppressed?.message ?? "This address is on Resend's suppression list after an earlier bounce or spam complaint.";
  return null;
}

/** Only a permanent bounce or a complaint protects the address; a transient bounce may deliver next time. */
export function addressProblem(status: DeliveryStatus, d: EmailEventData): "bounced" | "complained" | null {
  if (status === "complained") return "complained";
  if (status === "bounced" && /permanent/i.test(d.bounce?.type ?? "")) return "bounced";
  return null;
}

export function eventTag(tags: EmailEventData["tags"], name: string) {
  return Array.isArray(tags) ? tags.find((t) => t.name === name)?.value : tags?.[name];
}

/** Whole percent, rounded down so a campaign with one bounce never reads 100%. */
export function percent(part: number, whole: number) {
  return whole > 0 ? Math.floor((part / whole) * 100) : 0;
}

/** How each status reads in the interface. */
export const deliveryLabels: Record<DeliveryStatus, string> = {
  sent: "Sent",
  delayed: "Delayed",
  delivered: "Delivered",
  failed: "Failed",
  suppressed: "Suppressed",
  bounced: "Bounced",
  complained: "Marked as spam",
};

export const deliveryTone: Record<DeliveryStatus, "neutral" | "info" | "success" | "warning" | "error"> = {
  sent: "neutral",
  delayed: "warning",
  delivered: "success",
  failed: "error",
  suppressed: "error",
  bounced: "error",
  complained: "error",
};
