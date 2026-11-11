// SPDX-License-Identifier: AGPL-3.0-only
import type { TrustTier } from "@anhourmail/shared/sending";

import type { WebmailTrust } from "../service";

/**
 * A fixed trust answer for tests that aren't about tiers: every mailbox has `tier` and no billing block; with
 * `hosted`, addresses on those domains are ours and the rest outside (default: every address is ours). Held sends are
 * collected in `held`.
 */
export function fixedTrust(
  tier: TrustTier = "standard",
  hosted?: readonly string[],
): WebmailTrust & { held: WebmailTrust["held"]; recorded: { address: string; externalRecipients: number }[] } {
  const recorded: { address: string; externalRecipients: number }[] = [];
  return {
    recorded,
    standing: async () => ({ tier, billingBlock: null }),
    outside: async (addresses) =>
      hosted === undefined
        ? []
        : addresses.map((a) => a.toLowerCase()).filter((a) => !hosted.includes(a.slice(a.lastIndexOf("@") + 1))),
    held: async (input) => {
      recorded.push({ address: input.address, externalRecipients: input.externalRecipients });
    },
  };
}
