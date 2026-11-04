// SPDX-License-Identifier: AGPL-3.0-only
import { billingSettingsProblems } from "@anhourmail/adapters/billing";

/**
 * Refuses to start (throws, naming settings only) when the billing settings are wrong (ADR-0029 §3): an unknown
 * `BILLING_PROVIDER`, the fake provider in production, or the processor without its key, webhook secret and price ids.
 */
export function checkBillingSettings(env: Record<string, string | undefined> = process.env): void {
  const problems = billingSettingsProblems(env);
  if (problems.length > 0) throw new Error(`Worker configuration refused: ${problems.join("; ")}`);
}
