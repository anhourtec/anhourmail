// SPDX-License-Identifier: AGPL-3.0-only
import type { AccessRepository } from "./access/repository";
import type { AccountRepository } from "./account/repository";
import type { AliasRepository } from "./aliases/repository";
import type { AppPasswordRepository } from "./app-passwords/repository";
import type { AuditRepository } from "./audit/repository";
import type { CatchAllRepository, DomainRepository } from "./domains/repository";
import type { MailboxRepository } from "./mailboxes/repository";
import type { InviteRepository, PeopleRepository } from "./people/repository";
import type { PlatformAccountRepository } from "./platform/repository";
import type { MailDirectoryRepository, ProvisioningRepository } from "./provisioning/ports";
import type { SecurityRepository } from "./security/repository";
import type { WebmailSettingsRepository } from "./webmail/settings-repository";

/** Everything a service can touch inside one transaction. Adapters implement it (memory, postgres). */
export type Repositories = {
  audit: AuditRepository;
  access: AccessRepository;
  accounts: AccountRepository;
  provisioning: ProvisioningRepository;
  directory: MailDirectoryRepository;
  domains: DomainRepository;
  mailboxes: MailboxRepository;
  aliases: AliasRepository;
  people: PeopleRepository;
  invites: InviteRepository;
  platformAccounts: PlatformAccountRepository;
  security: SecurityRepository;
  webmailSettings: WebmailSettingsRepository;
  appPasswords: AppPasswordRepository;
  catchAll: CatchAllRepository;
};

/**
 * Runs `fn` atomically: every write in it commits together or not at all (audit included, CLAUDE.md rule 46).
 */
export type UnitOfWork = {
  run<T>(fn: (repos: Repositories) => Promise<T>): Promise<T>;
};

export type Clock = {
  now(): Date;
};

export const systemClock: Clock = { now: () => new Date() };

/** Request metadata recorded in audit entries. */
export type RequestMeta = { requestId: string; ip: string | null; userAgent: string | null };

export type Deps = { uow: UnitOfWork; clock: Clock };
