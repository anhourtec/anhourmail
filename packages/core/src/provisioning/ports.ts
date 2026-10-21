// SPDX-License-Identifier: AGPL-3.0-only
import type { DomainState, JobKind, MailboxState, ProvisioningJob } from "./types";

/** The provisioning queue. `claimNext` is atomic: two workers never get the same job. */
export type ProvisioningRepository = {
  /** Idempotent: a queued job for the same kind + subject is reused, not duplicated. */
  enqueue(input: { kind: JobKind; subjectId: string; runAfter: Date }): Promise<ProvisioningJob>;
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
  markMailbox(id: string, update: { status: string; stalwartId?: string; lastError: string | null }): Promise<void>;
  /** Everything that should exist on the mail server (for the reconciler). */
  desired(): Promise<{ domains: string[]; mailboxes: { address: string; quotaBytes: number }[] }>;
};

/**
 * The mail server, seen from the control plane (adapter: Stalwart via @anhourmail/stalwart-client).
 * Every call is idempotent. Nothing here deletes mail.
 */
export type MailServer = {
  ensureDomain(name: string): Promise<{ externalId: string }>;
  ensureMailbox(input: {
    address: string;
    quotaBytes: number;
    aliases: { address: string; enabled: boolean; description: string | null }[];
  }): Promise<{ externalId: string }>;
  listDomains(): Promise<string[]>;
  listMailboxes(): Promise<{ address: string; quotaBytes: number }[]>;
};
