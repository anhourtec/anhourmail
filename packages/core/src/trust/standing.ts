// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What the webmail reads before every send (ADR-0034 §3): the mailbox's effective tier and billing's block, uncached
 * so a staff change applies at once; and which recipient domains we host (platform domains from configuration plus
 * verified customer domains), for the `new`-tier hold. Read-only: they change nothing, so they write no audit entry.
 */
import { type BillingSendBlock, billingBlockOf } from "../billing/send-block";
import type { Deps, Repositories } from "../ports";
import type { TrustTier } from "@anhourmail/shared/sending";

import { mailboxRelayHold } from "./access";
import { effectiveTier } from "./entity";

export type SendingStanding = {
  /** The mailbox's effective tier: its account's, `restricted` while the mailbox itself is restricted. */
  tier: TrustTier;
  billingBlock: BillingSendBlock | null;
  /**
   * The mail server may still hold this mailbox's outside recipients although its tier no longer does: the tier was
   * loosened and the `mailbox.ensure` that takes it off the relay hold hasn't succeeded yet (`relayHoldPending`). The
   * webmail holds such a send itself (ADR-0034 update "the webmail's client address"), so it is refused with a clear
   * message instead of going out with its outside recipients refused one by one.
   */
  heldOnServer: boolean;
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
    const tier = effectiveTier(row.accountTier, row.mailboxRestricted);
    const heldOnServer = !mailboxRelayHold(tier, false) && (await relayHoldPending(r, row.mailboxId, row.tierSince));
    return { tier, billingBlock, heldOnServer };
  });
}

/**
 * Whether the mailbox's `mailbox.ensure` for its account's last tier change hasn't applied yet, so the mail server may
 * still have it on the relay hold. The tier change queues that ensure in its own unit of work (a new job, or one
 * already queued, which then runs with the new tier): applied once a job queued since the change has succeeded;
 * pending while one queued since then hasn't; with none queued since (an earlier queued job was reused), pending
 * until the most recent one succeeds. Unrelated ensures queued later (an alias, a backfill) don't hold the mailbox
 * once the change's own ensure has succeeded. Not covered: a mailbox restriction lifted by staff (no timestamp); its
 * few seconds are refused by the mail server per recipient.
 */
async function relayHoldPending(r: Repositories, mailboxId: string, since: Date): Promise<boolean> {
  const p = await r.provisioning.progressSince("mailbox.ensure", mailboxId, since);
  if (p.succeededSince) return false;
  if (p.queuedSince) return true;
  return p.latest !== null && p.latest !== "succeeded";
}

/**
 * One mailbox's effective tier, by its account and id, in the caller's unit of work (the importer's message cap,
 * ADR-0034 migration step B). A mailbox that isn't the account's, or an unknown account, reads as `restricted`: the
 * strictest, so a lookup that goes wrong never loosens a limit.
 */
export async function mailboxTier(r: Repositories, accountId: string, mailboxId: string): Promise<TrustTier> {
  const account = await r.trust.get(accountId);
  const mailbox = account ? await r.trust.mailbox(accountId, mailboxId) : null;
  if (!account || !mailbox) return "restricted";
  return effectiveTier(account.tier, mailbox.restriction !== null);
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
