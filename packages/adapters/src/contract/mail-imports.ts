// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Mail import repository contract (ADR-0030 §12), part of the adapter contract: memory in `npm test`, Postgres in
 * `npm run test:int`. Covers the one-live-import rule, account scoping, the wipe that comes with every terminal state,
 * folder paths going with it, and the runner's lease rules (claim caps, token-conditional writes).
 *
 * The test database is shared: each run uses its own random moment far in the past for `run_after`, and claims skip
 * (and end) anything older that isn't this test's, as the provisioning contract does with jobs.
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { UnitOfWork } from "@anhourmail/core";
import {
  DEFAULT_IMPORT_OPTIONS,
  type MailImport,
  type MailImportFolder,
  type NewMailImport,
} from "@anhourmail/core/imports";

import type { AdapterFactory } from ".";

const MIN = 60_000;
const DAY = 86_400_000;

/** A random moment in the 1990s for this run (claims compare `run_after` with it). */
const moment = () => new Date(Date.UTC(1990, 0, 1) + Math.floor(Math.random() * 3650) * DAY);

async function mailbox(factory: Awaited<ReturnType<AdapterFactory>>) {
  const tag = randomUUID().slice(0, 8);
  const domain = `imp-${tag}.test`;
  const { mailboxId } = await factory.seedMail({
    domain,
    address: `a@${domain}`,
    alias: `b@${domain}`,
    quotaBytes: 1024,
  });
  const accountId = (await factory.uow.run((r) => r.directory.getMailbox(mailboxId)))?.accountId ?? "";
  return { accountId, mailboxId };
}

const newImport = (
  accountId: string,
  mailboxId: string,
  at: Date,
  over: Partial<NewMailImport> = {},
): NewMailImport => ({
  id: randomUUID(),
  accountId,
  mailboxId,
  batchId: null,
  requestedBy: null,
  requestedAs: "own",
  sourceKind: "imap_password",
  sourceHost: "imap.example.org",
  sourcePort: 993,
  sourceUsername: "someone@example.org",
  sourceSecret: "v1.k1.sealed-source",
  destinationSecret: "v1.k1.sealed-destination",
  destinationCredentialId: "c1",
  destinationCredentialCreatedAt: at,
  destinationCredentialExpiresAt: new Date(at.getTime() + 7 * DAY),
  options: DEFAULT_IMPORT_OPTIONS,
  syncUntil: null,
  createdAt: at,
  runAfter: at,
  ...over,
});

const folder = (importId: string, at: Date, over: Partial<MailImportFolder> = {}): MailImportFolder => ({
  id: randomUUID(),
  importId,
  role: "inbox",
  sourcePath: "v1.k1.sealed-path",
  uidValidity: 1_700_000_000n,
  lastUid: 0n,
  messagesTotal: 10,
  messagesDone: 0,
  duplicates: 0,
  tooLarge: 0,
  failed: 0,
  bytesDone: 0,
  status: "pending",
  updatedAt: at,
  ...over,
});

/** Claims until one of `ids` comes up; anything else due before it (other runs' leftovers) is ended. */
async function claimMine(
  uow: UnitOfWork,
  at: Date,
  ids: string[],
  opts: { perAccount?: number; global?: number } = {},
): Promise<MailImport | null> {
  for (let i = 0; i < 50; i++) {
    const token = randomUUID();
    const got = await uow.run((r) =>
      r.imports.claim(at, { token, leaseMs: 2 * MIN, perAccount: opts.perAccount ?? 2, global: opts.global ?? 1000 }),
    );
    if (!got) return null;
    if (ids.includes(got.id)) return got;
    await uow.run((r) => r.imports.end(got.id, { status: "failed", at, errorCode: "test_leftover" }));
  }
  throw new Error("claim never reached this test's imports");
}

