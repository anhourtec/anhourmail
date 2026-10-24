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
  /** Locks the mailbox for the rest of the unit of work, so a status read here and written back can't undo a change. */
  getMailbox(id: string): Promise<MailboxState | null>;
  markDomain(id: string, update: { stalwartId?: string; lastError: string | null }): Promise<void>;
  /** Account holding a verified claim (active or removing) on this domain name, or null if none does. */
  claimedDomainOwner(name: string): Promise<string | null>;
  /** Deletes the domain row once the mail server no longer has it (`removing` domains only). */
  deleteDomain(id: string): Promise<void>;
  markMailbox(id: string, update: { status: string; stalwartId?: string; lastError: string | null }): Promise<void>;
  /**
   * Records the Password credential id the mail server now has for the mailbox, and clears the waiting password if it
   * is still `applied` (a newer one set meanwhile stays for its own job). `applied` null records the id only.
   */
  passwordApplied(id: string, applied: string | null, credentialId: string): Promise<void>;
  /** Drops a waiting password (its job gave up, or the mailbox is going away): the hash isn't kept around. */
  clearPendingPassword(id: string): Promise<void>;
  /** Active domains and every mailbox (for the reconciler, which decides what each status means). */
  desired(): Promise<{ domains: string[]; mailboxes: DesiredMailbox[] }>;
};

/**
 * The mail server, seen from the control plane (adapter: Stalwart via @anhourmail/stalwart-client).
 * Every call is idempotent. Only `destroyMailbox` deletes mail, and only the scheduled purge of a mailbox whose
 * deletion grace period has ended calls it.
 */
export type MailServer = {
  /**
   * Adds or updates a domain. `catchAllAddress`: where mail for unknown addresses at the domain goes (an active
   * mailbox of the same account); null or omitted, unknown recipients are refused during the SMTP conversation.
   */
  ensureDomain(name: string, catchAllAddress?: string | null): Promise<{ externalId: string }>;
  ensureMailbox(input: {
    /** The mail server's id once created; null for a new mailbox, which must not adopt an existing account. */
    externalId: string | null;
    /**
     * The password for a new account, as a salted argon2id PHC string (never the password). Used only when the
     * account is created now; null creates it with a random password nobody knows. Never changes an existing one.
     */
    initialPasswordHash: string | null;
    address: string;
    quotaBytes: number;
    /**
     * Suspended: no sign-in over any protocol (IMAP, POP3, SMTP, JMAP, ManageSieve, app passwords) and incoming
     * mail is refused; everything the mailbox holds, its credentials included, is kept. False restores access.
     */
    suspended: boolean;
    aliases: { address: string; enabled: boolean; description: string | null }[];
    /** The account's description: the mailbox's display name (Stalwart seeds the sending identity's name from it). */
    description?: string | null;
  }): Promise<{
    externalId: string;
    /** True when the account was created by this call. */
    created: boolean;
    /** The account's sign-in Password credential id now (null if it has none, or more than one). */
    passwordCredentialId: string | null;
  }>;
  /**
   * Replaces the mailbox's sign-in password with `passwordHash` (a salted argon2id PHC string): only the one Password
   * credential, so app passwords stay; the account's existing tokens stop working (Stalwart derives them from the
   * password). Only the account we created (`externalId`), and only if it still has this address. Returns the
   * Password credential id it has afterwards.
   */
  setMailboxPassword(input: {
    externalId: string;
    address: string;
    passwordHash: string;
    /** The web app's grant for this replacement (sent to the management proxy as is), or null. */
    grant: string | null;
  }): Promise<{ credentialId: string }>;
  /**
   * Permanently removes the mailbox and its mail. Only touches the account we created (`externalId`), and only if
   * it still has this address; a mailbox that was never created there (`externalId` null) is a no-op. Idempotent.
   */
  destroyMailbox(input: { externalId: string | null; address: string }): Promise<void>;
  /** Removes an empty domain (and its signing keys). Refuses if any mailbox still lives on it. Idempotent. */
  removeDomain(name: string): Promise<void>;
  listDomains(): Promise<string[]>;
  /**
   * Revokes one app password of a mailbox. Only the credential with this id **and** creation time (ids are reused);
   * already gone is fine. Idempotent.
   */
  revokeAppPassword(input: { externalId: string; credentialId: string; createdAt: Date }): Promise<void>;
  /**
   * Every mailbox with its quota, whether it is suspended (sign-in and delivery off), and whether the customer lock
   * is in place (the user can't change mail flow: no own Sieve, no VacationResponse). `sieveLocked` undefined =
   * not reported (treated as fine).
   */
  listMailboxes(): Promise<{ address: string; quotaBytes: number; suspended: boolean; sieveLocked?: boolean }[]>;
};
