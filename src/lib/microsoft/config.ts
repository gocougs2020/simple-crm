import "server-only";
import { appConfig } from "@/app.config";

/**
 * Microsoft 365 (Outlook and Exchange Online) through Microsoft Graph. Each
 * teammate connects their own mailbox and calendar with OAuth; the CRM is one
 * app registration in Microsoft Entra ID (docs/MICROSOFT.md).
 *
 * - MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET: the app registration.
 * - MICROSOFT_TENANT_ID (optional): your directory's id or domain, so only
 *   your organization's accounts can connect. Defaults to `organizations`
 *   (any work or school account); `common` also allows personal Outlook.com.
 */

export const GRAPH = "https://graph.microsoft.com/v1.0";

/**
 * What the CRM asks each teammate for. Mail.ReadWrite (not just Read) is
 * what lets it mark emails it kept out with a category; Calendars.ReadWrite
 * puts CRM meetings on their calendar and shows it in Calendar.
 */
export const MICROSOFT_SCOPES = ["offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send", "Calendars.ReadWrite"] as const;

export function microsoftCredentials() {
  const clientId = process.env.MICROSOFT_CLIENT_ID?.trim();
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const tenant = process.env.MICROSOFT_TENANT_ID?.trim() || "organizations";
  return { clientId, clientSecret, authority: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0` };
}

/** Whether teammates can connect Microsoft 365 here: switched on (`microsoft.enabled`) and an app registration set up. */
export function microsoftConfigured() {
  return appConfig.microsoft.enabled && !!microsoftCredentials();
}

/** The category kept-out emails get in Outlook, or null when marking is off. */
export function withheldCategory() {
  const c = appConfig.microsoft.withheldCategory;
  if (c === "") return null;
  return (c ?? `Not in ${appConfig.brand.name}`).slice(0, 255);
}

/** How often mailboxes sync, rounded to what the quarter-hour cron can do. */
export function syncEveryMinutes() {
  const n = Math.round(appConfig.microsoft.syncEveryMinutes / 15) * 15;
  return Math.min(Math.max(n, 15), 24 * 60);
}

/** Activity types copied to calendars, limited to the ones that make sense there. */
export function calendarTypes(): ("meeting" | "call")[] {
  return appConfig.microsoft.calendarTypes.filter((t): t is "meeting" | "call" => t === "meeting" || t === "call");
}
