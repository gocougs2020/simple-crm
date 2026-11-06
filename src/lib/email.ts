import "server-only";
import { Resend } from "resend";
import { render } from "@react-email/render";
import type { ReactElement } from "react";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

/** The verified sending address, e.g. `Acme <crm@acme.com>`. Its domain needs SPF and DKIM records in Resend. */
export const emailFrom = process.env.RESEND_FROM ?? "CRM <crm@example.com>";

/**
 * The Resend domains this CRM manages, from RESEND_DOMAINS (comma-separated,
 * e.g. `mail.acme.com,acme.com`). Unset means every domain in the account.
 * Set it when the Resend account is shared with another app, so the CRM never
 * lists, syncs, sends from or removes that app's domains and inboxes.
 */
const scopedDomains = new Set(
  (process.env.RESEND_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),
);

export const emailDomainsScoped = scopedDomains.size > 0;

/** Whether a domain (`acme.com`) or an address on it (`sales@acme.com`) is one this CRM manages. */
export function inEmailScope(domainOrAddress: string) {
  if (!scopedDomains.size) return true;
  return scopedDomains.has(domainOrAddress.trim().toLowerCase().split("@").pop() ?? "");
}

/** The address part of RESEND_FROM, so a teammate's display name can be put in front of it. */
export function fromAs(displayName: string) {
  const address = /<([^>]+)>/.exec(emailFrom)?.[1] ?? emailFrom;
  return `${displayName.replace(/[<>"]/g, "")} <${address}>`;
}

export function emailConfigured() {
  return !!resend;
}

export function getResend() {
  return resend;
}

type SendArgs = {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  from?: string;
  subject: string;
  react?: ReactElement;
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  tags?: { name: string; value: string }[];
  idempotencyKey?: string;
};

/**
 * Sends through Resend. Without RESEND_API_KEY (local development) the
 * email is printed to the terminal instead, so every flow works end to end.
 */
export async function sendEmail({ idempotencyKey, ...args }: SendArgs): Promise<{ id: string | null }> {
  if (!resend) {
    const text = args.react ? await render(args.react, { plainText: true }) : (args.html ?? "").replace(/<[^>]+>/g, " ");
    console.info(`\n[email:dev] to=${args.to}${args.cc ? ` cc=${args.cc}` : ""} subject="${args.subject}"\n${text.replace(/\s+\n/g, "\n").slice(0, 2000)}\n`);
    return { id: null };
  }
  const payload = { ...args, from: args.from ?? emailFrom } as Parameters<Resend["emails"]["send"]>[0];
  const { data, error } = await resend.emails.send(payload, idempotencyKey ? { idempotencyKey } : undefined);
  if (error) throw new Error(`Resend: ${error.message}`);
  return { id: data?.id ?? null };
}
