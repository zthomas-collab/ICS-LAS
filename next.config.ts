import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";
const mapOrigins = (process.env.MAP_TILE_ORIGINS ?? "https://tiles.openfreemap.org").split(/\s+/).filter(Boolean);

// CSP: 'unsafe-inline' for scripts is required by Next.js without nonces; move to nonce-based CSP in Phase 7.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${mapOrigins.join(" ")}`,
  `connect-src 'self' ${mapOrigins.join(" ")}${isDev ? " ws:" : ""}`,
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "child-src blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  turbopack: { root: __dirname },
  serverExternalPackages: ["@electric-sql/pglite", "@electric-sql/pglite-postgis", "pg", "sharp"],
  // Site photos up to 5 MB plus multipart overhead.
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
  outputFileTracingIncludes: { "/**": ["./db/migrations/**"] },
  async redirects() {
    // "Black Book" was renamed to "Contacts".
    return [{ source: "/black-book", destination: "/contacts", permanent: true }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "geolocation=(self), camera=(), microphone=()" },
          ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]),
        ],
      },
      // Authenticated and admin areas must never be indexed.
      { source: "/(dashboard|admin|auth|dev|account)/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] },
    ];
  },
};

export default nextConfig;
