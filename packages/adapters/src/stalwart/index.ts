// SPDX-License-Identifier: AGPL-3.0-only
/**
 * MailServer port → Stalwart (ADR-0001: driven through its JMAP management API, never forked).
 * Mailbox passwords reach Stalwart only as salted argon2id PHC strings hashed by the control plane (CLAUDE.md rule
 * 23): the one chosen at creation (`initialPasswordHash`) or by a reset or change (`setMailboxPassword`). A mailbox
 * created without one gets a random, unusable password nobody knows.
 */
import { randomBytes } from "node:crypto";

import type { AppPasswordInventory, AppPasswordIssuer } from "@anhourmail/core/app-passwords";
import type { MailboxUsageReader } from "@anhourmail/core/mailboxes";
import type { MailServer, ServiceAccountInventory } from "@anhourmail/core/provisioning";
import type { ManagedScriptReader } from "@anhourmail/core/webmail";
import { MANAGED_SIEVE_SCRIPT } from "@anhourmail/shared/webmail";
import {
  LEGACY_SERVICE_ACCOUNT,
  scopesOf,
  SERVICE_CREDENTIALS,
  type StalwartManagement,
} from "@anhourmail/stalwart-client";

import { hashPassword } from "../auth/password";

const split = (address: string): [string, string] => {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) throw new Error("invalid address");
  return [address.slice(0, at), address.slice(at + 1).toLowerCase()];
};

/**
 * Revokes one app password with owner access (`x:AppPassword`, the web app's operations key) if the account still
 * has it with this creation time. Stalwart reuses credential ids after a revocation, so an id alone could name a newer
 * app password the person still uses.
 */
async function revokeWithOwnerAccess(
  mgmt: StalwartManagement,
  input: { externalId: string; credentialId: string; createdAt: Date },
): Promise<void> {
  const current = await mgmt.appPassword(input.externalId, input.credentialId);
  if (!current) return; // already gone
  if (Math.abs(current.createdAt.getTime() - input.createdAt.getTime()) >= 1000) return; // a newer one reusing the id
  await mgmt.destroyAppPassword(input.externalId, input.credentialId);
}

/**
 * App passwords on Stalwart (`x:AppPassword` on the mailbox's account; research/stalwart.md "App passwords"), for the
 * web app with the operations key (`impersonate` + `sysAppPassword*`): create, and undo a create whose record failed.
 */
export function stalwartAppPasswords(mgmt: StalwartManagement): AppPasswordIssuer {
  return {
    async create({ externalId, name, protocols }) {
      const made = await mgmt.createAppPassword(externalId, { description: name, scopes: protocols });
      return { credentialId: made.id, createdAt: made.createdAt, secret: made.secret };
    },
    revoke: (input) => revokeWithOwnerAccess(mgmt, input),
  };
}

/**
 * What each mailbox holds, for the reconciler: read from `x:Account.credentials` with the provisioning key, which has
 * no owner access to the mailbox (ADR-0020 "Credential split").
 */
export function stalwartAppPasswordInventory(mgmt: StalwartManagement): AppPasswordInventory {
  return {
    async list(externalId) {
      const inv = await mgmt.credentialInventory(externalId);
      return {
        appPasswords: inv.appPasswords.map((a) => ({
          credentialId: a.id,
          createdAt: a.createdAt,
          protocols: scopesOf(a.permissions),
        })),
        apiKeys: inv.apiKeys,
        passwords: inv.passwords.length,
        passwordIds: inv.passwords.map((p) => p.id),
      };
    },
  };
}

/**
 * The service accounts (`SERVICE_CREDENTIALS`, and the retired single-key account) on the deployment's infrastructure
 * domains (`RECONCILE_IGNORE_DOMAINS`: the system domain), with the kinds of credential each holds, read with the
 * provisioning key. A customer mailbox that happens to share a name on another domain isn't one.
 */
export function stalwartServiceAccounts(mgmt: StalwartManagement, domains: readonly string[]): ServiceAccountInventory {
  const names = new Set([...Object.values(SERVICE_CREDENTIALS).map((c) => c.account), LEGACY_SERVICE_ACCOUNT]);
  const wanted = new Set(domains.map((d) => d.toLowerCase()));
  return {
    async list() {
      const [all, accounts] = await Promise.all([
        mgmt.listDomains(),
        mgmt.transport.getAll<{
          id: string;
          name: string;
          domainId: string;
          credentials?: Record<string, { "@type"?: string }>;
        }>("x:Account", ["name", "domainId", "credentials"]),
      ]);
      const matched = all.filter((d) => wanted.has(d.name.toLowerCase()));
      const domainIds = new Set(matched.map((d) => d.id));
      return {
        domains: matched.map((d) => d.name.toLowerCase()),
        accounts: accounts
          .filter((a) => domainIds.has(a.domainId) && names.has(a.name.toLowerCase()))
          .map((a) => ({
            name: a.name.toLowerCase(),
            credentials: Object.values(a.credentials ?? {}).map((c) => c["@type"] ?? "?"),
          })),
      };
    },
  };
}

/** The service accounts that must exist (`SERVICE_CREDENTIALS`): what `reconcileServiceAccounts` checks for. */
export const expectedServiceAccounts = (): string[] => Object.values(SERVICE_CREDENTIALS).map((c) => c.account);

