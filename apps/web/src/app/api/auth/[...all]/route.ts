// SPDX-License-Identifier: AGPL-3.0-only
import { authRouteHandlers } from "@anhourmail/adapters/auth";
import type { LimitName } from "@anhourmail/server/rate-limit";

import { auth } from "@/server/auth/instance";
import { authEndpoint } from "@/server/auth/endpoints";
import { route } from "@/server/http/route";

/**
 * better-auth endpoints, allow-listed (`server/auth/endpoints.ts`): anything else answers 404, so plugin endpoints we
 * replace with audited services (sessions, passkey rename/remove) can't be called around them. Each endpoint has its
 * rate-limit tier: `auth` by default (fail-closed), `authFactor` for second sign-in steps, `sensitive` for factor
 * changes.
 */
const handlers = () => authRouteHandlers(auth());

const notFound = () => Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });

const byTier = (method: "GET" | "POST") => {
  const make = (limit: LimitName) =>
    route(async ({ req }) => (authEndpoint(method, new URL(req.url).pathname) ? handlers()[method](req) : notFound()), {
      limit,
    });
  const tiers = { auth: make("auth"), authFactor: make("authFactor"), sensitive: make("sensitive") };
  return (req: Request, ctx: { params: Promise<{ all: string[] }> }) =>
    tiers[authEndpoint(method, new URL(req.url).pathname)?.tier ?? "auth"](req, ctx);
};

export const GET = byTier("GET");
export const POST = byTier("POST");
