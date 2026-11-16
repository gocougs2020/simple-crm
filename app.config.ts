/**
 * Product defaults: what every deployment of this CRM starts from.
 *
 * Two ways to change them:
 *
 * 1. Without touching code (recommended for forks and for running several
 *    deployments from one repo): set `NEXT_PUBLIC_APP_CONFIG` on the Vercel
 *    project to a JSON object with only the keys you want to change, e.g.
 *    `{"brand":{"name":"Acme CRM"},"theme":{"brandColor":"#2f629f"}}`.
 *    `NEXT_PUBLIC_APP_NAME` and `NEXT_PUBLIC_BRAND_COLOR` are shortcuts.
 *    Unknown keys and wrong types fail the build. Redeploy after a change.
 * 2. Edit this file. Use this when the change should apply to every
 *    deployment of your fork.
 *
 * Everything here is visible in the browser: no secrets. Secrets and
 * per-environment URLs stay in their own environment variables (.env.example).
 * The workspace name, email brand kit, pipelines and fields live in the
 * database and are edited in Settings.
 *
 * See docs/THEMING.md.
 */

import { applyConfigOverrides } from "./src/lib/config-overrides";

/**
 * Color tokens from `src/styles/theme.css`, without the leading `--`.
 * Values are any CSS color (`#2f629f`, `oklch(0.55 0.15 250)`).
 */
export type ThemeToken =
  | "accent"
  | "accent-hover"
  | "accent-foreground"
  | "accent-soft"
  | "accent-soft-foreground"
  | "background"
  | "canvas"
  | "surface"
  | "surface-sunken"
  | "overlay"
  | "text-primary"
  | "text-secondary"
  | "text-muted"
  | "text-faint"
  | "border"
  | "border-strong"
  | "ring"
  | "note-surface"
  | "note-border";

