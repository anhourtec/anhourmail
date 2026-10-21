// SPDX-License-Identifier: AGPL-3.0-only
import { describeAdapterContract } from "../contract";
import { MemoryUnitOfWork } from ".";

describeAdapterContract("memory", async () => ({
  uow: new MemoryUnitOfWork(),
  cleanup: async () => undefined,
  createUser: async (email) => `user-${email}`,
}));
