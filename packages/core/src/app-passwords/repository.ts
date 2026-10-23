// SPDX-License-Identifier: AGPL-3.0-only
import type { AppPassword } from "./entity";

/** App password metadata. Reads are scoped to one mailbox; callers have scoped the mailbox to the account first. */
export type AppPasswordRepository = {
  /** Newest first, `revoking` ones included. */
  listByMailbox(mailboxId: string): Promise<AppPassword[]>;
  get(mailboxId: string, id: string): Promise<AppPassword | null>;
  insert(p: AppPassword): Promise<void>;
  /** Moves one (`id`) or every (`null`) active app password of the mailbox to `revoking`; returns those it moved. */
  markRevoking(mailboxId: string, id: string | null): Promise<AppPassword[]>;
  /** The mailbox's app passwords waiting for the worker to revoke them. */
  revoking(mailboxId: string): Promise<AppPassword[]>;
  /** Deletes a row once the mail server no longer has the credential (`revoking` rows only). */
  deleteRevoked(id: string): Promise<void>;
  /**
   * Mailboxes (any account) with app passwords still waiting to be revoked, and whether an `app_password.revoke` job
   * is already queued or running for them (if not, the job gave up and the reconciler queues it again).
   */
  mailboxesWithRevoking(): Promise<{ mailboxId: string; jobOpen: boolean }[]>;
  /**
   * Every mailbox the mail server has (`stalwart_id` set), any account, with its status, the Password credential id
   * the control plane last set (null: not recorded) and whether a new password is waiting for the worker.
   */
  mailboxesOnServer(): Promise<
    {
      id: string;
      accountId: string;
      address: string;
      stalwartId: string;
      status: string;
      passwordCredentialId: string | null;
      passwordPending: boolean;
    }[]
  >;
};