export type AppConfig = {
  brand: {
    /** Browser tab title ("Clients · CRM") and installed-app name. The sidebar shows the workspace name from Settings. */
    name: string;
    /** HTML meta description. */
    description: string;
  };
  theme: {
    /**
     * One brand color. Sets the accent (primary buttons, focus rings,
     * selected states) and derives its hover, tint and tint-text shades.
     * `null` keeps the neutral default in `theme.css`.
     */
    brandColor: string | null;
    /** Text and icons on `brandColor`. Keep at least 4.5:1 contrast. */
    brandForeground: string;
    /** Per-token overrides, applied after `brandColor`. */
    tokens: Partial<Record<ThemeToken, string>>;
    /** Browser toolbar / installed-app title bar. Match `--canvas`. */
    browserColor: string;
  };
  layout: {
    /** How Clients opens for a teammate who hasn't picked board or table yet. */
    defaultClientsView: "board" | "table";
  };
  email: {
    /**
     * Record and show when people open emails (Resend's webhook, email.opened).
     * Off by default: the tracking pixel can hurt deliverability, and opens
     * are approximate (some mail apps open everything for privacy). Turning
     * it on also needs open tracking on for the sending domain in Resend.
     */
    trackOpens: boolean;
    /** Record and show link clicks (email.clicked). Same trade-off: Resend rewrites links through its own domain. */
    trackClicks: boolean;
  };
  agent: {
    /**
     * The AI features, each switched on or off per deployment. All of them
     * also need AI Gateway access (docs/AGENT.md); without it they hide
     * themselves. Turning one off also refuses it on the server.
     */
    /** The assistant: its button in the bottom right corner and the chat panel. */
    enabled: boolean;
    /** Live voice chat in the assistant panel (speech to speech). */
    voice: boolean;
    /** Microphones that dictate into the assistant's composer and the CRM's text boxes. */
    dictation: boolean;
    /** The AI summary at the top of client, person and organization pages. */
    summaries: boolean;
    /** What the assistant is called in its panel and its own replies. */
    name: string;
    /** AI Gateway model ids (creator/model). Change them to try another model; nothing else needs to change. */
    chatModel: string;
    /** How hard the chat model thinks before answering. More is slower and costs more; "provider-default" leaves it to the model. */
    chatReasoning: "provider-default" | "none" | "minimal" | "low" | "medium" | "high";
    /** Writes the snapshot at the top of client, person and organization pages, refreshed once a day. */
    summaryModel: string;
    summaryReasoning: "provider-default" | "none" | "minimal" | "low" | "medium" | "high";
    /** Names threads from their first messages. Small and fast is enough. */
    titleModel: string;
    /** Speech-to-speech for voice chat (a realtime model with tool use). */
    voiceModel: string;
    /** Speech-to-text for the composer's microphone. */
    transcriptionModel: string;
    /** Suggested actions on a new chat, one tap away. Read-only teammates see only `viewerSuggestions`. */
    suggestions: readonly string[];
    viewerSuggestions: readonly string[];
  };
  notifications: {
    /** The hour (0–23, workspace time zone) the morning push summary and agenda emails go out. */
    morningHour: number;
  };
  records: {
    /**
     * What a starred person at an organization is called: the people who make
     * or sign off on the decision. Shown on the star's tooltip, the person's
     * page and the audience filter.
     */
    keyContactLabel: string;
  };
  microsoft: {
    /**
     * Connecting Microsoft 365 (Outlook, Exchange Online) mailboxes and
     * calendars, per teammate. Also needs MICROSOFT_CLIENT_ID and
     * MICROSOFT_CLIENT_SECRET (docs/MICROSOFT.md); without them it hides itself.
     */
    enabled: boolean;
    /** How often mailboxes are synced: 15, 30 or 60 minutes. Less often means fewer database wake-ups. */
    syncEveryMinutes: number;
    /** How far back the first sync of a newly connected mailbox reads. */
    firstSyncDays: number;
    /** Also copy mail teammates send from Outlook itself (Sent Items) to the records it's addressed to. */
    syncSent: boolean;
    /**
     * Screen each email with a decision model before it goes on a record, and
     * keep sensitive ones out. Needs AI_GATEWAY_API_KEY; when the screen isn't
     * available, mail goes in unscreened. Emails Outlook marks Private or
     * Confidential are always kept out, screen or not.
     */
    screenMail: boolean;
    /**
     * The screening model: an AI Gateway decision model (type "evaluation"),
     * which answers with a probability instead of writing text, so it's fast
     * and costs a fraction of a cent per email.
     */
    screenModel: string;
    /** What counts as sensitive, in plain words. */
    screenInstructions: string;
    /** Keep an email out when the model is at least this sure (0–1) it's sensitive. Lower keeps more out. */
    screenThreshold: number;
    /**
     * Mark kept-out emails in Outlook with this category, so the teammate can
     * see which ones didn't go into the CRM. `null` names it after the app
     * ("Not in CRM"); an empty string turns marking off.
     */
    withheldCategory: string | null;
    /** Copy planned activities of these types to the assignee's Outlook calendar. */
    calendarTypes: readonly ("meeting" | "call")[];
    /** How long a copied meeting is when no duration was given, in minutes. */
    calendarDefaultMinutes: number;
    /** Invite the person the meeting is with (Outlook emails them an invitation). Off: only the teammate's calendar changes. */
    inviteContacts: boolean;
  };
  phone: {
    /**
     * Calling and texting through Twilio. Also needs TWILIO_ACCOUNT_SID and
     * TWILIO_AUTH_TOKEN (docs/PHONE.md); without them it hides itself.
     */
    enabled: boolean;
    /** Country calling code added to numbers typed without one ("1" for the US and Canada). */
    defaultCountryCode: string;
    /** Where new numbers are bought (Settings → Phone numbers), as a two-letter country code. Area codes work in "US" and "CA". */
    numberCountry: string;
    /** Caller ID on a forwarded call: the caller's own number (so the cell phone shows who it is), or the team's number. */
    forwardCallerId: "caller" | "number";
    /** Seconds a forwarded call rings before it's treated as missed. */
    forwardTimeoutSeconds: number;
    /** Said to callers when the forwarded call isn't answered. `null` just hangs up. */
    missedCallMessage: string | null;
    /** Text campaigns only go to people marked as having agreed to marketing texts. Turning this off is your legal call. */
    textCampaignsNeedConsent: boolean;
    /** Added to the end of every campaign text. Carriers expect a way to opt out. */
    textCampaignFooter: string;
  };
  pwa: {
    /** Name under the icon on a phone's home screen (12 characters or fewer reads best). Defaults to `brand.name`. */
    shortName: string | null;
    /** Icon tile color. `null` uses `theme.brandColor`, or the default accent. */
    iconBackground: string | null;
    /** The letter on the icon. */
    iconForeground: string;
    /** Splash screen behind the icon while the installed app opens. Match `--canvas`. */
    backgroundColor: string;
  };
};

