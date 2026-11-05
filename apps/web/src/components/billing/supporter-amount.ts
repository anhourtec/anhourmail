// SPDX-License-Identifier: AGPL-3.0-only
import { BILLING, type Currency, formatPrice, PLANS } from "@anhourmail/shared/plans";

/**
 * What's wrong with a Supporter amount typed in whole currency units, or null: the same rule the server applies
 * (`supporterAmountProblem`: whole units from the Supporter minimum to `BILLING.supporterMaximum`). The page checks it
 * as the person types; the server decides.
 */
export function supporterAmountError(currency: Currency, typed: string): string | null {
  const text = typed.trim();
  if (!/^\d+$/.test(text)) return "Enter a whole amount (no cents).";
  const minor = Number(text) * 100;
  const min = PLANS.supporter.price?.[currency] ?? 0;
  const max = BILLING.supporterMaximum[currency];
  if (minor < min || minor > max) {
    return `Choose an amount from ${formatPrice(min, currency)} to ${formatPrice(max, currency)} a ${BILLING.interval}.`;
  }
  return null;
}
