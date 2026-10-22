// SPDX-License-Identifier: AGPL-3.0-only
/**
 * MailServer port → Stalwart (ADR-0001: driven through its JMAP management API, never forked).
 * New mailboxes get a random, unusable argon2id password: people reach mail through webmail sign-in and app
 * passwords, so no mailbox password is ever chosen, sent or stored by the control plane (CLAUDE.md rule 23).
 */
import { randomBytes } from "node:crypto";

import type { AppPasswordIssuer } from "@anhourmail/core/app-passwords";
import type { MailServer } from "@anhourmail/core/provisioning";
import type { ManagedScriptReader } from "@anhourmail/core/webmail";
import { MANAGED_SIEVE_SCRIPT } from "@anhourmail/shared/webmail";
import { scopesOf, type StalwartManagement } from "@anhourmail/stalwart-client";

import { hashPassword } from "../auth/password";

const split = (address: string): [string, string] => {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) throw new Error("invalid address");
  return [address.slice(0, at), address.slice(at + 1).toLowerCase()];
};

/**
 * Revokes one app password if the account still has it with this creation time. Stalwart reuses credential ids after
 * a revocation, so an id alone could name a newer app password the person still uses.
 */
async function revokeMatching(
  mgmt: StalwartManagement,
  input: { externalId: string; credentialId: string; createdAt: Date },
): Promise<void> {
  const current = await mgmt.appPassword(input.externalId, input.credentialId);
  if (!current) return; // already gone
  if (Math.abs(current.createdAt.getTime() - input.createdAt.getTime()) >= 1000) return; // a newer one reusing the id
  await mgmt.destroyAppPassword(input.externalId, input.credentialId);
}

/** App passwords on Stalwart (`x:AppPassword` on the mailbox's account; research/stalwart.md "App passwords"). */
export function stalwartAppPasswords(mgmt: StalwartManagement): AppPasswordIssuer {
  return {
    async create({ externalId, name, protocols }) {
      const made = await mgmt.createAppPassword(externalId, { description: name, scopes: protocols });
      return { credentialId: made.id, createdAt: made.createdAt, secret: made.secret };
    },
    revoke: (input) => revokeMatching(mgmt, input),
    async list(externalId) {
      const inv = await mgmt.credentialInventory(externalId);
      return {
        appPasswords: inv.appPasswords.map((a) => ({
          credentialId: a.id,
          createdAt: a.createdAt,
          protocols: scopesOf(a.permissions),
        })),
        apiKeys: inv.apiKeys,
      };
    },
  };
}

/** Reads a mailbox's managed Sieve script with the management key (for the reconciler). */
export function stalwartManagedScripts(mgmt: StalwartManagement): ManagedScriptReader {
  return {
    async read(externalId) {
      return (await mgmt.getSieveScript(externalId, MANAGED_SIEVE_SCRIPT))?.content ?? null;
    },
  };
}

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

    revokeAppPassword: (input) => revokeMatching(mgmt, input),

    async ensureMailbox({ externalId: known, address, quotaBytes, suspended, aliases }) {
      const [local, domain] = split(address);
      // A new mailbox never takes over an account that already exists on the mail server: it may hold someone's
      // mail from before (e.g. a domain that changed hands). That needs a person to look at it.
      if (known === null && (await mgmt.listUsers()).some((u) => u.address === `${local}@${domain}`)) {
        throw new Error("address already exists on the mail server; not adopting it");
      }
      const externalId = await mgmt.upsertUser({
        name: local,
        domain,
        // Used only when the account is new (resetPassword is false): a random secret nobody knows.
        password: await hashPassword(randomBytes(32).toString("base64url")),
        quotaBytes,
        // Suspension disables sign-in, sending and delivery; credentials and mail are kept (SUSPENDED_PERMISSIONS).
        suspended,
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
      // Our managed Sieve script stays the active one: users can't switch it off (`jmapSieveScriptDestroy` denied also
      // refuses a bare deactivate), but an account changed by hand or locked late is put right by every ensure (and the
      // backfill). Nothing is deleted; a mailbox without one is left alone.
      if (!suspended) await mgmt.activateSieveScript(externalId, MANAGED_SIEVE_SCRIPT);
      return { externalId };
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