const defaults = {
  brand: {
    name: "CRM",
    description: "People, organizations and clients for your team.",
  },
  theme: {
    brandColor: null,
    brandForeground: "#ffffff",
    tokens: {},
    browserColor: "#fafafa",
  },
  layout: {
    defaultClientsView: "board",
  },
  email: {
    trackOpens: false,
    trackClicks: false,
  },
  agent: {
    enabled: true,
    voice: true,
    dictation: true,
    summaries: true,
    name: "Assistant",
    chatModel: "openai/gpt-6.1-sol",
    chatReasoning: "medium",
    summaryModel: "openai/gpt-6.1-sol",
    summaryReasoning: "low",
    titleModel: "anthropic/claude-haiku-5.5",
    voiceModel: "spacexai/grok-voice-3.0",
    transcriptionModel: "spacexai/grok-stt",
    suggestions: ["What's on my plate today?", "Which clients need attention?", "Add a task to follow up with…", "Log a call with…"],
    viewerSuggestions: ["What's due today across the team?", "Which clients need attention?", "Summarize a client for me", "Who are our newest contacts?"],
  },
  notifications: {
    morningHour: 7,
  },
  records: {
    keyContactLabel: "Decision maker",
  },
  microsoft: {
    enabled: true,
    syncEveryMinutes: 15,
    firstSyncDays: 14,
    syncSent: true,
    screenMail: true,
    screenModel: "typesafe-ai/jev",
    screenInstructions:
      "Anything not about recruiting, broadly speaking. Above all: compensation, pay, salary, bonuses, commissions, benefits or other money matters about a person; and conversations between members of our own team (listed in ourTeam), even when a teammate also happens to be in the CRM as a person. Also personal matters (health, family), HR issues, legal disputes, and passwords or security codes.",
    screenThreshold: 0.6,
    withheldCategory: null,
    calendarTypes: ["meeting"],
    calendarDefaultMinutes: 30,
    inviteContacts: false,
  },
  phone: {
    enabled: true,
    defaultCountryCode: "1",
    numberCountry: "US",
    forwardCallerId: "caller",
    forwardTimeoutSeconds: 25,
    missedCallMessage: null,
    textCampaignsNeedConsent: true,
    textCampaignFooter: "Reply STOP to opt out.",
  },
  pwa: {
    shortName: null,
    iconBackground: null,
    iconForeground: "#ffffff",
    backgroundColor: "#fafafa",
  },
} as const satisfies AppConfig;

/**
 * The config the app runs with: the defaults above plus this deployment's
 * `NEXT_PUBLIC_*` overrides. Each `process.env` read is spelled out so
 * Next.js can inline it into client bundles.
 */
export const appConfig: AppConfig = applyConfigOverrides<AppConfig>(defaults, {
  json: process.env.NEXT_PUBLIC_APP_CONFIG,
  name: process.env.NEXT_PUBLIC_APP_NAME,
  brandColor: process.env.NEXT_PUBLIC_BRAND_COLOR,
});
