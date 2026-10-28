// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import { type AccessRepository, ConflictError, type Repositories, type UnitOfWork } from "@anhourmail/core";
import type { AccountRepository } from "@anhourmail/core/account";
import type { AliasRepository, MailAlias } from "@anhourmail/core/aliases";
import type { AppPassword, AppPasswordRepository } from "@anhourmail/core/app-passwords";
import type { Invite, InviteRepository, PeopleRepository } from "@anhourmail/core/people";
import type {
  AccountSummary,
  MailboxHoldKind,
  PlatformAccountRepository,
  StaffRepository,
  SuspensionRecord,
  SuspensionRepository,
} from "@anhourmail/core/platform";
import type { CatchAllRepository, CustomerDomain, DomainRepository } from "@anhourmail/core/domains";
import {
  type Mailbox,
  type MailboxPasswordRepository,
  type MailboxRepository,
  MAILBOX_STATUSES,
  type MailboxStorageRepository,
  type PlatformAddressRepository,
} from "@anhourmail/core/mailboxes";
import type {
  DomainState,
  MailDirectoryRepository,
  ProvisioningJob,
  ProvisioningRepository,
} from "@anhourmail/core/provisioning";
import {
  type AuditEntry,
  type AuditEntryInput,
  type AuditQuery,
  type AuditRepository,
  GENESIS_HASH,
  hashEntry,
} from "@anhourmail/core/audit";
import type { PasskeyRecord, SecurityRepository, SessionRecord } from "@anhourmail/core/security";
import type { ForwardingTarget, WebmailSettingsRepository } from "@anhourmail/core/webmail";
import type { ProfileDetails } from "@anhourmail/shared/profile";
import type { PlanId } from "@anhourmail/shared/plans";
import type { SignInPolicy } from "@anhourmail/shared/security";
import type { AccountRole, PlatformRole } from "@anhourmail/shared/rbac";

/**
 * In-memory adapter for unit tests (ADR-0008). Same contract as Postgres (src/contract): `run` is atomic —
 * a throw restores the state from before the call — and runs are serialised like transactions.
 */
export type MemoryState = {
  audit: AuditEntry[];
  platformRoles: { userId: string; role: PlatformRole }[];
  memberships: { userId: string; accountId: string; role: AccountRole; joinedAt?: Date }[];
  suspended: string[];
  /** Users whose sign-in email isn't confirmed yet (everyone else counts as confirmed, like seeded logins). */
  unverifiedEmails: string[];
  /** Retired platform-domain addresses (Postgres: `retired_platform_address`). */
  retiredPlatformAddresses: { address: string; accountId: string; retiredAt: Date }[];
  accounts: {
    id: string;
    name: string;
    plan: PlanId;
    status?: string;
    createdAt?: Date;
    signInPolicy?: SignInPolicy;
  }[];
  userStates: Record<string, string>;
  jobs: ProvisioningJob[];
  domains: CustomerDomain[];
  mailboxes: Mailbox[];
  aliases: MailAlias[];
  /** Sign-in emails by user id (memberships reference them). */
  userEmails: Record<string, string>;
  /** Display names by user id (defaults to the email). */
  userNames: Record<string, string>;
  /** Console logins created from invites (password hashes; never read back). */
  logins: { userId: string; passwordHash: string }[];
  invites: (Invite & { tokenHash: string; acceptedUserId: string | null; acceptedAt: Date | null })[];
  inviteSends: { accountId: string; inviteId: string; at: Date }[];
  /** Console sign-in state owned by the identity layer (Postgres: better-auth's tables). */
  sessions: (SessionRecord & { userId: string })[];
  passkeys: (PasskeyRecord & { userId: string })[];
  twoFactor: { userId: string; verified: boolean; recoveryCodesLeft: number }[];
  trustedDevices: { userId: string; id: string }[];
  webmailPreferences: { mailboxId: string; prefs: Record<string, unknown>; updatedAt: Date }[];
  forwardingTargets: ForwardingTarget[];
  appPasswords: AppPassword[];
  /** Mailbox password tracking (Postgres: `mailbox.pending_password_hash`, `mailbox.password_credential_id`). */
  mailboxPasswords: {
    mailboxId: string;
    pendingHash: string | null;
    credentialId: string | null;
    grant?: string | null;
    /** Postgres: `mailbox.pending_password_by_owner`. */
    byOwner?: boolean;
  }[];
  /** Catch-all per domain (Postgres: `customer_domain.catch_all_mailbox_id`). */
  catchAll: { domainId: string; mailboxId: string }[];
  /** Last storage measurement (Postgres: `mailbox.storage_used_bytes`, `mailbox.storage_checked_at`). */
  mailboxStorage: { mailboxId: string; usedBytes: number; checkedAt: Date }[];
  /** Step-up markers by console session (Postgres: better-auth verification rows `step-up-<session id>`). */
  stepUps: { userId: string; sessionId: string; expiresAt: Date }[];
  /** One-time set-password tokens (Postgres: better-auth `reset-password:<token>` verification rows). */
  passwordSetTokens: { userId: string; token: string; expiresAt: Date }[];
  /** Staff suspensions (Postgres: columns on `customer_account` and `user_profile`). */
  accountSuspensions: Record<string, SuspensionRecord>;
  personSuspensions: Record<string, SuspensionRecord>;
  /** Mailboxes a staff suspension holds suspended (Postgres: `mailbox_staff_hold`). */
  mailboxHolds: { mailboxId: string; kind: MailboxHoldKind }[];
  /** Optional profile details by user id (Postgres: columns on `user_profile`). */
  profiles: Record<string, ProfileDetails>;
  /** People who must choose a new console password first (Postgres: `user_profile.must_change_password`). */
  mustChangePassword: string[];
};

