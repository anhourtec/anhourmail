// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { stalwartAppPasswords } from "@anhourmail/adapters/stalwart";
import type { AppPasswordIssuer } from "@anhourmail/core/app-passwords";
import type { ManagedScriptStore } from "@anhourmail/core/webmail";
import { type StalwartManagement, stalwartOperations, verifyStalwartCredential } from "@anhourmail/stalwart-client";

import { MANAGED_SCRIPT } from "../webmail/sieve";
import type { ManagedSieve } from "../webmail/service";

let verified: Promise<void> | null = null;

/**
 * The operations credential, checked once against Stalwart before first use: the key must be exactly its documented
 * set (an operations key that could write accounts is refused). A failed check is retried on the next call.
 */
async function operations(): Promise<StalwartManagement> {
  const mgmt = stalwartOperations();
  verified ??= verifyStalwartCredential("operations", mgmt).then(
    () => undefined,
    (err: unknown) => {
      verified = null;
      throw err;
    },
  );
  await verified;
  return mgmt;
}

/** Readiness probe for the mail server (rule 21: Stalwart only through its client, behind this adapter). */
export const stalwartReady = (): Promise<void> => stalwartOperations().ready();

/**
 * The webmail's managed Sieve script (automatic replies, forwarding, junk rules) read and written with the operations
 * key, never a user token: customer mailboxes can't write their own Sieve (CUSTOMER_PERMISSIONS, rule 21). Writing
 * also makes it the active script; with the state of the read it was based on, only if nothing changed since (JMAP
 * `ifInState`, honoured by the pinned server). `accountId` is the mailbox's JMAP account id.
 */
export function managedSieve(): ManagedSieve {
  return {
    read: async (accountId) => (await operations()).getSieveScript(accountId, MANAGED_SCRIPT),
    write: async (accountId, script, ifInState) =>
      (await operations()).putSieveScript(accountId, MANAGED_SCRIPT, script, ifInState),
  };
}

/** The managed script for the start-up upgrade: reads with the Sieve state, writes only if it is unchanged. */
export function managedSieveStore(): ManagedScriptStore {
  return {
    read: async (accountId) => (await operations()).getSieveScript(accountId, MANAGED_SCRIPT),
    write: async (accountId, script, state) =>
      (await operations()).putSieveScriptIfUnchanged(accountId, MANAGED_SCRIPT, script, state),
  };
}

/**
 * Issues app passwords on the mail server with the operations key. Creating one runs inside the request: the secret
 * goes back to the person once and is never queued or stored (docs/internal/07-security.md).
 */
export function appPasswordIssuer(): AppPasswordIssuer {
  return {
    create: async (input) => stalwartAppPasswords(await operations()).create(input),
    revoke: async (input) => stalwartAppPasswords(await operations()).revoke(input),
  };
}

/**
 * The console → webmail handoff credential (ADR-0024), with the operations key: expired leftovers on the mailbox are
 * cleared first (so they don't hold an app-password slot), then a credential that can only authenticate, for 60 s.
 * The caller uses its secret once and destroys it.
 */
export function handoffCredentials(): {
  mint(externalId: string, ttlMs: number): Promise<{ id: string; secret: string }>;
  destroy(externalId: string, id: string): Promise<void>;
} {
  return {
    async mint(externalId, ttlMs) {
      const mgmt = await operations();
      await mgmt.clearExpiredHandoffCredentials(externalId);
      return mgmt.createHandoffCredential(externalId, ttlMs);
    },
    destroy: async (externalId, id) => (await operations()).destroyAppPassword(externalId, id),
  };
}
