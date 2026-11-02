import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";
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
  `connect-src 'self' https://vercel.com https://*.blob.vercel-storage.com${toolbar}${toolbar ? " wss://ws-us3.pusher.com" : ""}`,
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
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
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
    return [{ source: "/:path*", headers: securityHeaders }];
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

export default nextConfig;
