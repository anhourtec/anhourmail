// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What every person-facing billing service shares (ADR-0029 §9): the provider and URLs it may use, refusals that are
 * audited as denied (rule 46), act-as refused (ADR-0023), the password step-up for cancelling and refunds (ADR-0028),
 * and provider calls whose errors become house errors without leaking the provider's text. Provider calls always come
 * before our own unit of work: our state follows from the sync, so a crash between the two heals on the next sync.
 */
import type { Actor } from "../actor";
import { DomainError, ForbiddenError, StepUpRequiredError } from "../errors";
import { mutation, type MutationSpec } from "../mutation";
import type { Deps, RequestMeta } from "../ports";

import { BillingError } from "./entitlements";
import { type BillingProvider, BillingProviderError } from "./ports";

/**
 * What the composition root gives the billing services: the provider (null = billing off), the console origin the
 * checkout and portal return to, and the only origins a provider URL may have (no open redirect: the processor's
 * checkout and portal hosts, or the fake's own `/dev/billing` pages on the console origin).
 */
export type BillingContext = {
  provider: BillingProvider | null;
  appUrl: string;
  redirectOrigins: readonly string[];
};

/** The console session, for the step-up check. */
export type BillingSession = { sessionId: string | null };

export const billingTarget = (accountId: string) => ({ type: "account_billing", id: accountId });

/** Records the refusal as `denied` with `code` in the account's log, then throws `err`. */
export async function refuse(
  deps: Deps,
  actor: Actor,
  req: RequestMeta,
  spec: MutationSpec,
  code: string,
  err: Error,
): Promise<never> {
  await mutation(deps, actor, req, spec, async () => ({ result: undefined, denied: { code } }));
  throw err;
}

/** Staff acting as someone see billing and change nothing (ADR-0023): 403, audited `act_as`. */
export async function refuseActAs(deps: Deps, actor: Actor, req: RequestMeta, spec: MutationSpec): Promise<void> {
  if (actor.kind === "user" && actor.actingAs) {
    await refuse(
      deps,
      actor,
      req,
      spec,
      "act_as",
      new ForbiddenError("Billing can't be changed while acting as someone."),
    );
  }
}

export const unavailable = (): BillingError =>
  new BillingError("billing_unavailable", "Payments aren't available right now. Try again in a few minutes.");

/** Billing off (`BILLING_PROVIDER=off`): 503 `billing_unavailable`, audited as denied. */
export async function requireProvider(
  deps: Deps,
  actor: Actor,
  req: RequestMeta,
  spec: MutationSpec,
  ctx: BillingContext,
): Promise<BillingProvider> {
  if (ctx.provider) return ctx.provider;
  return refuse(deps, actor, req, spec, "billing_unavailable", unavailable());
}

/** A fresh password step-up on this console session (ADR-0028), else 403 `step_up_required`, audited as denied. */
export async function requireStepUp(
  deps: Deps,
  actor: Actor,
  req: RequestMeta,
  spec: MutationSpec,
  session: BillingSession,
): Promise<void> {
  const fresh =
    actor.kind === "user" &&
    session.sessionId !== null &&
    (await deps.uow.run((r) => r.security.stepUpFresh(actor.userId, session.sessionId ?? "", deps.clock.now())));
  if (!fresh) await refuse(deps, actor, req, spec, "step_up_required", new StepUpRequiredError());
}

/**
 * The house error for a provider failure: a declined card is 402 `card_declined`; an outage or the provider's rate
 * limit is 503 `billing_unavailable` (nothing changed: try again); anything else stays a server error. The provider's
 * own message is never passed on (it can echo what we sent).
 */
export function providerError(err: unknown): Error {
  if (!(err instanceof BillingProviderError)) return err instanceof Error ? err : new Error(String(err));
  if (err.code === "card_declined") {
    return new BillingError("card_declined", "The card was declined. Update the payment method and try again.");
  }
  if (err.retryable) return unavailable();
  return err;
}

/**
 * Runs one provider call for a person's request. A failure is audited as `failed` with the house error's code (the
 * provider's message is never recorded) and rethrown as that error.
 */
export async function callProvider<T>(
  deps: Deps,
  actor: Actor,
  req: RequestMeta,
  spec: MutationSpec,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const mapped = providerError(err);
    const code = mapped instanceof DomainError ? mapped.code : "provider_error";
    // Recorded through mutation(), which audits a throw as failed (rule 46) and rethrows it.
    await mutation(deps, actor, req, spec, async () => {
      throw mapped instanceof DomainError ? mapped : new BillingProviderAuditError(code);
    }).catch(() => undefined);
    throw mapped;
  }
}

/** Carries a non-house provider failure's code into the failed audit entry (never its message). */
class BillingProviderAuditError extends DomainError {
  constructor(code: string) {
    super("The payment provider refused the request.", code);
  }
}

/**
 * A URL from the provider is used only when its origin is one we expect (no open redirect: ADR-0029 §2). Anything
 * else is a server error, logged by the route without the URL.
 */
export function assertRedirect(ctx: BillingContext, url: string): string {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    throw new Error("billing provider returned an invalid URL");
  }
  if (!ctx.redirectOrigins.includes(origin)) throw new Error("billing provider returned an unexpected URL origin");
  return url;
}

/** The console's billing page for an account (checkout and portal return there). */
export const billingPageUrl = (ctx: BillingContext, accountId: string, query = ""): string =>
  `${ctx.appUrl.replace(/\/+$/, "")}/accounts/${encodeURIComponent(accountId)}/billing${query}`;
