// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { deps as makeDeps, fixedClock } from "../__tests__/helpers";
import type { Repositories } from "../ports";

import { runTrustPromotion } from "./promote";

const NOW = "2026-11-11T12:00:00Z";
const HOUR = 3_600_000;
const SETTINGS = { minAgeHours: 48, maxHeld: 3, batch: 10 };
const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;

function world() {
  const clock = fixedClock(NOW);
  const d = makeDeps(clock);
  const s = d.uow.state;
  /** An account `ageHours` old with a confirmed owner and one active mailbox. */
  const account = (n: number, ageHours: number) => {
    const accountId = id(n);
    s.accounts.push({
      id: accountId,
      name: `A${String(n)}`,
      plan: "free",
      createdAt: new Date(clock.now().getTime() - ageHours * HOUR),
    });
    s.memberships.push({ userId: `owner-${String(n)}`, accountId, role: "owner" });
    s.mailboxes.push({
      id: id(100 + n),
      accountId,
      userId: `owner-${String(n)}`,
      address: `owner${String(n)}@a.test`,
      status: "active",
      quotaBytes: 1,
      stalwartId: null,
      lastError: null,
      purgeAfter: null,
      createdAt: clock.now(),
    });
    return accountId;
  };
  const held = (accountId: string, hoursAgo: number) =>
    d.uow.run((r) =>
      r.audit.append(
        {
          scope: `account:${accountId}`,
          action: "trust.send_held",
          actor: { type: "user", userId: null, email: null, role: null, accountId },
          onBehalfOf: null,
          target: { type: "mailbox", id: null, label: null },
          result: "denied",
          errorCode: "sending_held",
          requestId: "r",
          ip: null,
          userAgent: null,
          meta: { externalRecipients: 1 },
        },
        new Date(clock.now().getTime() - hoursAgo * HOUR),
      ),
    );
  const tier = (accountId: string) => d.uow.run(async (r) => (await r.trust.get(accountId))?.tier);
  return { d, s, clock, account, held, tier };
}

describe("runTrustPromotion (job:trust-promote)", () => {
  it("promotes established accounts in good standing, audited by the system, mailboxes queued", async () => {
    const w = world();
    const old = w.account(1, 72);
    const young = w.account(2, 24);
    const run = await runTrustPromotion(w.d, SETTINGS);
    expect(run).toEqual({ candidates: 1, promoted: 1, skipped: 0, failed: 0 });
    expect(await w.tier(old)).toBe("standard");
    expect(await w.tier(young)).toBe("new");
    const entry = w.s.audit.find((e) => e.action === "trust.tier_changed");
    expect(entry).toMatchObject({
      scope: `account:${old}`,
      result: "success",
      actor: { type: "system", email: "trust-promote" },
      meta: { fromTier: "new", toTier: "standard", source: "automatic", mailboxesQueued: 1 },
    });
    expect(w.s.jobs.filter((j) => j.kind === "mailbox.ensure").map((j) => j.subjectId)).toEqual([id(101)]);
    // A second run finds nothing: promotion is idempotent.
    expect(await runTrustPromotion(w.d, SETTINGS)).toEqual({ candidates: 0, promoted: 0, skipped: 0, failed: 0 });
  });

  it("skips accounts with too many held sends in the window; older ones don't count", async () => {
    const w = world();
    const busy = w.account(1, 72);
    const calm = w.account(2, 72);
    for (const h of [1, 2, 3]) await w.held(busy, h);
    for (const h of [49, 50, 51, 60]) await w.held(calm, h);
    const run = await runTrustPromotion(w.d, SETTINGS);
    expect(run.promoted).toBe(1);
    expect(await w.tier(busy)).toBe("new");
    expect(await w.tier(calm)).toBe("standard");
  });

  it("promotes at most the batch, oldest first", async () => {
    const w = world();
    const ids = [w.account(1, 100), w.account(2, 300), w.account(3, 200)];
    expect(await runTrustPromotion(w.d, { ...SETTINGS, batch: 2 })).toMatchObject({ candidates: 2, promoted: 2 });
    expect(await Promise.all(ids.map(w.tier))).toEqual(["new", "standard", "standard"]);
  });

  it("an account that stopped qualifying under the lock is skipped; one that fails rolls back alone", async () => {
    const w = world();
    const suspendedMeanwhile = w.account(1, 300);
    const failing = w.account(2, 200);
    const fine = w.account(3, 100);
    const run = w.d.uow.run.bind(w.d.uow);
    w.d.uow.run = <T>(fn: (r: Repositories) => Promise<T>) =>
      run((r) =>
        fn({
          ...r,
          accounts: {
            ...r.accounts,
            lock: async (accountId: string) => {
              if (accountId === suspendedMeanwhile) {
                const a = w.s.accounts.find((x) => x.id === accountId);
                if (a) a.status = "suspended";
              }
              await r.accounts.lock(accountId);
            },
          },
          provisioning: {
            ...r.provisioning,
            enqueue: async (job) => {
              if (job.subjectId === id(102)) throw new Error("queue down");
              return r.provisioning.enqueue(job);
            },
          },
        }),
      );
    expect(await runTrustPromotion(w.d, SETTINGS)).toEqual({ candidates: 3, promoted: 1, skipped: 1, failed: 1 });
    w.d.uow.run = run;
    expect(await w.tier(suspendedMeanwhile)).toBe("new");
    expect(await w.tier(failing)).toBe("new");
    expect(await w.tier(fine)).toBe("standard");
    expect(w.s.audit.filter((e) => e.action === "trust.tier_changed").map((e) => e.scope)).toEqual([`account:${fine}`]);
  });
});