export const emptyState = (): MemoryState => ({
  audit: [],
  platformRoles: [],
  memberships: [],
  suspended: [],
  unverifiedEmails: [],
  retiredPlatformAddresses: [],
  accounts: [],
  userStates: {},
  jobs: [],
  domains: [],
  mailboxes: [],
  aliases: [],
  userEmails: {},
  userNames: {},
  logins: [],
  invites: [],
  inviteSends: [],
  sessions: [],
  passkeys: [],
  twoFactor: [],
  trustedDevices: [],
  webmailPreferences: [],
  forwardingTargets: [],
  appPasswords: [],
  mailboxPasswords: [],
  catchAll: [],
  mailboxStorage: [],
  stepUps: [],
  passwordSetTokens: [],
  accountSuspensions: {},
  personSuspensions: {},
  mailboxHolds: [],
  profiles: {},
  mustChangePassword: [],
});

const EPOCH = new Date(0);

const clone = <T>(v: T): T => structuredClone(v);

/** Mirrors the Postgres filter: act-as entries count as staff. */
const actorKindOf = (e: AuditEntry) =>
  e.onBehalfOf !== null || e.actor.type === "staff" ? "staff" : e.actor.type === "api_token" ? "user" : e.actor.type;

function repositories(s: MemoryState): Repositories {
  const audit: AuditRepository = {
    append: async (input: AuditEntryInput, at: Date) => {
      const last = s.audit.filter((e) => e.scope === input.scope).at(-1);
      const unsigned: Omit<AuditEntry, "hash"> = {
        ...clone(input),
        id: randomUUID(),
        at: at.toISOString(),
        seq: (last?.seq ?? 0) + 1,
        prevHash: last?.hash ?? GENESIS_HASH,
      };
      const entry = { ...unsigned, hash: hashEntry(unsigned) };
      s.audit.push(entry);
      return clone(entry);
    },
    list: async (q: AuditQuery) =>
      clone(
        s.audit
          .filter(
            (e) =>
              e.scope === q.scope &&
              (!q.action || e.action === q.action) &&
              (!q.area || e.action.startsWith(`${q.area}.`)) &&
              (!q.actorUserId || e.actor.userId === q.actorUserId) &&
              (!q.actorKind || actorKindOf(e) === q.actorKind) &&
              (!q.result || e.result === q.result) &&
              (!q.targetId || e.target.id === q.targetId) &&
              (!q.from || new Date(e.at) >= q.from) &&
              (!q.to || new Date(e.at) <= q.to) &&
              (q.beforeSeq === undefined || e.seq < q.beforeSeq),
          )
          .sort((a, b) => b.seq - a.seq)
          .slice(0, q.limit),
      ),
    chain: async (scope) => clone(s.audit.filter((e) => e.scope === scope).sort((a, b) => a.seq - b.seq)),
  };

  const access: AccessRepository = {
    platformRoles: async (userId) => s.platformRoles.filter((r) => r.userId === userId).map((r) => r.role),
    memberships: async (userId) =>
      s.memberships.filter((m) => m.userId === userId).map(({ accountId, role }) => ({ accountId, role })),
    isSuspended: async (userId) => s.suspended.includes(userId),
    emailVerified: async (userId) => !s.unverifiedEmails.includes(userId),
    accountNames: async (ids) =>
      Object.fromEntries(s.accounts.filter((a) => ids.includes(a.id)).map((a) => [a.id, a.name] as const)),
    members: async (accountId) =>
      s.memberships
        .filter((m) => m.accountId === accountId)
        .map((m) => ({ userId: m.userId, email: s.userEmails[m.userId] ?? m.userId, role: m.role }))
        .sort((a, b) => a.email.localeCompare(b.email)),
  };

  const accounts: AccountRepository = {
    create: async ({ name, plan }) => {
      const id = randomUUID();
      s.accounts.push({ id, name, plan, createdAt: new Date() });
      return { id };
    },
    addMember: async ({ accountId, userId, role }) => {
      if (s.memberships.some((m) => m.accountId === accountId && m.userId === userId)) {
        throw new Error("duplicate membership");
      }
      s.memberships.push({ accountId, userId, role, joinedAt: new Date() });
    },
    setUserState: async ({ userId, state }) => {
      s.userStates[userId] = state;
    },
    membershipCount: async (userId) => s.memberships.filter((m) => m.userId === userId).length,
    // Runs are already serialised in memory: nothing to lock.
    lock: async () => undefined,
    get: async (id) => {
      const a = s.accounts.find((x) => x.id === id);
      return a ? { id: a.id, name: a.name, plan: a.plan, status: a.status ?? "active" } : null;
    },
  };

  const provisioning: ProvisioningRepository = {
    enqueue: async ({ kind, subjectId, runAfter }) => {
      const existing = s.jobs.find((j) => j.kind === kind && j.subjectId === subjectId && j.status === "queued");
      if (existing) return clone(existing);
      const job: ProvisioningJob = {
        id: randomUUID(),
        kind,
        subjectId,
        status: "queued",
        attempts: 0,
        lastError: null,
        runAfter,
      };
      s.jobs.push(job);
      return clone(job);
    },
    claimNext: async (now) => {
      // Never a second job for a subject that already has one running (mirrors Postgres).
      const busy = new Set(s.jobs.filter((j) => j.status === "running").map((j) => j.subjectId));
      const job = s.jobs
        .filter((j) => j.status === "queued" && j.runAfter <= now && !busy.has(j.subjectId))
        .sort((a, b) => a.runAfter.getTime() - b.runAfter.getTime())[0];
      if (!job) return null;
      job.status = "running";
      job.attempts += 1;
      return clone(job);
    },
    complete: async (id) => {
      const job = s.jobs.find((j) => j.id === id);
      if (job) Object.assign(job, { status: "succeeded", lastError: null });
    },
    retry: async (id, error, runAfter) => {
      const job = s.jobs.find((j) => j.id === id);
      if (job) Object.assign(job, { status: "queued", lastError: error, runAfter });
    },
    giveUp: async (id, error) => {
      const job = s.jobs.find((j) => j.id === id);
      if (job) Object.assign(job, { status: "failed", lastError: error });
    },
    get: async (id) => clone(s.jobs.find((j) => j.id === id) ?? null),
  };

  const passwordOf = (mailboxId: string) => s.mailboxPasswords.find((p) => p.mailboxId === mailboxId);
  const passwordRow = (mailboxId: string) => {
    let p = passwordOf(mailboxId);
    if (!p) {
      p = { mailboxId, pendingHash: null, credentialId: null };
      s.mailboxPasswords.push(p);
    }
    return p;
  };

  const directory: MailDirectoryRepository = {
    getDomain: async (id) => {
      const d = s.domains.find((x) => x.id === id);
      return d
        ? clone<DomainState>({
            id: d.id,
            accountId: d.accountId,
            name: d.name,
            status: d.status,
            stalwartId: d.stalwartId,
          })
        : null;
    },
    getMailbox: async (id) => {
      const m = s.mailboxes.find((x) => x.id === id);
      if (!m) return null;
      return clone({
        id: m.id,
        accountId: m.accountId,
        address: m.address,
        quotaBytes: m.quotaBytes,
        status: m.status,
        stalwartId: m.stalwartId,
        purgeAfter: m.purgeAfter,
        displayName: m.displayName ?? null,
        aliases: s.aliases
          .filter((a) => a.mailboxId === m.id)
          .sort((a, b) => a.address.localeCompare(b.address))
          .map((a) => ({ address: a.address, kind: a.kind, enabled: a.enabled, description: a.description })),
        pendingPasswordHash: passwordOf(m.id)?.pendingHash ?? null,
        pendingPasswordGrant: passwordOf(m.id)?.grant ?? null,
        pendingPasswordByOwner: passwordOf(m.id)?.byOwner === true,
        passwordCredentialId: passwordOf(m.id)?.credentialId ?? null,
      });
    },
    passwordApplied: async (id, applied, credentialId) => {
      if (!s.mailboxes.some((m) => m.id === id)) return;
      const p = passwordRow(id);
      p.credentialId = credentialId;
      if (applied !== null && p.pendingHash === applied) {
        p.pendingHash = null;
        p.grant = null;
        delete p.byOwner;
      }
    },
    clearPendingPassword: async (id) => {
      const p = passwordOf(id);
      if (p) {
        p.pendingHash = null;
        p.grant = null;
        delete p.byOwner;
      }
    },
    markDomain: async (id, update) => {
      const d = s.domains.find((x) => x.id === id);
      if (d)
        Object.assign(d, {
          lastError: update.lastError,
          ...(update.stalwartId ? { stalwartId: update.stalwartId } : {}),
          ...(update.dkimKeys ? { dkimKeys: clone(update.dkimKeys) } : {}),
        });
    },
    claimedDomainOwner: async (name) =>
      s.domains.find((d) => d.name === name && d.status !== "pending_dns")?.accountId ?? null,
    domainOnMailServerElsewhere: async (name, exceptId) =>
      s.domains.some((d) => d.name === name && d.id !== exceptId && d.stalwartId !== null),
    deleteDomain: async (id) => {
      s.domains = s.domains.filter((d) => !(d.id === id && d.status === "removing"));
      s.catchAll = s.catchAll.filter((c) => s.domains.some((d) => d.id === c.domainId));
    },
    markMailbox: async (id, update) => {
      const m = s.mailboxes.find((x) => x.id === id);
      if (m) {
        Object.assign(m, {
          status: MAILBOX_STATUSES.find((x) => x === update.status) ?? "provisioning",
          lastError: update.lastError,
          ...(update.stalwartId ? { stalwartId: update.stalwartId } : {}),
        });
      }
    },
    desired: async () => ({
      domains: s.domains
        .filter((d) => d.status === "active" || (d.status === "pending_dns" && d.stalwartId !== null))
        .map((d) => d.name),
      mailboxes: s.mailboxes.map((m) => ({
        id: m.id,
        address: m.address,
        quotaBytes: m.quotaBytes,
        status: m.status,
        provisioned: m.stalwartId !== null,
      })),
    }),
  };

  const domains: DomainRepository = {
    listByAccount: async (accountId) =>
      clone(s.domains.filter((d) => d.accountId === accountId).sort((a, b) => a.name.localeCompare(b.name))),
    get: async (accountId, id) => clone(s.domains.find((d) => d.id === id && d.accountId === accountId) ?? null),
    nameTaken: async (name) => s.domains.some((d) => d.name === name && d.status !== "pending_dns"),
    insert: async (d) => {
      if (s.domains.some((x) => x.accountId === d.accountId && x.name === d.name)) throw new Error("duplicate domain");
      s.domains.push({ ...clone(d), dkimKeys: d.dkimKeys ?? null });
    },
    transition: async (id, from, to) => {
      const d = s.domains.find((x) => x.id === id && x.status === from);
      if (!d) return false;
      if (
        to !== "pending_dns" &&
        s.domains.some((x) => x.id !== id && x.name === d.name && x.status !== "pending_dns")
      ) {
        throw new Error("duplicate claimed domain name"); // mirrors the partial unique index in Postgres
      }
      d.status = to;
      return true;
    },
    deletePending: async (id) => {
      const before = s.domains.length;
      s.domains = s.domains.filter((d) => !(d.id === id && d.status === "pending_dns" && d.stalwartId === null));
      s.catchAll = s.catchAll.filter((c) => c.domainId !== id || s.domains.some((d) => d.id === id));
      return s.domains.length < before;
    },
    addressCount: async (name) =>
      s.mailboxes.filter((m) => m.address.endsWith(`@${name}`)).length +
      s.aliases.filter((a) => a.address.endsWith(`@${name}`)).length,
    pending: async (since, limit) =>
      clone(
        s.domains
          .filter((d) => d.status === "pending_dns" && d.createdAt >= since)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, limit),
      ),
    missingDkimKeys: async (limit) =>
      clone(
        s.domains
          .filter(
            (d) =>
              d.status !== "removing" && d.stalwartId !== null && (d.dkimKeys ?? null) === null && d.lastError === null,
          )
          .slice(0, limit),
      ),
  };

  const platformAddresses: PlatformAddressRepository = {
    retiredFrom: async (address) =>
      s.retiredPlatformAddresses.find((r) => r.address === address.toLowerCase())?.accountId ?? null,
    retire: async (address, accountId, at) => {
      const a = address.toLowerCase();
      if (!s.retiredPlatformAddresses.some((r) => r.address === a)) {
        s.retiredPlatformAddresses.push({ address: a, accountId, retiredAt: at });
      }
    },
  };

  const mailboxStorage: MailboxStorageRepository = {
    targets: async () =>
      s.mailboxes.flatMap((m) =>
        m.stalwartId === null ? [] : [{ id: m.id, address: m.address, stalwartId: m.stalwartId }],
      ),
    record: async (entries, at) => {
      let written = 0;
      for (const e of entries) {
        if (!s.mailboxes.some((m) => m.id === e.id && m.stalwartId === e.stalwartId)) continue;
        s.mailboxStorage = s.mailboxStorage.filter((x) => x.mailboxId !== e.id);
        s.mailboxStorage.push({ mailboxId: e.id, usedBytes: e.usedBytes, checkedAt: clone(at) });
        written += 1;
      }
      return written;
    },
    byAccount: async (accountId) =>
      s.mailboxes
        .filter((m) => m.accountId === accountId)
        .map((m) => {
          const x = s.mailboxStorage.find((y) => y.mailboxId === m.id);
          return { mailboxId: m.id, usedBytes: x?.usedBytes ?? null, checkedAt: x ? clone(x.checkedAt) : null };
        }),
    quotas: async () =>
      s.mailboxes.flatMap((m) => {
        const account = s.accounts.find((a) => a.id === m.accountId);
        return account
          ? [
              {
                id: m.id,
                accountId: m.accountId,
                address: m.address,
                stalwartId: m.stalwartId,
                quotaBytes: m.quotaBytes,
                plan: account.plan,
              },
            ]
          : [];
      }),
  };

  const mailboxPasswords: MailboxPasswordRepository = {
    setPending: async (mailboxId, passwordHash, grant, opts) => {
      if (!s.mailboxes.some((m) => m.id === mailboxId)) return;
      const row = passwordRow(mailboxId);
      row.pendingHash = passwordHash;
      row.grant = grant;
      if (opts?.byOwner === true) row.byOwner = true;
      else delete row.byOwner;
    },
    pending: async (mailboxId) => (passwordOf(mailboxId)?.pendingHash ?? null) !== null,
  };

  const mailboxes: MailboxRepository = {
    listByAccount: async (accountId) =>
      clone(s.mailboxes.filter((m) => m.accountId === accountId).sort((a, b) => a.address.localeCompare(b.address))),
    get: async (accountId, id) => clone(s.mailboxes.find((x) => x.id === id && x.accountId === accountId) ?? null),
    count: async (accountId) => s.mailboxes.filter((m) => m.accountId === accountId).length,
    addressTaken: async (address) =>
      s.mailboxes.some((m) => m.address === address) || s.aliases.some((a) => a.address === address),
    // Runs are serialised, so holding an address is implicit here.
    lockAddress: async () => undefined,
    insert: async (m) => {
      if (s.mailboxes.some((x) => x.address === m.address)) throw new Error("duplicate mailbox address");
      s.mailboxes.push(clone(m));
    },
    setQuota: async (id, quotaBytes) => {
      const m = s.mailboxes.find((x) => x.id === id);
      if (m) m.quotaBytes = quotaBytes;
    },
    setPasswordChangeRequired: async (id, required) => {
      const m = s.mailboxes.find((x) => x.id === id);
      if (m) m.mustChangePassword = required;
    },
    assignOwner: async (id, userId) => {
      const m = s.mailboxes.find((x) => x.id === id && x.userId === null);
      if (!m) return false;
      m.userId = userId;
      return true;
    },
    setDisplayName: async (id, displayName) => {
      const m = s.mailboxes.find((x) => x.id === id);
      if (m) m.displayName = displayName;
    },
    transition: async (id, from, to, purgeAfter) => {
      const m = s.mailboxes.find((x) => x.id === id && from.includes(x.status));
      if (!m) return false;
      Object.assign(m, { status: to, purgeAfter: clone(purgeAfter), lastError: null });
      return true;
    },
    dueForPurge: async (now, limit) =>
      clone(
        s.mailboxes
          .filter((m) => m.status === "deleting" && m.purgeAfter !== null && m.purgeAfter <= now)
          .sort((a, b) => (a.purgeAfter?.getTime() ?? 0) - (b.purgeAfter?.getTime() ?? 0))
          .slice(0, limit),
      ),
    deleteIfDue: async (id, now) => {
      const m = s.mailboxes.find(
        (x) => x.id === id && x.status === "deleting" && x.purgeAfter !== null && x.purgeAfter <= now,
      );
      if (!m) return false;
      s.mailboxes = s.mailboxes.filter((x) => x.id !== id);
      s.aliases = s.aliases.filter((a) => a.mailboxId !== id); // mirrors ON DELETE CASCADE in Postgres
      s.webmailPreferences = s.webmailPreferences.filter((p) => p.mailboxId !== id);
      s.forwardingTargets = s.forwardingTargets.filter((t) => t.mailboxId !== id);
      s.appPasswords = s.appPasswords.filter((p) => p.mailboxId !== id); // ON DELETE CASCADE
      s.mailboxPasswords = s.mailboxPasswords.filter((p) => p.mailboxId !== id); // columns of the row
      s.mailboxStorage = s.mailboxStorage.filter((x) => x.mailboxId !== id); // columns of the row
      s.catchAll = s.catchAll.filter((c) => c.mailboxId !== id); // ON DELETE SET NULL
      return true;
    },
  };

  const aliases: AliasRepository = {
    listByAccount: async (accountId) =>
      clone(s.aliases.filter((a) => a.accountId === accountId).sort((a, b) => a.address.localeCompare(b.address))),
    get: async (accountId, id) => clone(s.aliases.find((a) => a.id === id && a.accountId === accountId) ?? null),
    count: async (accountId, kind) => s.aliases.filter((a) => a.accountId === accountId && a.kind === kind).length,
    insert: async (a) => {
      if (s.aliases.some((x) => x.address === a.address)) throw new ConflictError("That address is already in use.");
      s.aliases.push(clone(a));
    },
    setEnabled: async (id, enabled) => {
      const a = s.aliases.find((x) => x.id === id);
      if (a) a.enabled = enabled;
    },
    delete: async (id) => {
      s.aliases = s.aliases.filter((a) => a.id !== id);
    },
  };

  const people: PeopleRepository = {
    list: async (accountId) =>
      s.memberships
        .filter((m) => m.accountId === accountId)
        .map((m) => {
          const email = s.userEmails[m.userId] ?? m.userId;
          return {
            userId: m.userId,
            name: s.userNames[m.userId] ?? email,
            email,
            role: m.role,
            joinedAt: clone(m.joinedAt ?? EPOCH),
            suspended: s.suspended.includes(m.userId),
          };
        })
        .sort((a, b) => a.email.localeCompare(b.email)),
    setRole: async (accountId, userId, role) => {
      const m = s.memberships.find((x) => x.accountId === accountId && x.userId === userId);
      if (!m) return false;
      m.role = role;
      return true;
    },
    remove: async (accountId, userId) => {
      const before = s.memberships.length;
      s.memberships = s.memberships.filter((x) => !(x.accountId === accountId && x.userId === userId));
      return s.memberships.length < before;
    },
    userByEmail: async (email) => {
      const id = Object.keys(s.userEmails).find((k) => s.userEmails[k]?.toLowerCase() === email.toLowerCase());
      return id ? { id, name: s.userNames[id] ?? s.userEmails[id] ?? id } : null;
    },
    createLogin: async ({ email, name, passwordHash, mustChangePassword }) => {
      if (Object.values(s.userEmails).some((e) => e.toLowerCase() === email.toLowerCase())) {
        throw new ConflictError("That address already has a login.");
      }
      const id = randomUUID();
      s.userEmails[id] = email;
      s.userNames[id] = name;
      s.logins.push({ userId: id, passwordHash });
      if (mustChangePassword === true) s.mustChangePassword.push(id);
      return { id };
    },
    setProfile: async (userId, details) => {
      s.profiles[userId] = clone(details);
    },
    profile: async (userId) => clone(s.profiles[userId] ?? {}),
    passwordChangeRequired: async (userId) => s.mustChangePassword.includes(userId),
    setPasswordChangeRequired: async (userId, required) => {
      s.mustChangePassword = s.mustChangePassword.filter((x) => x !== userId);
      if (required) s.mustChangePassword.push(userId);
    },
  };

  const toInvite = ({
    tokenHash: _t,
    acceptedUserId: _u,
    acceptedAt: _a,
    ...i
  }: MemoryState["invites"][number]): Invite => clone(i);

  const invites: InviteRepository = {
    listPending: async (accountId) =>
      s.invites
        .filter((i) => i.accountId === accountId && i.status === "pending")
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map(toInvite),
    get: async (accountId, id) => {
      const i = s.invites.find((x) => x.id === id && x.accountId === accountId);
      return i ? toInvite(i) : null;
    },
    findByToken: async (tokenHash) => {
      const i = s.invites.find((x) => x.tokenHash === tokenHash);
      return i ? toInvite(i) : null;
    },
    create: async (input) => {
      if (s.invites.some((x) => x.tokenHash === input.tokenHash)) throw new Error("duplicate invite token");
      const row = {
        ...clone(input),
        id: randomUUID(),
        status: "pending" as const,
        acceptedUserId: null,
        acceptedAt: null,
      };
      s.invites.push(row);
      return toInvite(row);
    },
    reissue: async (id, tokenHash, expiresAt) => {
      const i = s.invites.find((x) => x.id === id && x.status === "pending");
      if (!i) return false;
      Object.assign(i, { tokenHash, expiresAt: clone(expiresAt) });
      return true;
    },
    revoke: async (id) => {
      const i = s.invites.find((x) => x.id === id && x.status === "pending");
      if (!i) return false;
      i.status = "revoked";
      return true;
    },
    accept: async (id, userId, at) => {
      const i = s.invites.find((x) => x.id === id && x.status === "pending" && x.expiresAt > at);
      if (!i) return false;
      Object.assign(i, { status: "accepted", acceptedUserId: userId, acceptedAt: clone(at) });
      return true;
    },
    recordSend: async (accountId, inviteId, at) => {
      s.inviteSends.push({ accountId, inviteId, at: clone(at) });
    },
    sendsSince: async (accountId, since) =>
      s.inviteSends.filter((x) => x.accountId === accountId && x.at >= since).length,
  };

  const summaryOf = (a: MemoryState["accounts"][number]): AccountSummary => ({
    id: a.id,
    name: a.name,
    plan: a.plan,
    status: a.status ?? "active",
    members: s.memberships.filter((m) => m.accountId === a.id).length,
    mailboxes: s.mailboxes.filter((m) => m.accountId === a.id).length,
    domains: s.domains.filter((d) => d.accountId === a.id).length,
    createdAt: clone(a.createdAt ?? EPOCH),
  });

  const staff: StaffRepository = {
    // Runs are already serialised by MemoryUnitOfWork.
    lockBootstrap: async () => undefined,
    anyPlatformRole: async () => s.platformRoles.length > 0,
    createLogin: async ({ email, name }) => {
      if (Object.values(s.userEmails).some((e) => e.toLowerCase() === email.toLowerCase())) {
        throw new ConflictError("That address already has a login.");
      }
      const id = randomUUID();
      s.userEmails[id] = email;
      s.userNames[id] = name;
      return { id };
    },
    grantRole: async (userId, role) => {
      if (!s.platformRoles.some((r) => r.userId === userId && r.role === role)) s.platformRoles.push({ userId, role });
    },
    issuePasswordSetToken: async (userId, token, expiresAt) => {
      s.passwordSetTokens.push({ userId, token, expiresAt });
    },
  };

  const platformAccounts: PlatformAccountRepository = {
    search: async ({ query, limit, offset }) => {
      const q = query?.toLowerCase() ?? null;
      const matches = s.accounts.filter(
        (a) =>
          q === null ||
          a.name.toLowerCase().includes(q) ||
          a.id === q ||
          s.memberships.some((m) => m.accountId === a.id && (s.userEmails[m.userId] ?? "").toLowerCase().includes(q)),
      );
      const sorted = [...matches].sort(
        (a, b) => (b.createdAt ?? EPOCH).getTime() - (a.createdAt ?? EPOCH).getTime() || a.id.localeCompare(b.id),
      );
      return { total: matches.length, rows: sorted.slice(offset, offset + limit).map(summaryOf) };
    },
    summary: async (id) => {
      const a = s.accounts.find((x) => x.id === id);
      return a ? summaryOf(a) : null;
    },
  };

  const passkeyOut = ({ userId: _userId, ...p }: MemoryState["passkeys"][number]): PasskeyRecord => clone(p);
  const sessionOut = ({ userId: _userId, ...x }: MemoryState["sessions"][number]): SessionRecord => clone(x);

  const security: SecurityRepository = {
    factors: async (userId) => {
      const tf = s.twoFactor.find((t) => t.userId === userId && t.verified);
      return {
        totp: tf !== undefined,
        passkeys: s.passkeys.filter((p) => p.userId === userId).length,
        recoveryCodesLeft: tf?.recoveryCodesLeft ?? 0,
      };
    },
    sessions: async (userId, now) =>
      s.sessions
        .filter((x) => x.userId === userId && x.expiresAt > now)
        .sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime())
        .map(sessionOut),
    revokeSession: async (userId, sessionId) => {
      const i = s.sessions.findIndex((x) => x.userId === userId && x.id === sessionId);
      if (i === -1) return null;
      const [gone] = s.sessions.splice(i, 1);
      return gone ? sessionOut(gone) : null;
    },
    revokeOtherSessions: async (userId, keep) => {
      const before = s.sessions.length;
      s.sessions = s.sessions.filter((x) => x.userId !== userId || x.id === keep);
      return before - s.sessions.length;
    },
    forgetTrustedDevices: async (userId) => {
      const before = s.trustedDevices.length;
      s.trustedDevices = s.trustedDevices.filter((d) => d.userId !== userId);
      return before - s.trustedDevices.length;
    },
    passkeys: async (userId) =>
      s.passkeys
        .filter((p) => p.userId === userId)
        .sort((a, b) => (b.createdAt ?? EPOCH).getTime() - (a.createdAt ?? EPOCH).getTime())
        .map(passkeyOut),
    renamePasskey: async (userId, id, name) => {
      const p = s.passkeys.find((x) => x.userId === userId && x.id === id);
      if (!p) return null;
      p.name = name;
      return passkeyOut(p);
    },
    removePasskey: async (userId, id) => {
      const i = s.passkeys.findIndex((x) => x.userId === userId && x.id === id);
      if (i === -1) return null;
      const [gone] = s.passkeys.splice(i, 1);
      return gone ? passkeyOut(gone) : null;
    },
    policies: async (userId) =>
      s.memberships
        .filter((m) => m.userId === userId)
        .map((m) => ({
          accountId: m.accountId,
          policy: s.accounts.find((a) => a.id === m.accountId)?.signInPolicy ?? "none",
        })),
    accountPolicy: async (accountId) => {
      const a = s.accounts.find((x) => x.id === accountId);
      return a ? (a.signInPolicy ?? "none") : null;
    },
    setAccountPolicy: async (accountId, policy) => {
      const a = s.accounts.find((x) => x.id === accountId);
      if (a) a.signInPolicy = policy;
    },
    stepUpFresh: async (userId, sessionId, now) =>
      s.stepUps.some((x) => x.userId === userId && x.sessionId === sessionId && x.expiresAt > now),
  };

  const appPasswords: AppPasswordRepository = {
    listByMailbox: async (mailboxId) =>
      clone(
        s.appPasswords
          .filter((p) => p.mailboxId === mailboxId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id)),
      ),
    get: async (mailboxId, id) => clone(s.appPasswords.find((p) => p.mailboxId === mailboxId && p.id === id) ?? null),
    insert: async (p) => {
      if (!s.mailboxes.some((m) => m.id === p.mailboxId)) throw new Error("unknown mailbox"); // foreign key
      s.appPasswords.push(clone(p));
    },
    markRevoking: async (mailboxId, id) => {
      const moved = s.appPasswords.filter(
        (p) => p.mailboxId === mailboxId && p.status === "active" && (id === null || p.id === id),
      );
      for (const p of moved) p.status = "revoking";
      return clone(moved);
    },
    revoking: async (mailboxId) =>
      clone(
        s.appPasswords
          .filter((p) => p.mailboxId === mailboxId && p.status === "revoking")
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      ),
    deleteRevoked: async (id) => {
      s.appPasswords = s.appPasswords.filter((p) => !(p.id === id && p.status === "revoking"));
    },
    mailboxesWithRevoking: async () =>
      [...new Set(s.appPasswords.filter((p) => p.status === "revoking").map((p) => p.mailboxId))].map((mailboxId) => ({
        mailboxId,
        jobOpen: s.jobs.some(
          (j) =>
            j.kind === "app_password.revoke" &&
            j.subjectId === mailboxId &&
            (j.status === "queued" || j.status === "running"),
        ),
      })),
    mailboxesOnServer: async () =>
      s.mailboxes.flatMap((m) =>
        m.stalwartId === null
          ? []
          : [
              {
                id: m.id,
                accountId: m.accountId,
                address: m.address,
                stalwartId: m.stalwartId,
                status: m.status,
                passwordCredentialId: passwordOf(m.id)?.credentialId ?? null,
                passwordPending: (passwordOf(m.id)?.pendingHash ?? null) !== null,
              },
            ],
      ),
  };

  const catchAll: CatchAllRepository = {
    get: async (domainId) => s.catchAll.find((c) => c.domainId === domainId)?.mailboxId ?? null,
    set: async (domainId, mailboxId) => {
      s.catchAll = s.catchAll.filter((c) => c.domainId !== domainId);
      if (mailboxId !== null) s.catchAll.push({ domainId, mailboxId });
    },
    clearForMailbox: async (mailboxId) => {
      const off = s.catchAll.filter((c) => c.mailboxId === mailboxId).map((c) => c.domainId);
      s.catchAll = s.catchAll.filter((c) => c.mailboxId !== mailboxId);
      return s.domains
        .filter((d) => off.includes(d.id))
        .map((d) => ({ id: d.id, name: d.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    targetAddress: async (domainId) => {
      const c = s.catchAll.find((x) => x.domainId === domainId);
      const d = s.domains.find((x) => x.id === domainId);
      const m = c ? s.mailboxes.find((x) => x.id === c.mailboxId && x.accountId === d?.accountId) : undefined;
      return m?.status === "active" ? m.address : null;
    },
  };

  const webmailSettings: WebmailSettingsRepository = {
    mailboxByAddress: async (address) => {
      const m = s.mailboxes.find((x) => x.address === address.trim().toLowerCase());
      return m
        ? { id: m.id, accountId: m.accountId, address: m.address, mustChangePassword: m.mustChangePassword === true }
        : null;
    },
    preferences: async (mailboxId) => clone(s.webmailPreferences.find((p) => p.mailboxId === mailboxId)?.prefs ?? null),
    savePreferences: async (mailboxId, prefs, at) => {
      s.webmailPreferences = s.webmailPreferences.filter((p) => p.mailboxId !== mailboxId);
      s.webmailPreferences.push({ mailboxId, prefs: clone(prefs), updatedAt: at });
    },
    forwarding: async (mailboxId) => clone(s.forwardingTargets.find((t) => t.mailboxId === mailboxId) ?? null),
    // The memory unit of work serialises runs, so a plain read is already exclusive.
    forwardingForUpdate: async (mailboxId, _accountId) =>
      clone(s.forwardingTargets.find((t) => t.mailboxId === mailboxId) ?? null),
    saveForwarding: async (t) => {
      if (
        t.tokenHash !== null &&
        s.forwardingTargets.some((x) => x.tokenHash === t.tokenHash && x.mailboxId !== t.mailboxId)
      ) {
        throw new ConflictError("token already used");
      }
      s.forwardingTargets = s.forwardingTargets.filter((x) => x.mailboxId !== t.mailboxId);
      s.forwardingTargets.push(clone(t));
    },
    forwardingByToken: async (tokenHash) => clone(s.forwardingTargets.find((t) => t.tokenHash === tokenHash) ?? null),
    clearForwarding: async (mailboxId) => {
      s.forwardingTargets = s.forwardingTargets.filter((t) => t.mailboxId !== mailboxId);
    },
  };

  const suspensions: SuspensionRepository = {
    account: async (accountId) => clone(s.accountSuspensions[accountId] ?? null),
    setAccount: async (accountId, record) => {
      if (record) s.accountSuspensions[accountId] = clone(record);
      else Reflect.deleteProperty(s.accountSuspensions, accountId);
      const a = s.accounts.find((x) => x.id === accountId);
      if (a) a.status = record ? "suspended" : "active";
    },
    personInfo: async (userId) => {
      const email = s.userEmails[userId];
      return email === undefined ? null : { email, name: s.userNames[userId] ?? "" };
    },
    person: async (userId) => clone(s.personSuspensions[userId] ?? null),
    setPerson: async (userId, record) => {
      if (record) s.personSuspensions[userId] = clone(record);
      else Reflect.deleteProperty(s.personSuspensions, userId);
      s.suspended = s.suspended.filter((u) => u !== userId);
      if (record) s.suspended.push(userId);
    },
    suspendedAccountsOf: async (userId) =>
      s.memberships
        .filter((m) => m.userId === userId && s.accountSuspensions[m.accountId] !== undefined)
        .map((m) => m.accountId),
    mailboxesOf: async (userId) => clone(s.mailboxes.filter((m) => m.userId === userId)),
    holds: async (ids) => clone(s.mailboxHolds.filter((h) => ids.includes(h.mailboxId))),
    addHold: async (mailboxId, kind) => {
      if (!s.mailboxHolds.some((h) => h.mailboxId === mailboxId && h.kind === kind)) {
        s.mailboxHolds.push({ mailboxId, kind });
      }
    },
    removeHold: async (mailboxId, kind) => {
      s.mailboxHolds = s.mailboxHolds.filter((h) => !(h.mailboxId === mailboxId && h.kind === kind));
    },
  };

  return {
    suspensions,
    webmailSettings,
    appPasswords,
    catchAll,
    audit,
    access,
    accounts,
    provisioning,
    directory,
    domains,
    mailboxes,
    mailboxPasswords,
    platformAddresses,
    mailboxStorage,
    aliases,
    people,
    invites,
    platformAccounts,
    staff,
    security,
  };
}

export class MemoryUnitOfWork implements UnitOfWork {
  #queue: Promise<unknown> = Promise.resolve();

  constructor(readonly state: MemoryState = emptyState()) {}

  run<T>(fn: (repos: Repositories) => Promise<T>): Promise<T> {
    const next = this.#queue.then(async () => {
      const snapshot = clone(this.state);
      try {
        return await fn(repositories(this.state));
      } catch (err) {
        Object.assign(this.state, snapshot);
        throw err;
      }
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }
}

export { KNOWN_BREACHED_PASSWORDS, memoryBreachedPasswords, type MemoryBreachedPasswords } from "./breached-passwords";
