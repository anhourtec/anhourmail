// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { mailboxPasswordHasher } from "@anhourmail/adapters/auth";
import type { PasswordHasher } from "@anhourmail/core/mailboxes";
import { mailboxPasswordGrant } from "@anhourmail/stalwart-client";

/**
 * Mailbox passwords: argon2id hashing, and (when the key is configured — always in production) the grant the
 * management proxy needs before it lets the worker replace an existing account's password with exactly that hash.
 */
export function mailboxPasswords(grantKey: string | undefined): PasswordHasher {
  const key = grantKey?.trim() ?? "";
  return {
    hash: mailboxPasswordHasher.hash,
    grant: ({ externalId, passwordHash }) => (key === "" ? null : mailboxPasswordGrant(key, externalId, passwordHash)),
  };
}
