// SPDX-License-Identifier: AGPL-3.0-only
/** Provisioning: the control plane holds desired state; the worker applies it to the mail server (CLAUDE.md rule 26). */

export type JobKind = "domain.ensure" | "domain.remove" | "mailbox.ensure";
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
  aliases: AliasState[];
};

/** Retries back off 10 s, 20 s, 40 s, 80 s; the 5th failure gives up and alerts (audit). */
export const MAX_ATTEMPTS = 5;
export const backoffMs = (attempt: number): number => 10_000 * 2 ** Math.max(0, attempt - 1);
