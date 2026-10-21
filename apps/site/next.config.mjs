// SPDX-License-Identifier: AGPL-3.0-only
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMDX } from "fumadocs-mdx/next";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

// The monorepo keeps one .env at the root; real environment variables still win (loadEnvFile never overrides).
try {
  process.loadEnvFile(path.join(root, ".env"));
} catch {
  // no .env (CI, production): configuration comes from the environment
}
const https = process.env.APP_PROTOCOL === "https";
const webInternal = process.env.WEB_INTERNAL_URL ?? "http://127.0.0.1:43200";

/** LAN IPv4 addresses, so the dev server (bound to 0.0.0.0) can be opened from other devices on the network. */
const lanIps = Object.values(os.networkInterfaces())
  .flat()
  .filter((i) => i && i.family === "IPv4" && !i.internal)
  .map((i) => i.address);

/**
 * Marketing site + public docs + changelog + credits (anhourmail.com). A Next server with prerendered pages,
 * not a static export: `/api/public/*` is rewritten to the console app so the waitlist form posts
 * same-origin (no CORS). Zero third-party requests: self-hosted fonts, no analytics, no cookies.
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), interest-cohort=()" },
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  },
  ...(https ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
];

/** @type {import("next").NextConfig} */
const nextConfig = {
  output: "standalone",
  reactCompiler: true,
  poweredByHeader: false,
  logging: { incomingRequests: false },
  turbopack: { root },
  outputFileTracingRoot: root,
  transpilePackages: ["@anhourmail/shared", "@anhourmail/ui"],
  allowedDevOrigins: ["127.0.0.1", "localhost", "localhost", "*.localhost", ...lanIps],
  headers: async () => [{ source: "/:path*", headers: securityHeaders }],
  rewrites: async () => [{ source: "/api/public/:path*", destination: `${webInternal}/api/public/:path*` }],
};

const withMDX = createMDX();

export default withMDX(nextConfig);
