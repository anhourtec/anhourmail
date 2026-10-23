// SPDX-License-Identifier: AGPL-3.0-only
import { type NextRequest, NextResponse } from "next/server";

import { newNonce, SITE_API_CSP, siteCsp } from "./lib/csp";

/**
 * The one place the site's Content-Security-Policy is set (next.config sets none, so a response never carries two).
 * Pages get a per-request nonce policy: Next applies the nonce to its own scripts when it sees it in the request's
 * CSP header, and the root layout passes `x-nonce` to the theme script. That makes every page render per request —
 * the price of a strict policy, since a prerendered page can't carry a fresh nonce.
 */
export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  // The nonce header is ours alone: never let a client supply one (the root layout reads it).
  const headers = new Headers(request.headers);
  headers.delete("x-nonce");
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    const res = NextResponse.next({ request: { headers } });
    res.headers.set("Content-Security-Policy", SITE_API_CSP);
    return res;
  }
  const nonce = newNonce();
  const csp = siteCsp(nonce, process.env.NODE_ENV !== "production");
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
