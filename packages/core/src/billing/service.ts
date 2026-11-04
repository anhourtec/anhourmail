// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Billing services that take an actor (ADR-0029 §9). Each checks permission and scope itself (unknown account → 404,
 * missing permission → 403) and audits through `mutation()`, refusals included. Slice 7: the staff override of an
 * account's address ceiling. Checkout, portal, changes and refunds come in later slices.
 */
import type { Actor } from "../actor";
import { ForbiddenError, NotFoundError, StepUpRequiredError, ValidationError } from "../errors";
import { authorizeAudited, mutation, type MutationOutcome } from "../mutation";
import type { Deps, RequestMeta } from "../ports";

import { defaultBilling } from "./lifecycle";

const isId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/** Highest override staff may set (a typo guard, not a policy). */
export const ADDRESS_CEILING_OVERRIDE_MAX = 1_000_000;

type Session = { sessionId: string | null };
type Refusal = "act_as" | "step_up_required";

/** A whole number from 1 to the maximum, or null to go back to the configured ceiling; anything else is a 400. */
export function parseCeilingOverride(input: unknown): number | null {
  if (input === null) return null;
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1 || input > ADDRESS_CEILING_OVERRIDE_MAX) {
    throw new ValidationError(
      `Set a whole number of addresses from 1 to ${String(ADDRESS_CEILING_OVERRIDE_MAX)}, or null for the default.`,
    );
  }
  return input;
}

/**
 * Staff (`platform.billing.manage` ★, Global and Billing Administrators): sets or clears an account's address ceiling
 * override (ADR-0029 §7), with a fresh step-up, never while acting as someone. Audited `billing.ceiling_changed` by staff
 * in the account's own log (rule 49), saying only that the limit was set or reset (the ceiling is not published,
 * rule 33), with the numbers in the platform copy. Unknown account → 404 (audited in the platform log); bad value → 400.
 */
export async function setAddressCeilingOverride(
  deps: Deps,
  actor: Actor,
  accountId: string,
  input: { ceiling?: unknown },
  session: Session,
  req: RequestMeta,
): Promise<{ ceiling: number | null }> {
  const base = { action: "billing.ceiling_changed", permission: "platform.billing.manage" } as const;
  const platformSpec = { ...base, accountId: null, target: { type: "account" } };
  await authorizeAudited(deps, actor, req, platformSpec);
  const account = isId(accountId) ? await deps.uow.run((r) => r.accounts.get(accountId)) : null;
  if (!account) {
    await mutation(deps, actor, req, platformSpec, async () => ({ result: undefined, denied: { code: "not_found" } }));
    throw new NotFoundError();
  }
  const ceiling = parseCeilingOverride(input.ceiling);
  const out = await mutation(
    deps,
    actor,
    req,
    { ...base, accountId, target: { type: "account", id: accountId, label: account.name }, staffPath: true },
    async (repos): Promise<MutationOutcome<Refusal | { ceiling: number | null }>> => {
      if (actor.kind !== "user") throw new ForbiddenError();
      if (actor.actingAs) return { result: "act_as", denied: { code: "act_as" } };
      if (
        !session.sessionId ||
        !(await repos.security.stepUpFresh(actor.userId, session.sessionId, deps.clock.now()))
      ) {
        return { result: "step_up_required", denied: { code: "step_up_required" } };
      }
      await repos.accounts.lock(accountId);
      const now = deps.clock.now();
      const current = (await repos.billing.get(accountId)) ?? defaultBilling(accountId, account.plan, now);
      await repos.billing.save({ ...current, addressCeilingOverride: ceiling, updatedAt: now });
      return {
        result: { ceiling },
        meta: { override: ceiling === null ? "reset" : "set" },
        copies: [{ accountId: null, meta: { accountId, from: current.addressCeilingOverride, set: ceiling } }],
      };
    },
  );
  if (out === "act_as") throw new ForbiddenError("Billing can't be changed while acting as someone.");
  if (out === "step_up_required") throw new StepUpRequiredError();
  return out;
}