/**
 * Mailbox sizes for `job:storage-usage`, with the provisioning key (`x:Account/get` name + `usedDiskQuota` only; no
 * owner access to any mailbox).
 */
export function stalwartMailboxUsage(mgmt: StalwartManagement): MailboxUsageReader {
  return {
    async usage(externalIds) {
      return (await mgmt.accountUsage(externalIds)).map((a) => ({
        externalId: a.id,
        localPart: a.name,
        usedBytes: a.usedBytes,
      }));
    },
  };
}

/** Reads a mailbox's managed Sieve script and whether it is active, with the scheduler's audit key (reconciler). */
export function stalwartManagedScripts(mgmt: StalwartManagement): ManagedScriptReader {
  return { read: (externalId) => mgmt.getSieveScript(externalId, MANAGED_SIEVE_SCRIPT) };
}

/**
 * The MailServer port with the provisioning key (worker and scheduler): domains, accounts, aliases, suspension and
 * app-password revocation through `x:Account.credentials`. It never needs owner access to a mailbox: the managed Sieve
 * script is written (and made active) by the web app with the operations key.
 */
export function stalwartMailServer(mgmt: StalwartManagement): MailServer {
  return {
    async ensureDomain(name, catchAllAddress) {
      return {
        externalId: await mgmt.upsertDomain({
          name: name.toLowerCase(),
          ...(catchAllAddress ? { catchAllAddress: catchAllAddress.toLowerCase() } : {}),
        }),
      };
    },

    async revokeAppPassword({ externalId, credentialId, createdAt }) {
      await mgmt.revokeAppPasswordCredential(externalId, credentialId, createdAt);
    },

    async ensureMailbox({
      externalId: known,
      initialPasswordHash,
      address,
      quotaBytes,
      suspended,
      aliases,
      description,
    }) {
      const [local, domain] = split(address);
      // A new mailbox never takes over an account that already exists on the mail server: it may hold someone's
      // mail from before (e.g. a domain that changed hands). That needs a person to look at it.
      if (known === null && (await mgmt.listUsers()).some((u) => u.address === `${local}@${domain}`)) {
        throw new Error("address already exists on the mail server; not adopting it");
      }
      if (initialPasswordHash !== null && !initialPasswordHash.startsWith("$argon2id$")) {
        throw new Error("mailbox passwords reach the mail server only as argon2id hashes");
      }
      const externalId = await mgmt.upsertUser({
        name: local,
        domain,
        // Used only when the account is new (resetPassword is false): the password chosen at creation (its hash), or
        // a random secret nobody knows.
        password: initialPasswordHash ?? (await hashPassword(randomBytes(32).toString("base64url"))),
        quotaBytes,
        // Suspension disables sign-in, sending and delivery; credentials and mail are kept (SUSPENDED_PERMISSIONS).
        suspended,
        ...(description === undefined ? {} : { description }),
        // A turned-off alias isn't sent at all, so the server refuses it as an unknown recipient and won't accept
        // it as a sender, without relying on how it treats a disabled alias. The address stays held in Postgres.
        aliases: aliases
          .filter((a) => a.enabled)
          .map((a) => {
            const [name, aliasDomain] = split(a.address);
            return {
              name,
              domain: aliasDomain,
              enabled: true,
              ...(a.description ? { description: a.description } : {}),
            };
          }),
      });
      return { externalId, created: known === null, passwordCredentialId: await mgmt.passwordCredentialId(externalId) };
    },

    async setMailboxPassword({ externalId, address, passwordHash, grant }) {
      // Only the account we created, and only while it still has this address (as for destroying it).
      const account = await mgmt.getUser(externalId);
      const [local, domain] = split(address);
      if (account?.address !== `${local}@${domain}`) {
        throw new Error("mail server account no longer matches this mailbox; not setting its password");
      }
      return mgmt.replacePassword(externalId, passwordHash, { grant });
    },

    async destroyMailbox({ externalId, address }) {
      // Never created by us: nothing of ours to remove (an account at that address is someone else's problem, and
      // the reconciler reports it).
      if (externalId === null) return;
      const account = await mgmt.getUser(externalId);
      if (!account) return; // already gone
      const [local, domain] = split(address);
      if (account.address !== `${local}@${domain}`) {
        throw new Error("mail server account no longer matches this mailbox; not destroying it");
      }
      await mgmt.destroy("x:Account", account.id);
    },

    async removeDomain(name) {
      const domain = (await mgmt.listDomains()).find((d) => d.name === name.toLowerCase());
      if (!domain) return;
      const users = await mgmt.listUsers();
      if (users.some((u) => u.address.endsWith(`@${domain.name}`))) {
        throw new Error("domain still has mailboxes on the mail server");
      }
      await mgmt.destroyDomain(domain.id);
    },

    async listDomains() {
      return (await mgmt.listDomains()).map((d) => d.name);
    },

    async listMailboxes() {
      return (await mgmt.listUsers()).map((u) => ({
        address: u.address,
        quotaBytes: u.quotaBytes ?? 0,
        suspended: u.suspended,
        sieveLocked: u.sieveLocked,
      }));
    },
  };
}
