// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Builds the billing provider the environment asks for (ADR-0029 §3): none (`off`), the fake (dev and tests, state in
 * Redis so the web app and the worker share it) or the payment processor. Composition roots call it; the services only
 * see the `BillingProvider` port.
 */
import type { BillingProvider } from "@anhourmail/core/billing";

import {
  createFakeBillingProvider,
  type FakeStoreRedis,
  fakeWebhookSecret,
  redisFakeBillingStore,
} from "../billing-fake";
import {
  billingProviderKind,
  billingSettingsProblems,
  createStripeBillingProvider,
  stripeConfig,
} from "../billing-stripe";

export { billingProviderKind, type BillingProviderKind, billingSettingsProblems } from "../billing-stripe";

export type BillingProviderDeps = {
  env: Record<string, string | undefined>;
  /** The console origin (fake checkout and portal pages). */
  appUrl: string;
  /** Dev secret the fake's webhook secret is derived from (BETTER_AUTH_SECRET in dev). */
  fakeSeed: string;
  /** Redis for the fake's shared state. */
  redis: () => FakeStoreRedis;
};

/** The configured provider, or null when billing is off. Throws (naming settings only) on a refused configuration. */
export function createBillingProvider(deps: BillingProviderDeps): BillingProvider | null {
  const problems = billingSettingsProblems(deps.env);
  if (problems.length > 0) throw new Error(`Billing configuration refused: ${problems.join("; ")}`);
  switch (billingProviderKind(deps.env)) {
    case "off":
      return null;
    case "fake":
      return createFakeBillingProvider({
        store: redisFakeBillingStore(deps.redis()),
        appUrl: deps.appUrl,
        webhookSecret: fakeWebhookSecret(deps.fakeSeed),
        ...(deps.env.NODE_ENV === undefined ? {} : { nodeEnv: deps.env.NODE_ENV }),
      });
    case "stripe":
      return createStripeBillingProvider(stripeConfig(deps.env));
  }
}
