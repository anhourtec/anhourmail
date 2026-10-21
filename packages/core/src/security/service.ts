// SPDX-License-Identifier: AGPL-3.0-only
import type { Actor } from "../actor";
import type { AuditAction } from "../audit/catalogue";
import { maskEmail } from "../audit/record";
import { mutation } from "../mutation";
import type { Deps, RequestMeta } from "../ports";

/**
 * Audits a security event raised by the identity adapter (password reset requested/completed, …). Goes through
 * `mutation()` like every write, as a system actor; the email is stored masked.
 */
export async function recordSecurityEvent(
  deps: Deps,
  input: { action: AuditAction; userId: string; email: string; meta?: Record<string, unknown> },
  req: RequestMeta,
): Promise<void> {
  const actor: Actor = { kind: "system", name: "identity" };
  await mutation(
    deps,
    actor,
    req,
    {
      action: input.action,
      permission: "self.profile.read",
      accountId: null,
      target: { type: "user", id: input.userId, label: maskEmail(input.email) },
    },
    async () => ({ result: undefined, meta: input.meta ?? {} }),
  );
}
