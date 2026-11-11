// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The `new`-tier external-sending hold (ADR-0034 §3): a mailbox whose effective tier is `new` sends only to addresses
 * we host (platform domains and verified customer domains). The webmail checks a send's recipients and a forwarding
 * target with `outsideAddresses`; a held send is refused and recorded as `trust.send_held`, at most once per mailbox per
 * hour, with a count of outside recipients only — never an address (rule 24). The promotion job counts these entries.
 */
import type { TrustTier } from "@anhourmail/shared/sending";

import { DomainError } from "../errors";
import { mutation } from "../mutation";
import type { Deps, RequestMeta } from "../ports";

import { SEND_HELD_ACTION } from "./entity";
import { hostedDomains } from "./standing";

/** What a person is told when the hold stops a send or a forward (ADR-0034 §5). */
export const SENDING_HELD_MESSAGE =
  "New accounts can send to addresses hosted on AnhourMail for now. Sending elsewhere opens automatically once your account is established.";

/**
 * A forward to an outside address set up while the hold applies (`sending_held`; HTTP 422 at set-up). A send the hold
 * stops is answered by the webmail with its own 403 of the same code.
 */
export class SendingHeldError extends DomainError {
  constructor() {
    super(SENDING_HELD_MESSAGE, "sending_held");
  }
}

/** Whether a mailbox with this effective tier is held to addresses we host. */
export const externalHeld = (tier: TrustTier): boolean => tier === "new";

/** How often a held mailbox gets a `trust.send_held` entry, at most. */
export const SEND_HELD_EVERY_MS = 3_600_000;

const domainOf = (address: string): string => address.slice(address.lastIndexOf("@") + 1);

/**
 * The addresses (lowercased, de-duplicated) whose domain we don't host. One without an `@` is outside too: what we
 * can't place is never treated as ours.
 */
export async function outsideAddresses(deps: Deps, addresses: readonly string[]): Promise<string[]> {
  const list = [...new Set(addresses.map((a) => a.trim().toLowerCase()))].filter((a) => a !== "");
  const placed = list.filter((a) => a.includes("@"));
  if (placed.length === 0) return list;
  const hosted = await hostedDomains(
    deps,
    placed.map((a) => domainOf(a)),
  );
  return list.filter((a) => !a.includes("@") || !hosted.has(domainOf(a)));
}

export type SendHeldInput = {
  /** The held mailbox (its account gets the entry). */
  address: string;
  /** The mailbox the person sends with (the held one, or their own for a send from a mailbox shared with them). */
  actorAddress: string;
  /** How many recipients were outside (a count only). */
  externalRecipients: number;
};

/**
 * Records `trust.send_held` (denied, `sending_held`) in the held mailbox's account log unless that mailbox already has
 * one from the last hour. True when an entry was written; false when it was throttled or we don't hold the address.
 */
export async function recordSendHeld(deps: Deps, input: SendHeldInput, req: RequestMeta): Promise<boolean> {
  const address = input.address.trim().toLowerCase();
  const since = new Date(deps.clock.now().getTime() - SEND_HELD_EVERY_MS);
  const found = await deps.uow.run(async (r) => {
    const row = await r.trust.standingByAddress(address);
    if (!row) return null;
    const recent = await r.audit.list({
      scope: `account:${row.accountId}`,
      action: SEND_HELD_ACTION,
      targetId: row.mailboxId,
      from: since,
      limit: 1,
    });
    return { accountId: row.accountId, mailboxId: row.mailboxId, recent: recent.length > 0 };
  });
  if (!found || found.recent) return false;
  const count = Number.isFinite(input.externalRecipients) ? Math.max(0, Math.trunc(input.externalRecipients)) : 0;
  await mutation(
    deps,
    { kind: "system", name: input.actorAddress.trim().toLowerCase() },
    req,
    {
      action: "trust.send_held",
      permission: "mailbox.read",
      accountId: found.accountId,
      target: { type: "mailbox", id: found.mailboxId, label: address },
    },
    async () => ({ result: undefined, meta: { externalRecipients: count }, denied: { code: "sending_held" } }),
  );
  return true;
}
