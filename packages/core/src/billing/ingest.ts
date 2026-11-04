// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Webhook ingestion (ADR-0029 §4): a verified provider event is a trigger, never data. In one unit of work it is
 * resolved to an account by its provider customer, recorded once by provider event id (no payload is stored), and, if
 * new, the account's `billing.sync` is queued (one queued job per account at most). An event whose account we can't
 * tell is kept as an orphan for the worker and staff, never dropped.
 *
 * Not a service and not audited (ADR-0029 §12): it changes nothing a customer or staff member did; every change it
 * leads to is audited by the sync. Unauthenticated noise is stopped earlier by the signature check.
 */
import type { Deps } from "../ports";

import { DISPUTE_EVENT_TYPES, HANDLED_EVENT_TYPES, type ProviderEvent } from "./ports";

export type IngestOutcome =
  /** Recorded and the account's sync queued. */
  | "queued"
  /** Recorded without an account: a dispute (resolved by the worker with the provider) or an unknown customer. */
  | "orphan"
  /** Already recorded (a redelivery): nothing done. */
  | "duplicate"
  /** A type we don't handle: answered and dropped, nothing stored. */
  | "ignored";

/**
 * Records one verified event. A database failure throws (the route answers 500 and the provider retries for days);
 * every other path answers 200. The metadata hint is a cross-check only: when it names a different account than the
 * customer's, the event is an orphan for staff, and no account is synced on its say-so.
 */
export async function ingestBillingEvent(deps: Deps, event: ProviderEvent, receivedAt: Date): Promise<IngestOutcome> {
  if (!HANDLED_EVENT_TYPES.includes(event.type)) return "ignored";
  return deps.uow.run(async (r) => {
    const owner = event.customerId === null ? null : await r.billing.byCustomerId(event.customerId);
    const agrees = owner !== null && (event.accountIdHint === null || event.accountIdHint === owner.accountId);
    const accountId = agrees ? owner.accountId : null;
    const id = await r.billing.recordEvent({
      providerEventId: event.id,
      type: event.type,
      accountId,
      objectId: event.objectId,
      providerCreatedAt: event.createdAt,
      receivedAt,
    });
    if (id === null) return "duplicate";
    if (accountId !== null) {
      await r.provisioning.enqueue({ kind: "billing.sync", subjectId: accountId, runAfter: receivedAt });
      return "queued";
    }
    // A dispute names only its payment: the worker asks the provider whose it is (`billing.resolve`), so a dispute
    // restricts within seconds rather than at the nightly reconcile. Other orphans (an unknown customer, a hint that
    // disagrees) wait for staff.
    if (DISPUTE_EVENT_TYPES.includes(event.type) && owner === null) {
      await r.provisioning.enqueue({ kind: "billing.resolve", subjectId: id, runAfter: receivedAt });
    }
    return "orphan";
  });
}
