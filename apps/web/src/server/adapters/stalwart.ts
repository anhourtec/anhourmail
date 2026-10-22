// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { stalwartAppPasswords } from "@anhourmail/adapters/stalwart";
import type { AppPasswordIssuer } from "@anhourmail/core/app-passwords";
import { stalwart } from "@anhourmail/stalwart-client";

import { MANAGED_SCRIPT } from "../webmail/sieve";
import type { ManagedSieve } from "../webmail/service";

/** Readiness probe for the mail server (rule 21: Stalwart only through its client, behind this adapter). */
export const stalwartReady = (): Promise<void> => stalwart().ready();

/**
 * The webmail's managed Sieve script (automatic replies, forwarding, junk rules) read and written with the
 * management credential, never a user token: customer mailboxes can't write their own Sieve (CUSTOMER_PERMISSIONS,
 * rule 21). `accountId` is the mailbox's JMAP account id.
 */
export function managedSieve(): ManagedSieve {
  return {
    read: (accountId) => stalwart().getSieveScript(accountId, MANAGED_SCRIPT),
    write: (accountId, script) => stalwart().putSieveScript(accountId, MANAGED_SCRIPT, script),
  };
}

let issuer: AppPasswordIssuer | null = null;

/**
 * Issues app passwords on the mail server with the management credential. Creating one runs inside the request:
 * the secret goes back to the person once and is never queued or stored (docs/internal/07-security.md).
 */
export function appPasswordIssuer(): AppPasswordIssuer {
  issuer ??= stalwartAppPasswords(stalwart());
  return issuer;
}
