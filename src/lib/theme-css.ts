import type { AppConfig, ThemeToken } from "@/app.config";
import { isSafeCssValue } from "./config-overrides";

/**
 * CSS that layers `appConfig.theme` over `src/styles/theme.css`. Empty when
 * the theme is untouched, so the default build renders no extra tag.
 *
 * `brandColor` fills in the whole accent family: hover is the color mixed
 * 15% toward black, the soft tint 10% of it on white, and text on the tint
 * 80% of it toward black. Explicit `tokens` win over the derived values.
 *
 * The selector is `html:root`, one step more specific than theme.css's
 * `:root`, so it wins whatever order the stylesheets load in.
 */
export function themeStyleSheet(theme: AppConfig["theme"]): string {
  const c = theme.brandColor;
  const brand: Partial<Record<ThemeToken, string>> = c
    ? {
        accent: c,
        "accent-hover": `color-mix(in oklab, ${c} 85%, black)`,
        "accent-foreground": theme.brandForeground,
        "accent-soft": `color-mix(in oklab, ${c} 10%, white)`,
        "accent-soft-foreground": `color-mix(in oklab, ${c} 80%, black)`,
        ring: c,
      }
    : {};

  const body = Object.entries({ ...brand, ...theme.tokens })
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && isSafeCssValue(entry[1]))
    .map(([name, value]) => `--${name}:${value}`)
    .join(";");

  return body ? `html:root{${body}}` : "";
}
