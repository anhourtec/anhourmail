// SPDX-License-Identifier: AGPL-3.0-only
import type { DesiredMailbox, DomainState, JobKind, MailboxState, ProvisioningJob } from "./types";

/** The provisioning queue. `claimNext` is atomic: two workers never get the same job. */
export type ProvisioningRepository = {
  /** Idempotent: a queued job for the same kind + subject is reused, not duplicated. */
  enqueue(input: { kind: JobKind; subjectId: string; runAfter: Date }): Promise<ProvisioningJob>;
  /** Never claims a job whose subject already has another job running (one subject is applied one job at a time). */
  claimNext(now: Date): Promise<ProvisioningJob | null>;
  complete(id: string, now: Date): Promise<void>;
  retry(id: string, error: string, runAfter: Date, now: Date): Promise<void>;
  giveUp(id: string, error: string, now: Date): Promise<void>;
  get(id: string): Promise<ProvisioningJob | null>;
};

/** Desired mail configuration in the control plane (domains, mailboxes, aliases). */
export type MailDirectoryRepository = {
  getDomain(id: string): Promise<DomainState | null>;
  getMailbox(id: string): Promise<MailboxState | null>;
  markDomain(id: string, update: { stalwartId?: string; lastError: string | null }): Promise<void>;
  /** Account holding a verified claim (active or removing) on this domain name, or null if none does. */
  claimedDomainOwner(name: string): Promise<string | null>;
  /** Deletes the domain row once the mail server no longer has it (`removing` domains only). */
  deleteDomain(id: string): Promise<void>;
  markMailbox(id: string, update: { status: string; stalwartId?: string; lastError: string | null }): Promise<void>;
  /** Active domains and every mailbox (for the reconciler, which decides what each status means). */
  desired(): Promise<{ domains: string[]; mailboxes: DesiredMailbox[] }>;
};

/**
 * The mail server, seen from the control plane (adapter: Stalwart via @anhourmail/stalwart-client).
 * Every call is idempotent. Only `destroyMailbox` deletes mail, and only the scheduled purge of a mailbox whose
 * deletion grace period has ended calls it.
 */
export type MailServer = {
  ensureDomain(name: string): Promise<{ externalId: string }>;
  ensureMailbox(input: {
    /** The mail server's id once created; null for a new mailbox, which must not adopt an existing account. */
    externalId: string | null;
    address: string;
    quotaBytes: number;
    /**
     * Suspended: no sign-in over any protocol (IMAP, POP3, SMTP, JMAP, ManageSieve, app passwords) and incoming
     * mail is refused; everything the mailbox holds, its credentials included, is kept. False restores access.
     */
    suspended: boolean;
    aliases: { address: string; enabled: boolean; description: string | null }[];
  }): Promise<{ externalId: string }>;
  /**
   * Permanently removes the mailbox and its mail. Only touches the account we created (`externalId`), and only if
   * it still has this address; a mailbox that was never created there (`externalId` null) is a no-op. Idempotent.
   */
  destroyMailbox(input: { externalId: string | null; address: string }): Promise<void>;
  /** Removes an empty domain (and its signing keys). Refuses if any mailbox still lives on it. Idempotent. */
  removeDomain(name: string): Promise<void>;
  listDomains(): Promise<string[]>;
  /** Every mailbox with its quota and whether it is suspended (sign-in and delivery off). */
  listMailboxes(): Promise<{ address: string; quotaBytes: number; suspended: boolean }[]>;
};
