// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Settings for the manual live suite (ADR-0029 §10, slice 14): the processor's **test mode** only. Nothing here is in
 * the repository: the key and the price and product ids come from the local `.env` (never CI's, which has none).
 *
 * - No `STRIPE_SECRET_KEY`: the suite skips (the normal case: CI, other machines, `npm test`).
 * - A live key (`sk_live_…`/`rk_live_…`): the run aborts before any request.
 * - A test key with the other settings missing or wrong: the run fails, naming the settings (never their values).
 */
import { billingSettingsProblems, type StripeConfig, stripeConfig } from "@anhourmail/adapters/billing-stripe";

/** Not used by the suite (it receives no webhooks), but the adapter's settings check wants one when none is set. */
const UNUSED_WEBHOOK_SECRET = "whsec_live_suite_unused";

export type LiveSettings = { config: StripeConfig } | { skip: string };

export function liveSettings(env: Record<string, string | undefined> = process.env): LiveSettings {
  const key = (env.STRIPE_SECRET_KEY ?? "").trim();
  if (key === "") return { skip: "STRIPE_SECRET_KEY isn't set (test-mode keys only, from .env)" };
  if (/^(?:sk|rk)_live_/.test(key)) {
    throw new Error("The billing live suite runs with test-mode keys only: STRIPE_SECRET_KEY is a live key. Aborted.");
  }
  const suiteEnv = {
    ...env,
    BILLING_PROVIDER: "stripe",
    NODE_ENV: "test",
    STRIPE_WEBHOOK_SECRET: (env.STRIPE_WEBHOOK_SECRET ?? "").trim() || UNUSED_WEBHOOK_SECRET,
  };
  const problems = billingSettingsProblems(suiteEnv);
  if (problems.length > 0) throw new Error(`Billing live suite settings: ${problems.join("; ")}`);
  const config = stripeConfig(suiteEnv);
  if (config.mode !== "test") throw new Error("The billing live suite runs with test-mode keys only. Aborted.");
  return { config };
}
