// SPDX-License-Identifier: AGPL-3.0-only
/**
 * One app, two origins (ADR-0003): `app.*` is the console, `mail.*` is the webmail. They never share a
 * session cookie (host-only cookies). Pure function so it can be unit-tested; src/proxy.ts applies it.
 *
 * Dev: everything is on localhost (or a LAN IP), told apart by port — the webmail port (WEBMAIL_DEV_PORT,
 * forwarded by scripts/dev-mail-proxy.mjs) is the webmail origin. On any other dev host the webmail is also at
 * `/webmail`. Browsers don't scope cookies by port, so in dev the two origins share a cookie jar; the webmail
 * session uses its own cookie name (phase 4) so they never collide.
 */
export type HostDecision = { action: "next" } | { action: "rewrite"; path: string } | { action: "not_found" };

const ANY_HOST = [/^\/api\/health(\/|$)/, /^\/_next\//, /^\/favicon\.ico$/];

export function hostKind(host: string, webmailDevPort?: string): "mail" | "app" | "bare" {
  const [name = "", port] = host.toLowerCase().split(/:(?=\d+$)/);
  if (webmailDevPort !== undefined && port === webmailDevPort) return "mail";
  if (name.startsWith("mail.")) return "mail";
  if (name.startsWith("app.")) return "app";
  return "bare";
}

export function routeHost(host: string, pathname: string, production: boolean, webmailDevPort?: string): HostDecision {
  if (ANY_HOST.some((re) => re.test(pathname))) return { action: "next" };
  const kind = hostKind(host, production ? undefined : webmailDevPort);
  const isWebmailPath = pathname === "/webmail" || pathname.startsWith("/webmail/");

  if (kind === "mail") {
    if (pathname.startsWith("/api/")) return { action: "not_found" };
    if (isWebmailPath) return { action: "next" };
    return { action: "rewrite", path: `/webmail${pathname === "/" ? "" : pathname}` };
  }
  if (isWebmailPath) return production || kind === "app" ? { action: "not_found" } : { action: "next" };
  return { action: "next" };
}
