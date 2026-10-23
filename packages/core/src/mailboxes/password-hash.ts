// SPDX-License-Identifier: AGPL-3.0-only
import { MAILBOX_PASSWORD_PHC, mailboxPasswordProblem } from "@anhourmail/shared/security";

import { ValidationError } from "../errors";

/**
 * Hashes a mailbox password (adapter: argon2id at the OWASP baseline, `@anhourmail/adapters/auth`) and, in the web
 * app, signs the grant that lets the management proxy accept the worker's replacement of an existing account's
 * password (`grant`: HMAC with a key only the web app and the proxy hold; null where no key is configured, e.g. dev).
 */
export type PasswordHasher = {
  hash(password: string): Promise<string>;
  grant?: (input: { externalId: string; passwordHash: string }) => string | null;
};

/** Checks `input` against the mailbox password rules (`@anhourmail/shared/security`) for `address`; the password. */
export function mailboxPassword(input: unknown, address: string): string {
  if (typeof input !== "string" || input === "") throw new ValidationError("Choose a password for the mailbox.");
  const problem = mailboxPasswordProblem(input, address);
  if (problem) throw new ValidationError(problem);
  return input;
}

/** The PHC string for a checked password. Refuses anything that isn't argon2id (the mail server stores it as is). */
export async function hashMailboxPassword(hasher: PasswordHasher, password: string): Promise<string> {
  const phc = await hasher.hash(password);
  if (!MAILBOX_PASSWORD_PHC.test(phc)) {
    throw new Error("mailbox password hasher must produce an argon2id PHC string at the pinned parameters");
  }
  return phc;
}
