import type { CallStatus, TextStatus } from "@/db/schema";
import { formatPhone, matchKey } from "./numbers";

/**
 * Small rules for calls and texts, pure so they're tested on their own and
 * shared with the browser.
 */

/** What a call's outcome reads as on the timeline, from where it ended up. */
export function callOutcome(status: CallStatus, direction: "inbound" | "outbound", seconds: number | null): string | null {
  switch (status) {
    case "completed":
      return (seconds ?? 0) > 0 ? (direction === "inbound" ? "Answered" : "Connected") : direction === "inbound" ? "Missed" : "No answer";
    case "busy":
      return direction === "inbound" ? "Missed" : "Busy";
    case "no-answer":
      return direction === "inbound" ? "Missed" : "No answer";
    case "failed":
      return "Didn't go through";
    case "canceled":
      return direction === "inbound" ? "Missed" : "Hung up before an answer";
    default:
      return null;
  }
}

/** Ended: no more reports change it. */
export const finalCallStatuses: CallStatus[] = ["completed", "busy", "no-answer", "failed", "canceled"];

/** "3 min", "45 sec", "1 hr 2 min". */
export function formatCallDuration(seconds: number | null | undefined) {
  if (!seconds) return null;
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} hr${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}

/**
 * Keywords carriers and Twilio treat as opting out of, or back in to, texts
 * from a number (Twilio's Advanced Opt-Out defaults). Matched on the whole
 * message, ignoring case and punctuation.
 */
const OPT_OUT = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "optout", "revoke", "stop all", "opt out"]);
const OPT_IN = new Set(["start", "unstop", "yes"]);

export function optKeyword(body: string): "out" | "in" | null {
  const word = body
    .trim()
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .replace(/\s+/g, " ");
  if (OPT_OUT.has(word)) return "out";
  if (OPT_IN.has(word)) return "in";
  return null;
}

/** A text's status only moves forward: a late "sent" never undoes "delivered". */
const textRank: Record<TextStatus, number> = { queued: 0, sending: 1, sent: 2, received: 2, delivered: 3, undelivered: 4, failed: 4 };
export function laterTextStatus(current: TextStatus, next: TextStatus) {
  return textRank[next] >= textRank[current];
}

export const textStatusLabels: Record<TextStatus, string> = {
  queued: "Queued",
  sending: "Sending",
  sent: "Sent",
  delivered: "Delivered",
  undelivered: "Not delivered",
  failed: "Failed",
  received: "Received",
};

/**
 * Who looks after a number's calls and texts: the teammate an admin picked on
 * the number ("Who answers"), else the one teammate whose cell phone (from
 * their profile) the number forwards to. A cell phone is typed in by its owner
 * and never verified, so it never overrides the admin's pick, and a number two
 * teammates both claim matches nobody. Deactivated teammates don't count.
 */
export function numberTeammateId(number: { forwardTo: string | null; forwardUserId: string | null }, team: { id: string; phone: string | null; active: boolean }[]): string | null {
  if (number.forwardUserId) return team.some((u) => u.id === number.forwardUserId && u.active) ? number.forwardUserId : null;
  const key = matchKey(number.forwardTo);
  if (key.length < 7) return null;
  const cells = team.filter((u) => u.active && matchKey(u.phone) === key);
  return cells.length === 1 ? cells[0].id : null;
}

/** Where an incoming call went, for its timeline entry and write-up task. "Sam's cell" only when the number is the cell in Sam's profile. */
export function forwardedLine(forwardedTo: string | null, forwardUser: { name: string; phone?: string | null } | null, number: { label: string }) {
  if (!forwardedTo) return `${number.label} has no forwarding number, so no one picked up.`;
  const to = formatPhone(forwardedTo);
  if (forwardUser?.phone && matchKey(forwardUser.phone) === matchKey(forwardedTo)) return `Forwarded to ${forwardUser.name}'s cell, ${to}.`;
  return forwardUser ? `Forwarded to ${to}, for ${forwardUser.name}.` : `Forwarded to ${to}.`;
}
