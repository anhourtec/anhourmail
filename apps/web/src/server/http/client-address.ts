// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { headers } from "next/headers";

import { clientIp } from "@anhourmail/server/client-ip";
import { requestContext } from "@anhourmail/server/request-context";

/**
 * The trusted client address of the request being served, for forwarding to internal services (the mail server
 * counts limits and failed sign-ins per client): what `route()` derived for an API route, else the page request's own
 * headers through the same trusted-proxy rule (`clientIp`, TRUST_PROXY). Null when there is none, or outside a request.
 * Never logged.
 */
export async function currentClientAddress(): Promise<string | null> {
  const ctx = requestContext();
  // `route()` has decided (its answer may be null: no trusted address).
  if (ctx && "clientIp" in ctx) return ctx.clientIp ?? null;
  try {
    return clientIp(await headers());
  } catch {
    // Not inside a request (background work): no address.
    return null;
  }
}
