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
