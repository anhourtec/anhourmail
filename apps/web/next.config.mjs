// SPDX-License-Identifier: AGPL-3.0-only
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

// The monorepo keeps one .env at the root; real environment variables still win (loadEnvFile never overrides).
try {
  process.loadEnvFile(path.join(root, ".env"));
} catch {
  // no .env (CI, production): configuration comes from the environment
}
const https = process.env.APP_PROTOCOL === "https";

/** Dev: LAN IPv4s, so the app works from other devices when DEV_HOST=0.0.0.0. */
const lanHosts = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);

/**
 * Baseline headers for the console. The webmail routes get a stricter nonce-based CSP and the sandboxed
 * message frame in Phase 4 (docs/internal/05-webmail.md "Rendering safety").
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), interest-cohort=()" },
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  },
  ...(https ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
];

/** @type {import("next").NextConfig} */
const nextConfig = {
  // Dev-only badge: bottom-right, clear of the sidebar's account button (bottom-left) and the header menus.
  devIndicators: { position: "bottom-right" },
  output: "standalone",
  reactCompiler: true,
  poweredByHeader: false,
  // Next's dev request log prints raw paths, which can hold tokens.
  logging: { incomingRequests: false },
  turbopack: { root },
  outputFileTracingRoot: root,
  transpilePackages: [
    "@anhourmail/adapters",
    "@anhourmail/core",
    "@anhourmail/jmap-client",
    "@anhourmail/server",
    "@anhourmail/shared",
    "@anhourmail/stalwart-client",
    "@anhourmail/ui",
  ],
  allowedDevOrigins: ["127.0.0.1", "localhost", "*.localhost", ...lanHosts()],
  compiler: { removeConsole: process.env.NODE_ENV === "production" ? { exclude: ["error", "warn"] } : false },
  // The webmail API sets its own Content-Security-Policy per response (a sandbox for print views, previews and raw
  // sources); a config header of the same name would replace it, so that path gets every header but the CSP.
  headers: async () => [
    { source: "/:path((?!api/webmail/).*)", headers: securityHeaders },
    {
      // route() adds a strict CSP to any webmail API response that doesn't set its own.
      source: "/api/webmail/:path*",
      headers: securityHeaders.filter((h) => h.key !== "Content-Security-Policy"),
    },
  ],
};

export default nextConfig;
