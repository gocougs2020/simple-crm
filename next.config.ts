import type { NextConfig } from "next";
import { withEve } from "eve/next";
import { appConfig } from "./app.config";

const isDev = process.env.NODE_ENV === "development";
// The AI features a deployment turned on decide what the browser may reach and use (app.config.ts, agent.*).
const voiceChat = appConfig.agent.enabled && appConfig.agent.voice;
// Calling from the browser (Twilio Voice SDK) needs the microphone and Twilio's signaling, event and sound hosts.
const calling = !!process.env.TWILIO_ACCOUNT_SID?.trim();
const microphone = voiceChat || appConfig.agent.dictation || calling;
// The Vercel Toolbar (comments, feedback) only runs on preview deployments.
const toolbar = process.env.VERCEL_ENV === "preview" ? " https://vercel.live" : "";

// No nonces: they would force every page to render per request. Next.js's inline bootstrap scripts need 'unsafe-inline' without them.
// img-src allows https images because email templates and the brand kit can use image URLs from anywhere.
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}${toolbar}`,
  // Inline event handlers (onclick="…") never run, even if markup slipped through.
  "script-src-attr 'none'",
  `style-src 'self' 'unsafe-inline'${toolbar}`,
  "img-src 'self' data: blob: https:",
  `font-src 'self' data:${toolbar ? " https://vercel.live https://assets.vercel.com" : ""}`,
  // Browser uploads go straight to Vercel Blob.
  // Voice chat streams audio straight to AI Gateway's realtime socket, with a short-lived token from our server.
  // Browser calls signal over wss://voice-js.<edge>.twilio.com and report call quality to eventgw.twilio.com.
  `connect-src 'self' https://vercel.com https://*.blob.vercel-storage.com${voiceChat ? " wss://ai-gateway.vercel.sh" : ""}${calling ? " wss://*.twilio.com https://*.twilio.com" : ""}${toolbar}${toolbar ? " wss://ws-us3.pusher.com" : ""}`,
  // The Voice SDK's ringing and keypad tones come from sdk.twilio.com.
  `media-src 'self' blob: data:${calling ? " https://sdk.twilio.com" : ""}`,
  "worker-src 'self' blob:",
  // The email preview renders in a sandboxed srcdoc iframe.
  `frame-src 'self'${toolbar}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // 'self' so the email previews (sandboxed srcdoc frames, no scripts) can render; other sites still can't frame the CRM.
  "frame-ancestors 'self'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The microphone is for calls, dictation and voice chat, on this site only, and only when one of them is turned on.
  { key: "Permissions-Policy", value: `camera=(), microphone=${microphone ? "(self)" : "()"}, geolocation=(), browsing-topics=()` },
  // A private CRM: never indexed, even if a URL leaks.
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // PGlite (local-dev database) loads its own WASM and data files at runtime.
  serverExternalPackages: ["@electric-sql/pglite"],
  images: {
    formats: ["image/avif", "image/webp"],
    remotePatterns: [{ protocol: "https", hostname: "*.public.blob.vercel-storage.com" }],
  },
  experimental: {
    // Spreadsheet imports post rows in chunks; keep each chunk well under Vercel's 4.5 MB limit.
    serverActions: { bodySizeLimit: "2mb" },
  },
  // Deals became clients; old links and bookmarks still land in the right place.
  async redirects() {
    return [
      { source: "/deals", destination: "/clients", permanent: true },
      { source: "/deals/:id", destination: "/clients/:id", permanent: true },
    ];
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // The service worker is always fetched fresh, so a deploy's change reaches every device on its next visit.
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

/**
 * The assistant's background worker is an eve agent (agent/, docs/AGENT.md) that
 * runs beside the app as its own service, reached at /eve/v1. `withEve` builds it
 * with the app and, in development, starts it with `next dev`.
 *
 * It's left out where it can't run or isn't wanted: background work turned off in
 * app.config.ts, Node.js older than 24 (eve's minimum), or local development
 * without an AI Gateway key (so `pnpm dev` still starts with no setup).
 */
const backgroundAgent =
  appConfig.agent.enabled &&
  appConfig.agent.background.enabled &&
  Number(process.versions.node.split(".")[0]) >= 24 &&
  (!isDev || !!process.env.AI_GATEWAY_API_KEY?.trim() || !!process.env.EVE_BASE_URL?.trim());

export default backgroundAgent ? withEve(nextConfig) : nextConfig;
