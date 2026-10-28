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
 * Baseline headers for every response. No Content-Security-Policy here: src/proxy.ts sets the one policy each
 * response carries (a nonce policy for console and webmail pages, a data-only one for the console API), and the
 * webmail API sets its own per response. A config header of the same name would replace those.
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), interest-cohort=()" },
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
  // Dev only: no persistent Turbopack cache for this app. Twice on 2026-10-23 the on-disk dev cache got into a state
  // where every page load triggered an HMR "restart" of the entry chunk list and an endless "HMR hash mismatch" reload
  // (a clean cache on the same tree loaded once). Cold dev starts compile from scratch instead.
  // `authInterrupts`: `forbidden()` in console layouts, so a page a role lacks answers 403 (server/route-guard.ts).
  experimental: { turbopackFileSystemCacheForDev: false, authInterrupts: true },
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
  headers: async () => [{ source: "/:path*", headers: securityHeaders }],
};

export default nextConfig;
