// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { SuspensionReason } from "@anhourmail/shared/platform";

import { describeAdapterContract } from "../contract";
import { MemoryUnitOfWork } from ".";

describeAdapterContract("memory", async () => {
  const uow = new MemoryUnitOfWork();
  return {
    uow,
    cleanup: async () => undefined,
    createUser: async (email, opts) => {
      uow.state.userEmails[`user-${email}`] = email;
      if (opts?.emailVerified === false) uow.state.unverifiedEmails.push(`user-${email}`);
      return `user-${email}`;
    },
    seedMail: async ({ domain, address, alias, quotaBytes }) => {
      const domainId = randomUUID();
      const mailboxId = randomUUID();
      const accountId = randomUUID(); // one account for the domain, the mailbox and its alias (as in Postgres)
      uow.state.accounts.push({ id: accountId, name: domain, plan: "free" });
      uow.state.domains.push({
        id: domainId,
        accountId,
        name: domain,
        status: "active",
        verifyToken: "t",
        stalwartId: null,
        lastError: null,
        createdAt: new Date(),
      });
      uow.state.mailboxes.push({
        id: mailboxId,
        accountId,
        userId: null,
        createdAt: new Date(0),
        address,
        quotaBytes,
        status: "active",
        stalwartId: null,
        lastError: null,
        purgeAfter: null,
      });
      uow.state.aliases.push({
        id: randomUUID(),
        accountId,
        mailboxId,
        address: alias,
        kind: "alias",
        enabled: true,
        adminLocked: false,
        description: null,
        createdAt: new Date(0),
      });
      return { domainId, mailboxId };
    },
    seedAuth: async (userId, input) => {
      const s = uow.state;
      for (const x of input.sessions ?? []) {
        s.sessions.push({
          userId,
          id: x.id,
          createdAt: x.updatedAt,
          lastActiveAt: x.updatedAt,
          expiresAt: x.expiresAt,
          ip: x.ip ?? null,
          userAgent: x.userAgent ?? null,
        });
      }
      for (const p of input.passkeys ?? []) {
        s.passkeys.push({ userId, ...p, deviceType: "singleDevice", backedUp: false, aaguid: null });
      }
      if (input.recoveryCodes !== undefined) {
        s.twoFactor.push({ userId, verified: true, recoveryCodesLeft: input.recoveryCodes });
      }
      if (input.passkeyRecoveryCodes !== undefined) {
        s.twoFactor.push({ userId, verified: false, recoveryCodesLeft: input.passkeyRecoveryCodes });
      }
      for (let i = 0; i < (input.trustedDevices ?? 0); i++) s.trustedDevices.push({ userId, id: randomUUID() });
      for (const x of input.stepUps ?? []) s.stepUps.push({ userId, ...x });
    },
  };
});

describe("memory trust: a stored restriction with a reason the code doesn't know", () => {
  it("still reads as restricted (as other) in every reader", async () => {
    const uow = new MemoryUnitOfWork();
    const accountId = randomUUID();
    const mailboxId = randomUUID();
    uow.state.accounts.push({ id: accountId, name: "x", plan: "free" });
    uow.state.mailboxes.push({
      id: mailboxId,
      accountId,
      userId: null,
      createdAt: new Date(0),
      address: "x@retired.test",
      quotaBytes: 1,
      status: "active",
      stalwartId: null,
      lastError: null,
      purgeAfter: null,
    });
    const at = new Date("2026-11-11T12:00:00Z");
    // As a row written before a reason was retired from the code would read.
    uow.state.mailboxRestrictions.push({
      mailboxId,
      at,
      reason: "retired_reason" as SuspensionReason,
      note: null,
      byUserId: null,
    });
    const expected = { at, reason: "other", note: null, byUserId: null };
    expect((await uow.run((r) => r.trust.mailbox(accountId, mailboxId)))?.restriction).toEqual(expected);
    expect((await uow.run((r) => r.trust.mailboxes(accountId)))[0]?.restriction).toEqual(expected);
    expect((await uow.run((r) => r.trust.standingByAddress("x@retired.test")))?.mailboxRestricted).toBe(true);
  });
});
