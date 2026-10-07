import type { NextConfig } from "next";

// Minimal CSP: everything is same-origin + inline data (receipt photos).
// 'unsafe-inline' for scripts stays because Next.js ships inline boot
// scripts (see app/layout.tsx's pre-paint theme script); there are no
// server-side injection vectors (all data lives in local IndexedDB, no SSR
// of user content). 'unsafe-eval' is dev-only (HMR/Turbopack need it) — a
// production build never needs eval, so it's dropped as the last line of
// XSS defense there.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV !== "production" ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  // LAN IP for testing the dev server from a phone on the same wifi.
  // ponytail: hardcoded IP, re-add/adjust if it changes (DHCP) or move to env if this grows past one device.
  allowedDevOrigins: ["10.25.121.11"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
