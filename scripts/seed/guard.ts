// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Refuses `npm run db:seed` anywhere but a developer machine or CI: the seed applies the dev mail-server plan, creates
 * demo logins and writes their passwords to credentials.md. A server gets its first administrator from the worker's
 * `job:bootstrap-admin` instead. Returns the reason to refuse, or null. Messages name settings, never their values.
 *
 * - `NODE_ENV=production` refuses unless `--force-dev-seed` (a local production-mode build).
 * - The console must be local: `APP_URL` is `http://` on `localhost`, `*.localhost` or a loopback address. A https
 *   or public host means a real deployment; `--force-dev-seed` never overrides this.
 * - `PLATFORM_DOMAIN`, when set, must be a `.test` domain: a deployment's own domain means a real install.
 */
export function seedRefusal(env: Record<string, string | undefined>, argv: readonly string[]): string | null {
  const force = argv.includes("--force-dev-seed");
  if (env.NODE_ENV === "production" && !force) {
    return "NODE_ENV=production. Pass --force-dev-seed only for a local production-mode build.";
  }
  let app: URL | null;
  try {
    app = env.APP_URL ? new URL(env.APP_URL) : null;
  } catch {
    app = null;
  }
  if (app === null) return "APP_URL is not set to a local console address (http://localhost:<port>).";
  const host = app.hostname.toLowerCase();
  const local =
    host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  if (app.protocol !== "http:" || !local) {
    return "APP_URL is not a local http:// console address (localhost, *.localhost or loopback); this looks like a real deployment.";
  }
  const platform = (env.PLATFORM_DOMAIN ?? "").trim().toLowerCase();
  if (platform !== "" && !platform.endsWith(".test")) {
    return "PLATFORM_DOMAIN is set to a real domain; this looks like a real deployment (leave it unset or use a .test domain in development).";
  }
  return null;
}
