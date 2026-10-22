// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import { describeAdapterContract } from "../contract";
import { MemoryUnitOfWork } from ".";

describeAdapterContract("memory", async () => {
  const uow = new MemoryUnitOfWork();
  return {
    uow,
    cleanup: async () => undefined,
    createUser: async (email) => {
      uow.state.userEmails[`user-${email}`] = email;
      return `user-${email}`;
    },
    seedMail: async ({ domain, address, alias, quotaBytes }) => {
      const domainId = randomUUID();
      const mailboxId = randomUUID();
      uow.state.domains.push({
        id: domainId,
        accountId: randomUUID(),
        name: domain,
        status: "active",
        verifyToken: "t",
        stalwartId: null,
        lastError: null,
        createdAt: new Date(),
      });
      uow.state.mailboxes.push({
        id: mailboxId,
        accountId: "a1",
        userId: null,
        createdAt: new Date(0),
        address,
        quotaBytes,
        status: "active",
        stalwartId: null,
        lastError: null,
      });
      uow.state.aliases.push({
        id: randomUUID(),
        accountId: "a1",
        mailboxId,
        address: alias,
        kind: "alias",
        enabled: true,
        description: null,
        createdAt: new Date(0),
      });
      return { domainId, mailboxId };
    },
  };
});