export function describeMailImportContract(name: string, factory: AdapterFactory): void {
  describe(`${name} mail import repository`, () => {
    it("records one live import per mailbox, scoped to its account", async () => {
      const f = await factory();
      try {
        const T = moment();
        const { accountId, mailboxId } = await mailbox(f);
        const other = await mailbox(f);
        const first = newImport(accountId, mailboxId, T);
        expect(await f.uow.run((r) => r.imports.insert(first))).toBe("ok");
        // A second live import into the same mailbox is refused and nothing is written (the transaction goes on).
        const second = newImport(accountId, mailboxId, T);
        const out = await f.uow.run(async (r) => {
          const res = await r.imports.insert(second);
          return { res, after: await r.imports.getById(second.id) };
        });
        expect(out).toEqual({ res: "import_running", after: null });

        const got = await f.uow.run((r) => r.imports.get(accountId, first.id));
        expect(got).toMatchObject({
          id: first.id,
          status: "queued",
          phase: null,
          sourceHost: "imap.example.org",
          sourcePort: 993,
          sourceSecret: "v1.k1.sealed-source",
          destinationSecret: "v1.k1.sealed-destination",
          options: DEFAULT_IMPORT_OPTIONS,
          messagesDone: 0,
          attempts: 0,
          leaseToken: null,
          credentialsWipedAt: null,
        });
        // Another account's id, or the wrong account for this id: nothing.
        expect(await f.uow.run((r) => r.imports.get(other.accountId, first.id))).toBeNull();
        expect(await f.uow.run((r) => r.imports.get(accountId, randomUUID()))).toBeNull();
        expect(await f.uow.run((r) => r.imports.get(accountId, "not-a-uuid"))).toBeNull();
        expect(await f.uow.run((r) => r.imports.list(other.accountId, { mailboxIds: null, limit: 10 }))).toEqual([]);
        expect((await f.uow.run((r) => r.imports.activeForMailbox(mailboxId)))?.id).toBe(first.id);

        // Once it ends, the mailbox can have another one; list is newest first and filters by mailbox.
        await f.uow.run((r) => r.imports.end(first.id, { status: "completed", at: T }));
        expect(await f.uow.run((r) => r.imports.activeForMailbox(mailboxId))).toBeNull();
        const third = newImport(accountId, mailboxId, new Date(T.getTime() + MIN));
        expect(await f.uow.run((r) => r.imports.insert(third))).toBe("ok");
        const list = await f.uow.run((r) => r.imports.list(accountId, { mailboxIds: null, limit: 10 }));
        expect(list.map((i) => i.id)).toEqual([third.id, first.id]);
        expect(await f.uow.run((r) => r.imports.list(accountId, { mailboxIds: [], limit: 10 }))).toEqual([]);
        expect(
          (await f.uow.run((r) => r.imports.list(accountId, { mailboxIds: [mailboxId], limit: 1 }))).map((i) => i.id),
        ).toEqual([third.id]);
        await f.uow.run((r) => r.imports.end(third.id, { status: "cancelled", at: T }));
      } finally {
        await f.cleanup();
      }
    });

    it("wipes both secrets, the username and folder paths in the write that ends it, exactly once", async () => {
      const f = await factory();
      try {
        const T = moment();
        const { accountId, mailboxId } = await mailbox(f);
        const row = newImport(accountId, mailboxId, T);
        await f.uow.run((r) => r.imports.insert(row));
        const inbox = folder(row.id, T);
        const custom = folder(row.id, T, { role: null, sourcePath: "v1.k1.sealed-custom" });
        expect(await f.uow.run((r) => r.imports.saveFolder(inbox, null))).toBe(true);
        expect(await f.uow.run((r) => r.imports.saveFolder(custom, null))).toBe(true);

        // Live changes go through `update`; a terminal status can't (only `end` gets there).
        const paused = await f.uow.run((r) => r.imports.update(row.id, { status: "paused", pauseRequested: false }));
        expect(paused?.status).toBe("paused");
        await expect(
          f.uow.run((r) => r.imports.update(row.id, { status: "completed" as unknown as "paused" })),
        ).rejects.toThrow(/end\(\)/);

        const ended = await f.uow.run((r) =>
          r.imports.end(row.id, { status: "failed", at: new Date(T.getTime() + MIN), errorCode: "secret_unreadable" }),
        );
        expect(ended).toMatchObject({
          status: "failed",
          errorCode: "secret_unreadable",
          sourceSecret: null,
          destinationSecret: null,
          sourceUsername: null,
          // Finished history keeps only the registrable domain of the source.
          sourceHost: "example.org",
          credentialsWipedAt: new Date(T.getTime() + MIN),
          finishedAt: new Date(T.getTime() + MIN),
          leaseToken: null,
          // Kept for the revoke job (id and creation time).
          destinationCredentialId: "c1",
          destinationCredentialCreatedAt: T,
        });
        const folders = await f.uow.run((r) => r.imports.folders(row.id));
        expect(folders.map((x) => [x.id, x.role, x.sourcePath])).toEqual([
          [inbox.id, "inbox", null],
          [custom.id, null, null],
        ]);
        expect(folders[0]?.uidValidity).toBe(1_700_000_000n);

        // Ended once: a second end, an update or a folder write after it changes nothing (no secret comes back).
        expect(await f.uow.run((r) => r.imports.end(row.id, { status: "completed", at: T }))).toBeNull();
        expect(await f.uow.run((r) => r.imports.update(row.id, { destinationSecret: "v1.k1.again" }))).toBeNull();
        expect(await f.uow.run((r) => r.imports.saveFolder({ ...inbox, sourcePath: "v1.k1.again" }, null))).toBe(false);
        expect((await f.uow.run((r) => r.imports.getById(row.id)))?.destinationSecret).toBeNull();
        expect(await f.uow.run((r) => r.imports.end(randomUUID(), { status: "completed", at: T }))).toBeNull();
        expect(await f.uow.run((r) => r.imports.wipeLeftovers(T, 100))).not.toContain(row.id);
      } finally {
        await f.cleanup();
      }
    });

    it("claims due imports under the per-account cap, and every runner write needs the lease", async () => {
      const f = await factory();
      try {
        const T = moment();
        const a = await mailbox(f);
        const b = await mailbox(f);
        const one = newImport(a.accountId, a.mailboxId, T);
        const later = newImport(b.accountId, b.mailboxId, new Date(T.getTime() + MIN), {
          runAfter: new Date(T.getTime() + 10 * MIN),
        });
        await f.uow.run((r) => r.imports.insert(one));
        await f.uow.run((r) => r.imports.insert(later));

        const got = await claimMine(f.uow, T, [one.id, later.id]);
        expect(got).toMatchObject({ id: one.id, status: "running", startedAt: T });
        const token = got?.leaseToken ?? "";
        expect(got?.leaseUntil).toEqual(new Date(T.getTime() + 2 * MIN));
        // Leased and not yet due: nothing more to claim now.
        expect(await claimMine(f.uow, T, [one.id, later.id])).toBeNull();

        // Lease-conditional writes: the holder succeeds, anyone else doesn't.
        expect(await f.uow.run((r) => r.imports.renewLease(one.id, token, new Date(T.getTime() + 3 * MIN)))).toBe(true);
        expect(await f.uow.run((r) => r.imports.renewLease(one.id, "stolen", new Date(T.getTime() + 9 * MIN)))).toBe(
          false,
        );
        expect(
          await f.uow.run((r) =>
            r.imports.progress(one.id, token, { phase: "copying", messagesDone: 3, bytesDone: 900 }),
          ),
        ).toBe(true);
        expect(await f.uow.run((r) => r.imports.progress(one.id, "stolen", { messagesDone: 99 }))).toBe(false);
        const f1 = folder(one.id, T);
        expect(await f.uow.run((r) => r.imports.saveFolder({ ...f1, lastUid: 42n }, token))).toBe(true);
        expect(await f.uow.run((r) => r.imports.saveFolder({ ...f1, lastUid: 99n }, "stolen"))).toBe(false);
        expect((await f.uow.run((r) => r.imports.folders(one.id)))[0]?.lastUid).toBe(42n);
        expect((await f.uow.run((r) => r.imports.getById(one.id)))?.messagesDone).toBe(3);

        // An expired lease can be claimed again by another runner; the old token then can't write.
        const again = await claimMine(f.uow, new Date(T.getTime() + 4 * MIN), [one.id]);
        expect(again?.id).toBe(one.id);
        expect(again?.leaseToken).not.toBe(token);
        expect(again?.startedAt).toEqual(T);
        expect(await f.uow.run((r) => r.imports.progress(one.id, token, { messagesDone: 1 }))).toBe(false);

        // Release gives it back with the next state.
        expect(
          await f.uow.run((r) =>
            r.imports.release(one.id, again?.leaseToken ?? "", {
              status: "syncing",
              runAfter: new Date(T.getTime() + 30 * MIN),
              attempts: 0,
            }),
          ),
        ).toBe(true);
        const released = await f.uow.run((r) => r.imports.getById(one.id));
        expect(released).toMatchObject({ status: "syncing", leaseToken: null, leaseUntil: null });

        // At +30 minutes both are due; the earlier run_after (the second mailbox's) comes first. A syncing import keeps
        // its status when claimed.
        const at30 = new Date(T.getTime() + 30 * MIN);
        expect((await claimMine(f.uow, at30, [one.id, later.id]))?.id).toBe(later.id);
        const sync = await claimMine(f.uow, at30, [one.id, later.id]);
        expect(sync).toMatchObject({ id: one.id, status: "syncing" });

        // Ending wins over a runner: its token stops working.
        await f.uow.run((r) => r.imports.end(one.id, { status: "cancelled", at: at30 }));
        expect(await f.uow.run((r) => r.imports.release(one.id, sync?.leaseToken ?? "", { attempts: 1 }))).toBe(false);
        await f.uow.run((r) => r.imports.end(later.id, { status: "cancelled", at: at30 }));
      } finally {
        await f.cleanup();
      }
    });

    it("never gives one import to two runners claiming at the same moment", async () => {
      const f = await factory();
      try {
        const T = moment();
        // Nothing else due at T may get in the way (other runs' leftovers are ended).
        for (let i = 0; i < 100; i++) {
          const other = await f.uow.run((r) =>
            r.imports.claim(T, { token: randomUUID(), leaseMs: MIN, perAccount: 1000, global: 1_000_000 }),
          );
          if (!other) break;
          await f.uow.run((r) => r.imports.end(other.id, { status: "failed", at: T, errorCode: "test_leftover" }));
        }
        const a = await mailbox(f);
        const one = newImport(a.accountId, a.mailboxId, T);
        await f.uow.run((r) => r.imports.insert(one));
        const claimOnce = () =>
          f.uow.run((r) =>
            r.imports.claim(T, { token: randomUUID(), leaseMs: MIN, perAccount: 1000, global: 1_000_000 }),
          );
        const got = await Promise.all([claimOnce(), claimOnce(), claimOnce()]);
        const winners = got.filter((g) => g !== null);
        expect(winners.map((g) => g.id)).toEqual([one.id]);
        expect((await f.uow.run((r) => r.imports.getById(one.id)))?.leaseToken).toBe(winners[0]?.leaseToken);
        await f.uow.run((r) => r.imports.end(one.id, { status: "cancelled", at: T }));
      } finally {
        await f.cleanup();
      }
    });

    it("holds the per-account and global caps when claiming", async () => {
      const f = await factory();
      try {
        const T = moment();
        const a = await mailbox(f);
        // A second mailbox in the same account.
        const sibling = randomUUID();
        await f.uow.run((r) =>
          r.mailboxes.insert({
            id: sibling,
            accountId: a.accountId,
            userId: null,
            address: `sibling-${sibling.slice(0, 8)}@imp.test`,
            status: "active",
            quotaBytes: 1024,
            stalwartId: null,
            lastError: null,
            purgeAfter: null,
            createdAt: T,
          }),
        );
        const x = newImport(a.accountId, a.mailboxId, T);
        const y = newImport(a.accountId, sibling, T);
        await f.uow.run((r) => r.imports.insert(x));
        await f.uow.run((r) => r.imports.insert(y));
        // Global cap 0: nothing at all; per account 0: none of these.
        expect(
          await f.uow.run((r) => r.imports.claim(T, { token: "t", leaseMs: MIN, perAccount: 2, global: 0 })),
        ).toBeNull();
        expect(await claimMine(f.uow, T, [x.id, y.id], { perAccount: 0 })).toBeNull();
        // One per account: the first is claimed, the second waits while the first's lease lives.
        const first = await claimMine(f.uow, T, [x.id, y.id], { perAccount: 1 });
        expect([x.id, y.id]).toContain(first?.id);
        expect(await claimMine(f.uow, T, [x.id, y.id], { perAccount: 1 })).toBeNull();
        // Two per account: the other one now.
        const next = await claimMine(f.uow, T, [x.id, y.id], { perAccount: 2 });
        expect(new Set([first?.id, next?.id])).toEqual(new Set([x.id, y.id]));
        await f.uow.run((r) => r.imports.end(x.id, { status: "cancelled", at: T }));
        await f.uow.run((r) => r.imports.end(y.id, { status: "cancelled", at: T }));
      } finally {
        await f.cleanup();
      }
    });

    it("finds waiting imports past their credential or sync window, and terminal ones to notify once", async () => {
      const f = await factory();
      try {
        const T = moment();
        const a = await mailbox(f);
        const b = await mailbox(f);
        const c = await mailbox(f);
        const expiring = newImport(a.accountId, a.mailboxId, T, { destinationCredentialExpiresAt: T });
        const syncing = newImport(b.accountId, b.mailboxId, T, { syncUntil: T });
        const done = newImport(c.accountId, c.mailboxId, T);
        for (const x of [expiring, syncing, done]) await f.uow.run((r) => r.imports.insert(x));
        await f.uow.run((r) => r.imports.update(expiring.id, { status: "blocked", blockedReason: "source_auth" }));
        await f.uow.run((r) => r.imports.update(syncing.id, { status: "syncing" }));
        await f.uow.run((r) => r.imports.end(done.id, { status: "completed", at: T }));

        const past = await f.uow.run((r) => r.imports.pastCredential(T, 1000));
        expect(past.map((i) => i.id)).toContain(expiring.id);
        expect(past.map((i) => i.id)).not.toContain(syncing.id);
        expect(
          (await f.uow.run((r) => r.imports.pastCredential(new Date(T.getTime() - 1), 1000))).map((i) => i.id),
        ).not.toContain(expiring.id);
        expect((await f.uow.run((r) => r.imports.pastSyncWindow(T, 1000))).map((i) => i.id)).toContain(syncing.id);

        const unnotified = await f.uow.run((r) => r.imports.unnotified(1000));
        expect(unnotified.map((i) => i.id)).toContain(done.id);
        expect(unnotified.map((i) => i.id)).not.toContain(expiring.id);
        expect(await f.uow.run((r) => r.imports.markNotified(done.id, T))).toBe(true);
        expect(await f.uow.run((r) => r.imports.markNotified(done.id, T))).toBe(false);
        expect(await f.uow.run((r) => r.imports.markNotified(expiring.id, T))).toBe(false);
        expect((await f.uow.run((r) => r.imports.unnotified(1000))).map((i) => i.id)).not.toContain(done.id);
        await f.uow.run((r) => r.imports.end(expiring.id, { status: "failed", at: T, errorCode: "expired" }));
        await f.uow.run((r) => r.imports.end(syncing.id, { status: "completed", at: T }));
      } finally {
        await f.cleanup();
      }
    });

    it("groups an admin's batch, scoped to the account", async () => {
      const f = await factory();
      try {
        const T = moment();
        const a = await mailbox(f);
        const other = await mailbox(f);
        const batch = { id: randomUUID(), accountId: a.accountId, createdBy: null, rows: 2, createdAt: T };
        await f.uow.run((r) => r.imports.insertBatch(batch));
        const row = newImport(a.accountId, a.mailboxId, T, { batchId: batch.id, requestedAs: "admin" });
        await f.uow.run((r) => r.imports.insert(row));
        expect(await f.uow.run((r) => r.imports.getBatch(a.accountId, batch.id))).toEqual(batch);
        expect(await f.uow.run((r) => r.imports.getBatch(other.accountId, batch.id))).toBeNull();
        expect((await f.uow.run((r) => r.imports.listBatch(a.accountId, batch.id))).map((i) => i.id)).toEqual([row.id]);
        expect(await f.uow.run((r) => r.imports.listBatch(other.accountId, batch.id))).toEqual([]);
        expect((await f.uow.run((r) => r.imports.getById(row.id)))?.requestedAs).toBe("admin");
        await f.uow.run((r) => r.imports.end(row.id, { status: "cancelled", at: T }));
      } finally {
        await f.cleanup();
      }
    });

    it("sums what a mailbox's imports copied in a window, leaving one out", async () => {
      const f = await factory();
      try {
        const T = moment();
        const a = await mailbox(f);
        const first = newImport(a.accountId, a.mailboxId, T);
        await f.uow.run((r) => r.imports.insert(first));
        await f.uow.run((r) => r.imports.update(first.id, { messagesDone: 5 }));
        await f.uow.run((r) => r.imports.end(first.id, { status: "completed", at: T }));
        const second = newImport(a.accountId, a.mailboxId, new Date(T.getTime() + 1000));
        await f.uow.run((r) => r.imports.insert(second));
        await f.uow.run((r) => r.imports.update(second.id, { messagesDone: 2 }));
        const since = new Date(T.getTime() - 1000);
        expect(await f.uow.run((r) => r.imports.messagesCopiedInto(a.mailboxId, since, second.id))).toBe(5);
        expect(await f.uow.run((r) => r.imports.messagesCopiedInto(a.mailboxId, since, first.id))).toBe(2);
        const later = new Date(T.getTime() + 500);
        expect(await f.uow.run((r) => r.imports.messagesCopiedInto(a.mailboxId, later, second.id))).toBe(0);
        await f.uow.run((r) => r.imports.end(second.id, { status: "cancelled", at: T }));
      } finally {
        await f.cleanup();
      }
    });

    it("answers new as the trust tier of an unknown or missing login", async () => {
      const f = await factory();
      try {
        expect(await f.uow.run((r) => r.imports.trustTier(null))).toBe("new");
        expect(await f.uow.run((r) => r.imports.trustTier(`nobody-${randomUUID()}`))).toBe("new");
      } finally {
        await f.cleanup();
      }
    });
  });
}
