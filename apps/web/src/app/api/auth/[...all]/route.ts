// SPDX-License-Identifier: AGPL-3.0-only
import { authRouteHandlers } from "@anhourmail/adapters/auth";
import type { LimitName } from "@anhourmail/server/rate-limit";

import { auth, signUpOpen } from "@/server/auth/instance";
import { authEndpoint } from "@/server/auth/endpoints";
import {
  type AdmittedCode,
  admitSignUpCode,
  releaseAdmittedCode,
  signUpCodeOf,
  withSignUpCode,
} from "@/server/auth/sign-up-code";
import { signUpCreatedLogin, signUpGate } from "@/server/auth/sign-up-gate";
import { route } from "@/server/http/route";

/**
 * better-auth endpoints, allow-listed (`server/auth/endpoints.ts`): anything else answers 404, so plugin endpoints we
 * replace with audited services (sessions, passkey rename/remove) can't be called around them. Each endpoint has its
 * rate-limit tier: `auth` by default (fail-closed), `authFactor` for second sign-in steps, `sensitive` for factor
 * changes. Open sign-up first passes the sign-up gate (proof-of-work and sign-up limits, ADR-0031).
 */
const handlers = () => authRouteHandlers(auth());

const SIGN_UP = "/api/auth/sign-up/email";

const notFound = () => Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });

const byTier = (method: "GET" | "POST") => {
  const make = (limit: LimitName) =>
    route(
      async ({ req, meta }) => {
        const path = new URL(req.url).pathname;
        if (!authEndpoint(method, path)) return notFound();
        if (method === "POST" && path === SIGN_UP) {
          const open = signUpOpen();
          const code = signUpCodeOf(req);
          // Closed sign-up: only a request carrying an invite code goes further (ADR-0029 §8).
          if (!open && code === null) return notFound();
          const gate = await signUpGate(req, meta);
          if ("refused" in gate) return gate.refused;
          // The account tiers count only a created account: anything else (or a throw) gives them back; a code
          // claimed for this sign-up is given back too.
          let created = false;
          let admitted: AdmittedCode | null = null;
          try {
            // The code is claimed after the proof and the limits, never instead of them; the claim is the admission.
            if (code !== null) {
              const a = await admitSignUpCode(req, code, meta, open);
              if ("refused" in a) return a.refused;
              admitted = a.admitted;
            }
            const claim = admitted;
            const res = claim
              ? await withSignUpCode(claim, () => handlers()[method](req))
              : await handlers()[method](req);
            // A duplicate address answers 200 too (no enumeration): only a real new login counts as created.
            created = await signUpCreatedLogin(res);
            return res;
          } finally {
            await gate.settle(created);
            if (admitted && !created) await releaseAdmittedCode(admitted, meta);
          }
        }
        return handlers()[method](req);
      },
      { limit },
    );
  const tiers = { auth: make("auth"), authFactor: make("authFactor"), sensitive: make("sensitive") };
  return (req: Request, ctx: { params: Promise<{ all: string[] }> }) =>
    tiers[authEndpoint(method, new URL(req.url).pathname)?.tier ?? "auth"](req, ctx);
};

export const GET = byTier("GET");
export const POST = byTier("POST");
