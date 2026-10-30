// SPDX-License-Identifier: AGPL-3.0-only
import { generateMailboxPassword } from "@anhourmail/shared/security";

import type { Deps, Repositories } from "../ports";
import type { Mailbox } from "./entity";
import { hashMailboxPassword, type PasswordHasher } from "./password-hash";

/**
 * Turns a person's sign-in to one of their mailboxes off and makes the mailbox person-less (a shared mailbox), inside
 * the caller's unit of work. Used when the person leaves the account (`removeMember`) and by "Convert to shared mailbox"
 * (`convertMailboxToShared`), so both behave the same (ADR-0026 §3, 07-security.md "Leavers"):
 *
 * - the owner link is released (conditional: nothing happens, and null is returned, if it no longer belongs to them);
 * - a new generated password that nobody is shown replaces theirs: its argon2id hash waits for the worker's
 *   `mailbox.password` job with the management proxy's grant, and the mail server then ends every webmail session and
 *   OAuth token derived from the old one. Not a first-sign-in change (nobody signs in with it). A mailbox being deleted
 *   (or not yet on the mail server) keeps it waiting for a restore, which applies it before the mailbox comes back on;
 * - the mailbox's app passwords are revoked (`app_password.revoke`): they don't depend on the password, and they are
 *   credentials the person holds.
 *
 * The generated password is never returned, stored, logged or audited (rule 23).
 */
export async function releaseMailboxOwner(
  deps: Deps,
  repos: Repositories,
  hasher: PasswordHasher,
  m: Mailbox,
  userId: string,
): Promise<{ appPasswordsRevoked: number } | null> {
  if (!(await repos.mailboxes.releaseOwner(m.id, userId))) return null;
  const now = deps.clock.now();
  const phc = await hashMailboxPassword(hasher, generateMailboxPassword());
  const grant =
    m.stalwartId === null ? null : (hasher.grant?.({ externalId: m.stalwartId, passwordHash: phc }) ?? null);
  await repos.mailboxPasswords.setPending(m.id, phc, grant);
  await repos.mailboxes.setPasswordChangeRequired(m.id, false);
  if (m.stalwartId !== null && m.status !== "deleting") {
    await repos.provisioning.enqueue({ kind: "mailbox.password", subjectId: m.id, runAfter: now });
  }
  const moved = await repos.appPasswords.markRevoking(m.id, null);
  if (moved.length > 0) {
    await repos.provisioning.enqueue({ kind: "app_password.revoke", subjectId: m.id, runAfter: now });
  }
  return { appPasswordsRevoked: moved.length };
}
