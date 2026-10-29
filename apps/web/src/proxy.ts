// SPDX-License-Identifier: AGPL-3.0-only
import { type NextRequest, NextResponse } from "next/server";

import { API_CSP, consoleCsp } from "./server/console-csp";
import { hostKind, routeHost, WEBMAIL_COOKIE_NAMES, webmailSignedOutRedirect } from "./server/host-routing";
import { newNonce, webmailCsp } from "./server/webmail/csp";

/**
 * Host-based routing between console (app.*) and webmail (mail.*). Authorization happens in services.
 *
 * This is also the one place a page's Content-Security-Policy is set (next.config sets none, so a response never
 * carries two). Console and webmail pages get a per-request nonce policy: Next applies the nonce to its own scripts
 * when it sees it in the request's CSP header, and the root layout passes `x-nonce` to the theme script. Console API
 * responses get the data-only policy; the webmail API (`/api/webmail/*`) sets its own per response (sandboxes for
 * print views, previews and raw sources), and so do console profile photos (`/api/avatars/*`), so the proxy leaves
 * them alone there (`route()` still gives any response without one the data-only policy).
 */
export function proxy(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  const production = process.env.NODE_ENV === "production";
  const pathname = request.nextUrl.pathname;
  const decision = routeHost(host, pathname, production, process.env.WEBMAIL_DEV_PORT);
  if (decision.action === "not_found") {
    const res = new NextResponse("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
    res.headers.set("Content-Security-Policy", API_CSP);
    return res;
  }

  const target = decision.action === "rewrite" ? decision.path : pathname;
  const webmailPage =
    (target === "/webmail" || target.startsWith("/webmail/")) &&
    (hostKind(host, production ? undefined : process.env.WEBMAIL_DEV_PORT) === "mail" || !production);

  if (webmailPage) {
    const signIn = webmailSignedOutRedirect(
      target,
      WEBMAIL_COOKIE_NAMES.some((name) => request.cookies.has(name)),
      hostKind(host, production ? undefined : process.env.WEBMAIL_DEV_PORT) === "mail" ? "" : "/webmail",
    );
    if (signIn) {
      const url = request.nextUrl.clone();
      url.pathname = signIn;
      url.search = "";
      const res = NextResponse.redirect(url, 307);
      res.headers.set("Cache-Control", "no-store");
      return res;
    }
  }

  // The nonce header is ours alone: never let a client supply one (the root layout reads it).
  const headers = new Headers(request.headers);
  headers.delete("x-nonce");
  let csp: string | null = null;
  if (target === "/api" || target.startsWith("/api/")) {
    // Profile photos (`/api/avatars/*`) carry their own sandboxing policy, like the webmail API.
    if (!target.startsWith("/api/webmail/") && target !== "/api/webmail" && !target.startsWith("/api/avatars/")) {
      csp = API_CSP;
    }
  } else {
    const nonce = newNonce();
    csp = webmailPage ? webmailCsp(nonce, !production) : consoleCsp(nonce, !production);
    headers.set("x-nonce", nonce);
    headers.set("Content-Security-Policy", csp);
  }

  let res: NextResponse;
  if (decision.action === "rewrite") {
    const url = request.nextUrl.clone();
    url.pathname = decision.path;
    res = NextResponse.rewrite(url, { request: { headers } });
  } else {
    res = NextResponse.next({ request: { headers } });
  }
  if (csp) res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
