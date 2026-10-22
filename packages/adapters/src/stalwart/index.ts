// SPDX-License-Identifier: AGPL-3.0-only
/**
 * MailServer port → Stalwart (ADR-0001: driven through its JMAP management API, never forked).
 * New mailboxes get a random, unusable argon2id password: people reach mail through webmail sign-in and app
 * passwords, so no mailbox password is ever chosen, sent or stored by the control plane (CLAUDE.md rule 23).
 */
import { randomBytes } from "node:crypto";

import type { MailServer } from "@anhourmail/core/provisioning";
import type { StalwartManagement } from "@anhourmail/stalwart-client";

import { hashPassword } from "../auth/password";

const split = (address: string): [string, string] => {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) throw new Error("invalid address");
  return [address.slice(0, at), address.slice(at + 1).toLowerCase()];
};

export function stalwartMailServer(mgmt: StalwartManagement): MailServer {
  return {
    async ensureDomain(name) {
      return { externalId: await mgmt.upsertDomain({ name: name.toLowerCase() }) };
    },

    async ensureMailbox({ externalId: known, address, quotaBytes, aliases }) {
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
      return { externalId };
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
      return (await mgmt.listUsers()).map((u) => ({ address: u.address, quotaBytes: u.quotaBytes ?? 0 }));
    },
  };
}
