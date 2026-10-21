// SPDX-License-Identifier: AGPL-3.0-only
import { authRouteHandlers } from "@anhourmail/adapters/auth";

import { auth } from "@/server/auth/instance";
import { route } from "@/server/http/route";

/** better-auth endpoints (sign-in, sign-out, session), behind the fail-closed `auth` rate limit. */
const handlers = () => authRouteHandlers(auth());

export const GET = route(async ({ req }) => handlers().GET(req), { limit: "auth" });
export const POST = route(async ({ req }) => handlers().POST(req), { limit: "auth" });
