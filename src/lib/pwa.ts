import { appConfig } from "@/app.config";

/**
 * The installed app's look, from app.config.ts: its name under the icon and
 * the icon's colors. The fallback is theme.css's default accent, since images
 * can't read CSS variables.
 */
const DEFAULT_ACCENT = "#18181b";

export const pwa = {
  name: appConfig.brand.name,
  shortName: appConfig.pwa.shortName || appConfig.brand.name,
  background: appConfig.pwa.iconBackground ?? appConfig.theme.brandColor ?? DEFAULT_ACCENT,
  foreground: appConfig.pwa.iconForeground,
  splash: appConfig.pwa.backgroundColor,
  /** The letter on the icon: the first letter or digit of the brand name. */
  letter: (appConfig.brand.name.match(/[\p{L}\p{N}]/u)?.[0] ?? "C").toUpperCase(),
};
