import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { appConfig } from "@/app.config";
import { themeStyleSheet } from "@/lib/theme-css";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

const { brand, theme } = appConfig;

export const metadata: Metadata = {
  title: { default: brand.name, template: `%s · ${brand.name}` },
  applicationName: brand.name,
  description: brand.description,
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: theme.browserColor, viewportFit: "cover" };

// Built once per deploy from app.config.ts and NEXT_PUBLIC_APP_CONFIG / NEXT_PUBLIC_BRAND_COLOR.
const themeCss = themeStyleSheet(theme);

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
      {themeCss ? (
        <head>
          <style id="app-theme">{themeCss}</style>
        </head>
      ) : null}
      <body>
        {children}
        {/* Vercel serves these from the site's own origin; locally there's nothing to report to. */}
        {process.env.VERCEL ? (
          <>
            <Analytics />
            <SpeedInsights />
          </>
        ) : null}
      </body>
    </html>
  );
}
