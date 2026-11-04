// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

import type { Deps, RequestMeta } from "../ports";
import { recordSecurityEvent } from "../security/service";
import { signUpClient } from "./network";
import type { PowClaim } from "./proof-of-work";

/** How long one network (IPv4 /24, IPv6 /48) and reason keep their single audit entry (every refusal is logged). */
export const REFUSAL_AUDIT_WINDOW_MS = 3600_000;

export type SignUpRefusal =
  | { code: "proof_of_work"; reason: string }
  | { code: "sign_up_attempts"; reason: "attempts_hour" }
  | {
      code: "sign_up_limited";
      reason: "address_hour" | "address_day" | "network_hour" | "network_day" | "network56_day" | "network48_day";
    };

/**
 * Records a refused sign-up (ADR-0031) as `auth.sign_up_refused` `denied` in the platform log, with the client
 * address (like every signed-out event) and the reason in `meta`; never an email address, name or the challenge.
 * At most one entry per network (IPv4 /24, IPv6 /48) and reason per hour (`once`), so a flood — even one rotating
 * addresses inside an IPv6 /48 — can't grow the audit chain: the route logs every refusal. Returns whether an entry
 * was written. Errors propagate (the caller logs them).
 */
export async function recordSignUpRefusal(
  deps: Deps,
  once: PowClaim,
  refusal: SignUpRefusal,
  req: RequestMeta,
): Promise<boolean> {
  const who = createHash("sha256").update(signUpClient(req.ip).audit).digest("base64url").slice(0, 22);
  if (!(await once(`am:sign-up-refused:${who}:${refusal.reason}`, REFUSAL_AUDIT_WINDOW_MS))) return false;
  await recordSecurityEvent(
    deps,
    {
      action: "auth.sign_up_refused",
      userId: null,
      email: null,
      by: "identity",
      denied: refusal.code,
      meta: { reason: refusal.reason },
    },
    { ...req, userAgent: null },
  );
  return true;
}
