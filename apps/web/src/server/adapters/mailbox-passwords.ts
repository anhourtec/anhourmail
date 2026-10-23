// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { mailboxPasswordHasher } from "@anhourmail/adapters/auth";
import type { PasswordHasher } from "@anhourmail/core/mailboxes";
import type { BreachedPasswords } from "@anhourmail/core/security";
import { mailboxPasswordGrant } from "@anhourmail/stalwart-client";

/**
 * Mailbox passwords: argon2id hashing, and (when the key is configured — always in production) the grant the
 * management proxy needs before it lets the worker replace an existing account's password with exactly that hash; and
 * the breached-password check every new mailbox password passes first.
 */
export function mailboxPasswords(grantKey: string | undefined, breaches: BreachedPasswords): PasswordHasher {
  const key = grantKey?.trim() ?? "";
  return {
    hash: mailboxPasswordHasher.hash,
    breaches,
    grant: ({ externalId, passwordHash }) => (key === "" ? null : mailboxPasswordGrant(key, externalId, passwordHash)),
  };
}
