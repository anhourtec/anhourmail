// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import { describeAdapterContract } from "../contract";
import { MemoryUnitOfWork } from ".";

describeAdapterContract("memory", async () => {
  const uow = new MemoryUnitOfWork();
  return {
    uow,
    cleanup: async () => undefined,
    createUser: async (email) => `user-${email}`,
    seedMail: async ({ domain, address, alias, quotaBytes }) => {
      const domainId = randomUUID();
      const mailboxId = randomUUID();
      uow.state.domains.push({ id: domainId, name: domain, status: "active", stalwartId: null, lastError: null });
      uow.state.mailboxes.push({
        id: mailboxId,
        address,
        quotaBytes,
        status: "active",
        stalwartId: null,
        lastError: null,
        aliases: [{ address: alias, kind: "alias", enabled: true, description: null }],
      });
      return { domainId, mailboxId };
    },
  };
});
