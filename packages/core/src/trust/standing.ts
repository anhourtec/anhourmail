// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What the webmail reads before every send (ADR-0034 §3): the mailbox's effective tier and billing's block, uncached
 * so a staff change applies at once; and which recipient domains we host (platform domains from configuration plus
 * verified customer domains), for the `new`-tier hold. Read-only: they change nothing, so they write no audit entry.
 */
import { type BillingSendBlock, billingBlockOf } from "../billing/send-block";
import type { Deps } from "../ports";
import type { TrustTier } from "@anhourmail/shared/sending";

import { effectiveTier } from "./entity";

export type SendingStanding = {
  /** The mailbox's effective tier: its account's, `restricted` while the mailbox itself is restricted. */
  tier: TrustTier;
  billingBlock: BillingSendBlock | null;
};

const MAX_ADDRESS = 254;
/** A DNS name is at most 253 characters; anything longer can't be one of ours. */
const MAX_DOMAIN = 253;

/** The sending standing of the mailbox with this address, or null when we don't hold the address. */
export async function sendingStanding(deps: Deps, address: string): Promise<SendingStanding | null> {
  const key = address.trim().toLowerCase();
  if (key === "" || key.length > MAX_ADDRESS) return null;
  return deps.uow.run(async (r) => {
    const row = await r.trust.standingByAddress(key);
    if (!row) return null;
    const billingBlock = await billingBlockOf(r, row.accountId, row.mailboxId);
    return { tier: effectiveTier(row.accountTier, row.mailboxRestricted), billingBlock };
  });
}

/**
 * Which of these domains (any case, duplicates allowed) we host: the deployment's platform domain and verified
 * customer domains. Returns the hosted ones, lowercased and de-duplicated. Anything else is outside.
 */
export async function hostedDomains(deps: Deps, domains: readonly string[]): Promise<Set<string>> {
  const wanted = [...new Set(domains.map((d) => d.trim().toLowerCase()))].filter(
    (d) => d !== "" && d.length <= MAX_DOMAIN,
  );
  const platform = new Set([deps.platform.domain, deps.platform.freeAddressDomain].map((d) => d.toLowerCase()));
  const hosted = new Set(wanted.filter((d) => platform.has(d)));
  const rest = wanted.filter((d) => !hosted.has(d));
  if (rest.length === 0) return hosted;
  const verified = new Set(await deps.uow.run((r) => r.directory.hostedDomains(rest)));
  for (const d of rest) if (verified.has(d)) hosted.add(d);
  return hosted;
}
