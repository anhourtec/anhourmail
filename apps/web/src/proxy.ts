// SPDX-License-Identifier: AGPL-3.0-only
import { type NextRequest, NextResponse } from "next/server";

import { hostKind, routeHost } from "./server/host-routing";
import { newNonce, webmailCsp } from "./server/webmail/csp";

/**
 * Host-based routing between console (app.*) and webmail (mail.*). Authorization happens in services.
 * Webmail pages also get a per-request nonce CSP (Next applies the nonce to its own scripts when it sees it in the
 * request's CSP header; the root layout passes it to the theme script).
 */
export function proxy(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  const production = process.env.NODE_ENV === "production";
  const pathname = request.nextUrl.pathname;
  const decision = routeHost(host, pathname, production, process.env.WEBMAIL_DEV_PORT);
  if (decision.action === "not_found") {
    return new NextResponse("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }

  const target = decision.action === "rewrite" ? decision.path : pathname;
  const webmailPage =
    (target === "/webmail" || target.startsWith("/webmail/")) &&
    (hostKind(host, production ? undefined : process.env.WEBMAIL_DEV_PORT) === "mail" || !production);
  if (!webmailPage) {
    // The nonce header is ours alone: never let a client supply one (the root layout reads it).
    const clean = new Headers(request.headers);
    clean.delete("x-nonce");
    if (decision.action === "rewrite") {
      const url = request.nextUrl.clone();
      url.pathname = decision.path;
      return NextResponse.rewrite(url, { request: { headers: clean } });
    }
    return NextResponse.next({ request: { headers: clean } });
  }

  const nonce = newNonce();
  const csp = webmailCsp(nonce, !production);
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  let res: NextResponse;
  if (decision.action === "rewrite") {
    const url = request.nextUrl.clone();
    url.pathname = decision.path;
    res = NextResponse.rewrite(url, { request: { headers } });
  } else {
    res = NextResponse.next({ request: { headers } });
  }
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
