// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";

import type { Actor } from "../actor";
import { mutation } from "../mutation";
import { loginNames, normaliseEmail } from "../people/entity";
import type { Deps, RequestMeta } from "../ports";

/** The system actor recorded on the audit entry. */
export const BOOTSTRAP_ACTOR: Actor = { kind: "system", name: "bootstrap-admin" };

/** How long the set-password link works (the same hour as a console password reset). */
export const SET_PASSWORD_LINK_MINUTES = 60;

export type BootstrapOutcome =
  | { status: "created"; userId: string; email: string; token: string; expiresAt: Date }
  /** `admin_exists`: someone already holds a platform role. `login_exists`: the email already has a console login. */
  | { status: "refused"; reason: "admin_exists" | "login_exists" };

/**
 * Creates the first platform Global Administrator on a fresh install: a console login with a verified email and no
 * password, the `global_admin` role, and a single-use set-password token (returned once, for the caller to email;
 * never stored in the audit entry or logged). Refuses — audited as `denied` — when anyone already holds a platform
 * role, so it can't be used to add administrators later, and when the email already has a login, so an account someone
 * signed up for in advance can't be promoted. Runs as the system actor from the worker job `job:bootstrap-admin`.
 */
export async function bootstrapPlatformAdmin(
  deps: Deps,
  input: { email?: unknown; firstName?: unknown; lastName?: unknown },
  req: RequestMeta,
): Promise<BootstrapOutcome> {
  const email = normaliseEmail(input.email);
  const names = loginNames(input);
  return mutation<BootstrapOutcome>(
    deps,
    BOOTSTRAP_ACTOR,
    req,
    {
      action: "platform.admin_bootstrapped",
      permission: "platform.staff.manage",
      accountId: null,
      target: { type: "user", label: email },
    },
    async (repos) => {
      await repos.staff.lockBootstrap();
      if (await repos.staff.anyPlatformRole()) {
        return {
          result: { status: "refused", reason: "admin_exists" },
          denied: { code: "admin_exists" },
        };
      }
      if (await repos.people.userByEmail(email)) {
        return {
          result: { status: "refused", reason: "login_exists" },
          denied: { code: "login_exists" },
        };
      }
      const { id } = await repos.staff.createLogin({ email, ...names });
      await repos.staff.grantRole(id, "global_admin", "bootstrap");
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(deps.clock.now().getTime() + SET_PASSWORD_LINK_MINUTES * 60_000);
      await repos.staff.issuePasswordSetToken(id, token, expiresAt);
      return {
        result: { status: "created", userId: id, email, token, expiresAt },
        target: { id },
        meta: { role: "global_admin", linkExpiresAt: expiresAt.toISOString() },
      };
    },
  );
}
