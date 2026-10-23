// SPDX-License-Identifier: AGPL-3.0-only
/** Provisioning: the control plane holds desired state; the worker applies it to the mail server (CLAUDE.md rule 26). */

/**
 * `app_password.revoke`: subject is a mailbox; takes its `revoking` app passwords off the mail server.
 * `mailbox.password`: subject is a mailbox; sets the password waiting for it (an argon2id hash, never the password).
 */
export type JobKind = "domain.ensure" | "domain.remove" | "mailbox.ensure" | "mailbox.password" | "app_password.revoke";
export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export type ProvisioningJob = {
  id: string;
  kind: JobKind;
  /** Control-plane row the job applies: a domain id or a mailbox id. */
  subjectId: string;
  status: JobStatus;
  attempts: number;
  lastError: string | null;
  runAfter: Date;
};

export type DomainState = { id: string; name: string; status: string; stalwartId: string | null };

export type AliasState = { address: string; kind: "alias" | "masked"; enabled: boolean; description: string | null };

export type MailboxState = {
  id: string;
  accountId: string;
  address: string;
  quotaBytes: number;
  status: string;
  stalwartId: string | null;
  /** Set while `deleting`: when the scheduler removes it for good. */
  purgeAfter: Date | null;
  aliases: AliasState[];
  /**
   * A new mailbox password waiting for the worker, as a salted argon2id PHC string (never the password itself; rule
   * 23): set at creation or by a reset or change, cleared once the mail server has it (or the job gave up).
   */
  pendingPasswordHash: string | null;
  /**
   * The web app's grant for replacing this account's password with exactly `pendingPasswordHash` (HMAC with a key the
   * worker doesn't hold; the management proxy verifies it). Null at creation or where no key is configured.
   */
  pendingPasswordGrant: string | null;
  /**
   * The mail server's id for the mailbox's sign-in Password credential as the control plane last set it (null:
   * not recorded yet, e.g. a mailbox from before this was tracked). The reconciler reports a different one.
   */
  passwordCredentialId: string | null;
};

/** What the reconciler compares with the mail server: every mailbox row, with whether it was ever created there. */
export type DesiredMailbox = {
  id: string;
  address: string;
  quotaBytes: number;
  status: string;
  provisioned: boolean;
};

/** Retries back off 10 s, 20 s, 40 s, 80 s; the 5th failure gives up and alerts (audit). */
export const MAX_ATTEMPTS = 5;
export const backoffMs = (attempt: number): number => 10_000 * 2 ** Math.max(0, attempt - 1);
