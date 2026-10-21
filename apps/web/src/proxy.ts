// SPDX-License-Identifier: AGPL-3.0-only
import { type NextRequest, NextResponse } from "next/server";

import { routeHost } from "./server/host-routing";

/** Host-based routing between console (app.*) and webmail (mail.*). Authorization happens in services. */
export function proxy(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  const decision = routeHost(
    host,
    request.nextUrl.pathname,
    process.env.NODE_ENV === "production",
    process.env.WEBMAIL_DEV_PORT,
  );
  if (decision.action === "rewrite") {
    const url = request.nextUrl.clone();
    url.pathname = decision.path;
    return NextResponse.rewrite(url);
  }
  if (decision.action === "not_found") {
    return new NextResponse("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
