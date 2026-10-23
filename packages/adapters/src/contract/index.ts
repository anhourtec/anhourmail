// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared contract every adapter must pass (ADR-0008). Swapping the database = a new adapter that passes these,
 * with no service or UI changes. Run by memory.test.ts (unit) and postgres.int.test.ts (integration).
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ConflictError, type UnitOfWork } from "@anhourmail/core";
import { type AuditEntryInput, type AuditQuery, verifyChain } from "@anhourmail/core/audit";

/** `createUser` makes a console user the adapter can reference (memberships need one in Postgres). */
export type AdapterFactory = () => Promise<{
  uow: UnitOfWork;
  cleanup: () => Promise<void>;
  createUser: (email: string) => Promise<string>;
  /** Seeds an active domain, an active mailbox and one alias; returns their ids. */
  seedMail: (input: { domain: string; address: string; alias: string; quotaBytes: number }) => Promise<{
    domainId: string;
    mailboxId: string;
  }>;
  /** Seeds identity-layer sign-in state for a user (sessions, passkeys, two-factor, trusted devices). */
  seedAuth: (userId: string, input: SeedAuth) => Promise<void>;
}>;

export type SeedAuth = {
  sessions?: { id: string; expiresAt: Date; updatedAt: Date; ip?: string; userAgent?: string }[];
  passkeys?: { id: string; name: string; createdAt: Date }[];
  /** Two-factor on, with this many unused recovery codes. */
  recoveryCodes?: number;
  trustedDevices?: number;
  /** Step-up markers ("confirmed it's you") for console sessions. */
  stepUps?: { sessionId: string; expiresAt: Date }[];
};

const auditInput = (
  scope: AuditEntryInput["scope"],
  action: AuditEntryInput["action"] = "account.created",
): AuditEntryInput => ({
  scope,
  action,
  actor: { type: "anonymous", userId: null, email: null, role: null, accountId: null },
  onBehalfOf: null,
  target: { type: "account", id: null, label: null },
  result: "success",
  errorCode: null,
  requestId: "req-1",
  ip: null,
  userAgent: null,
  meta: { n: 1 },
});

export function describeAdapterContract(name: string, factory: AdapterFactory): void {
  describe(`${name} adapter contract`, () => {
    it("unit of work is atomic: a throw rolls back every write, audit included", async () => {
      const { uow, cleanup } = await factory();
      try {
        const scope = `account:${randomUUID()}` as const;
        let created = "";
        await expect(
          uow.run(async (r) => {
            created = (await r.accounts.create({ name: `Contract rollback ${randomUUID()}`, plan: "free" })).id;
            await r.audit.append(auditInput(scope), new Date());
            throw new Error("boom");
          }),
        ).rejects.toThrow("boom");
        expect(created).not.toBe("");
        expect(await uow.run((r) => r.accounts.get(created))).toBeNull();
        expect(await uow.run((r) => r.audit.chain(scope))).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    it("audit: per-scope hash chain, newest-first list, filters, verifiable", async () => {
      const { uow, cleanup } = await factory();
      try {
        const scope = `account:${randomUUID()}` as const;
        const other = `account:${randomUUID()}` as const;
        for (let i = 0; i < 3; i++) await uow.run((r) => r.audit.append(auditInput(scope), new Date()));
        await uow.run((r) => r.audit.append(auditInput(other, "domain.added"), new Date()));
        const chain = await uow.run((r) => r.audit.chain(scope));
        expect(chain.map((e) => e.seq)).toEqual([1, 2, 3]);
        expect(verifyChain(chain)).toBeNull();
        expect(chain[1]?.prevHash).toBe(chain[0]?.hash);
        const listed = await uow.run((r) => r.audit.list({ scope, limit: 2 }));
        expect(listed.map((e) => e.seq)).toEqual([3, 2]);
        const paged = await uow.run((r) => r.audit.list({ scope, limit: 10, beforeSeq: 2 }));
        expect(paged.map((e) => e.seq)).toEqual([1]);
        expect(await uow.run((r) => r.audit.list({ scope, limit: 10, action: "domain.added" }))).toEqual([]);
        const otherChain = await uow.run((r) => r.audit.chain(other));
        expect(otherChain).toHaveLength(1);
        expect(otherChain[0]?.meta).toEqual({ n: 1 });
      } finally {
        await cleanup();
      }
    });

    it("audit: concurrent appends never fork the chain", async () => {
      const { uow, cleanup } = await factory();
      try {
        const scope = `account:${randomUUID()}` as const;
        await Promise.all(
          Array.from({ length: 8 }, () => uow.run((r) => r.audit.append(auditInput(scope), new Date()))),
        );
        const chain = await uow.run((r) => r.audit.chain(scope));
        expect(chain.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(verifyChain(chain)).toBeNull();
      } finally {
        await cleanup();
      }
    });

    it("accounts: create, add member, membership count, names", async () => {
      const { uow, cleanup, createUser } = await factory();
      try {
        const userId = await createUser(`acct-${randomUUID()}@example.com`);
        expect(await uow.run((r) => r.accounts.membershipCount(userId))).toBe(0);
        const { id } = await uow.run((r) => r.accounts.create({ name: "Contract family", plan: "free" }));
        await uow.run(async (r) => {
          await r.accounts.addMember({ accountId: id, userId, role: "owner" });
          await r.accounts.setUserState({ userId, state: "free" });
        });
        expect(await uow.run((r) => r.accounts.membershipCount(userId))).toBe(1);
        expect(await uow.run((r) => r.access.memberships(userId))).toEqual([{ accountId: id, role: "owner" }]);
        expect(await uow.run((r) => r.access.accountNames([id]))).toEqual({ [id]: "Contract family" });
        await expect(uow.run((r) => r.accounts.addMember({ accountId: id, userId, role: "member" }))).rejects.toThrow();
      } finally {
        await cleanup();
      }
    });

    it("accounts: get returns the plan; unknown ids are null", async () => {
      const { uow, cleanup } = await factory();
      try {
        const { id } = await uow.run((r) => r.accounts.create({ name: "Contract plan", plan: "plus" }));
        expect(await uow.run((r) => r.accounts.get(id))).toMatchObject({ id, name: "Contract plan", plan: "plus" });
        expect(await uow.run((r) => r.accounts.get(randomUUID()))).toBeNull();
        // Locking is a no-op outside a contended write, and locking an unknown id is harmless.
        await uow.run(async (r) => {
          await r.accounts.lock(id);
          await r.accounts.lock(randomUUID());
        });
      } finally {
        await cleanup();
      }
    });

    it("domains: account-scoped reads, verified-only claims, conditional transitions, pending list", async () => {
      const { uow, cleanup } = await factory();
      try {
        const a = await uow.run((r) => r.accounts.create({ name: "Contract dom A", plan: "plus" }));
        const b = await uow.run((r) => r.accounts.create({ name: "Contract dom B", plan: "plus" }));
        const name = `c-${randomUUID().slice(0, 8)}.example.ca`;
        const at = new Date(Date.UTC(2200, 0, 1) + Math.floor(Math.random() * 1e9));
        const make = (accountId: string) => ({
          id: randomUUID(),
          accountId,
          name,
          status: "pending_dns" as const,
          verifyToken: randomUUID(),
          stalwartId: null,
          lastError: null,
          createdAt: at,
        });
        const mine = make(a.id);
        const theirs = make(b.id);
        await uow.run(async (r) => {
          await r.domains.insert(mine);
          await r.domains.insert(theirs); // two unverified claims on one name are allowed
        });
        await expect(uow.run((r) => r.domains.insert({ ...make(a.id) }))).rejects.toThrow(); // same account twice
        expect(await uow.run((r) => r.domains.get(a.id, mine.id))).toMatchObject({ name, status: "pending_dns" });
        expect(await uow.run((r) => r.domains.get(b.id, mine.id))).toBeNull();
        expect((await uow.run((r) => r.domains.listByAccount(a.id))).map((d) => d.id)).toEqual([mine.id]);
        expect(await uow.run((r) => r.domains.nameTaken(name))).toBe(false);
        const pending = await uow.run((r) => r.domains.pending(at, 1000));
        expect(pending.map((d) => d.id)).toEqual(expect.arrayContaining([mine.id, theirs.id]));

        expect(await uow.run((r) => r.domains.transition(mine.id, "pending_dns", "active"))).toBe(true);
        expect(await uow.run((r) => r.domains.transition(mine.id, "pending_dns", "active"))).toBe(false);
        expect(await uow.run((r) => r.domains.nameTaken(name))).toBe(true);
        // Only one verified claim per name, enforced by storage too.
        await expect(uow.run((r) => r.domains.transition(theirs.id, "pending_dns", "active"))).rejects.toThrow();
        expect(await uow.run((r) => r.domains.addressCount(name))).toBe(0);
        expect(await uow.run((r) => r.domains.deletePending(mine.id))).toBe(false); // active: not deleted
        expect(await uow.run((r) => r.domains.deletePending(theirs.id))).toBe(true);
        expect(await uow.run((r) => r.domains.get(b.id, theirs.id))).toBeNull();
        await uow.run((r) => r.domains.transition(mine.id, "active", "removing"));
        await uow.run((r) => r.directory.deleteDomain(mine.id));
        expect(await uow.run((r) => r.domains.get(a.id, mine.id))).toBeNull();
      } finally {
        await cleanup();
      }
    });

    it("mailboxes and members: account-scoped reads, global address check, quota, members by email", async () => {
      const { uow, cleanup, createUser } = await factory();
      try {
        const a = await uow.run((r) => r.accounts.create({ name: "Contract mbx A", plan: "plus" }));
        const b = await uow.run((r) => r.accounts.create({ name: "Contract mbx B", plan: "plus" }));
        const tag = randomUUID().slice(0, 8);
        const userId = await createUser(`zz-${tag}@example.com`);
        const other = await createUser(`aa-${tag}@example.com`);
        await uow.run(async (r) => {
          await r.accounts.addMember({ accountId: a.id, userId, role: "member" });
          await r.accounts.addMember({ accountId: a.id, userId: other, role: "owner" });
        });
        expect(await uow.run((r) => r.access.members(a.id))).toEqual([
          { userId: other, email: `aa-${tag}@example.com`, role: "owner" },
          { userId, email: `zz-${tag}@example.com`, role: "member" },
        ]);
        expect(await uow.run((r) => r.access.members(b.id))).toEqual([]);

        const m = {
          id: randomUUID(),
          accountId: a.id,
          userId,
          address: `box-${tag}@contract.example.ca`,
          status: "provisioning" as const,
          quotaBytes: 1024,
          stalwartId: null,
          lastError: null,
          purgeAfter: null,
          createdAt: new Date(),
        };
        await uow.run((r) => r.mailboxes.insert(m));
        expect(await uow.run((r) => r.mailboxes.get(a.id, m.id))).toMatchObject({ address: m.address, userId });
        expect(await uow.run((r) => r.mailboxes.get(b.id, m.id))).toBeNull();
        expect(await uow.run((r) => r.mailboxes.count(a.id))).toBe(1);
        expect((await uow.run((r) => r.mailboxes.listByAccount(a.id))).map((x) => x.id)).toEqual([m.id]);
        expect(await uow.run((r) => r.mailboxes.addressTaken(m.address))).toBe(true);
        expect(await uow.run((r) => r.mailboxes.addressTaken(`free-${tag}@contract.example.ca`))).toBe(false);
        await expect(uow.run((r) => r.mailboxes.insert({ ...m, id: randomUUID() }))).rejects.toThrow();
        await uow.run((r) => r.mailboxes.setQuota(m.id, 2048));
        expect((await uow.run((r) => r.mailboxes.get(a.id, m.id)))?.quotaBytes).toBe(2048);

        // Aliases: account-scoped, counted by kind, unique addresses (a duplicate is a conflict, not a crash).
        const alias = {
          id: randomUUID(),
          accountId: a.id,
          mailboxId: m.id,
          address: `hi-${tag}@contract.example.ca`,
          kind: "masked" as const,
          enabled: true,
          description: "shop",
          createdAt: new Date(),
        };
        await uow.run(async (r) => {
          await r.mailboxes.lockAddress(alias.address);
          await r.aliases.insert(alias);
        });
        expect(await uow.run((r) => r.aliases.get(a.id, alias.id))).toMatchObject({
          address: alias.address,
          kind: "masked",
        });
        expect(await uow.run((r) => r.aliases.get(b.id, alias.id))).toBeNull();
        expect(await uow.run((r) => r.aliases.count(a.id, "masked"))).toBe(1);
        expect(await uow.run((r) => r.aliases.count(a.id, "alias"))).toBe(0);
        expect((await uow.run((r) => r.aliases.listByAccount(a.id))).map((x) => x.id)).toEqual([alias.id]);
        expect(await uow.run((r) => r.aliases.listByAccount(b.id))).toEqual([]);
        expect(await uow.run((r) => r.mailboxes.addressTaken(alias.address))).toBe(true);
        await expect(uow.run((r) => r.aliases.insert({ ...alias, id: randomUUID() }))).rejects.toThrow(
          "already in use",
        );
        await uow.run((r) => r.aliases.setEnabled(alias.id, false));
        expect((await uow.run((r) => r.aliases.get(a.id, alias.id)))?.enabled).toBe(false);
        expect((await uow.run((r) => r.directory.getMailbox(m.id)))?.aliases).toEqual([
          { address: alias.address, kind: "masked", enabled: false, description: "shop" },
        ]);
        await uow.run((r) => r.aliases.delete(alias.id));
        expect(await uow.run((r) => r.aliases.get(a.id, alias.id))).toBeNull();
      } finally {
        await cleanup();
      }
    });

    it("provisioning: idempotent enqueue, ordered claim, retry, complete, give up", async () => {
      const { uow, cleanup } = await factory();
      try {
        const subject = randomUUID();
        const t0 = new Date(Date.UTC(2000, 0, 1));
        const a = await uow.run((r) =>
          r.provisioning.enqueue({ kind: "domain.ensure", subjectId: subject, runAfter: t0 }),
        );
        const again = await uow.run((r) =>
          r.provisioning.enqueue({ kind: "domain.ensure", subjectId: subject, runAfter: t0 }),
        );
        expect(again.id).toBe(a.id);
        const claimed = await uow.run((r) => r.provisioning.claimNext(new Date(Date.UTC(2000, 0, 2))));
        expect(claimed).toMatchObject({ id: a.id, status: "running", attempts: 1 });
        const future = new Date(Date.UTC(2999, 0, 1));
        await uow.run((r) => r.provisioning.retry(a.id, "boom", future, new Date()));
        expect(await uow.run((r) => r.provisioning.get(a.id))).toMatchObject({ status: "queued", lastError: "boom" });
        await uow.run((r) => r.provisioning.complete(a.id, new Date()));
        expect((await uow.run((r) => r.provisioning.get(a.id)))?.status).toBe("succeeded");
        const b = await uow.run((r) =>
          r.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: randomUUID(), runAfter: future }),
        );
        await uow.run((r) => r.provisioning.giveUp(b.id, "gave up", new Date()));
        expect(await uow.run((r) => r.provisioning.get(b.id))).toMatchObject({
          status: "failed",
          lastError: "gave up",
        });
        expect(await uow.run((r) => r.provisioning.get(randomUUID()))).toBeNull();
      } finally {
        await cleanup();
      }
    });

    it("provisioning: a job is claimed by exactly one of two concurrent workers", async () => {
      const { uow, cleanup } = await factory();
      try {
        // Far-past runAfter: this job is the oldest claimable one in a shared test database.
        const job = await uow.run((r) =>
          r.provisioning.enqueue({
            kind: "domain.ensure",
            subjectId: randomUUID(),
            runAfter: new Date(Date.UTC(1990, 0, 1)),
          }),
        );
        const now = new Date(Date.UTC(1990, 0, 2));
        const [x, y] = await Promise.all([
          uow.run((r) => r.provisioning.claimNext(now)),
          uow.run((r) => r.provisioning.claimNext(now)),
        ]);
        expect([x?.id, y?.id].filter((id) => id === job.id)).toHaveLength(1);
        await uow.run((r) => r.provisioning.complete(job.id, new Date()));
      } finally {
        await cleanup();
      }
    });

    it("provisioning: never claims a job whose subject already has a job running", async () => {
      const { uow, cleanup } = await factory();
      try {
        const subject = randomUUID();
        const other = randomUUID();
        const t0 = new Date(Date.UTC(1990, 0, 1));
        const now = new Date(Date.UTC(1990, 0, 2));
        const first = await uow.run((r) =>
          r.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: subject, runAfter: t0 }),
        );
        // Claim until we hold `first` (a shared database may have older claimable jobs; finish those).
        for (let i = 0; i < 50; i++) {
          const j = await uow.run((r) => r.provisioning.claimNext(now));
          if (!j || j.id === first.id) break;
          await uow.run((r) => r.provisioning.complete(j.id, new Date()));
        }
        expect((await uow.run((r) => r.provisioning.get(first.id)))?.status).toBe("running");
        // While it runs, a newer job for the same subject waits; another subject's job doesn't.
        const second = await uow.run((r) =>
          r.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: subject, runAfter: t0 }),
        );
        expect(second.id).not.toBe(first.id);
        const third = await uow.run((r) =>
          r.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: other, runAfter: t0 }),
        );
        const claimed: string[] = [];
        for (let i = 0; i < 50; i++) {
          const j = await uow.run((r) => r.provisioning.claimNext(now));
          if (!j) break;
          claimed.push(j.id);
          await uow.run((r) => r.provisioning.complete(j.id, new Date()));
          if (j.id === third.id) break;
        }
        expect(claimed).toContain(third.id);
        expect(claimed).not.toContain(second.id);
        // Once the first is done, the second can run.
        await uow.run((r) => r.provisioning.complete(first.id, new Date()));
        let got = false;
        for (let i = 0; i < 50 && !got; i++) {
          const j = await uow.run((r) => r.provisioning.claimNext(now));
          if (!j) break;
          got = j.id === second.id;
          await uow.run((r) => r.provisioning.complete(j.id, new Date()));
        }
        expect(got).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it("directory: mailbox with aliases, status updates, desired state", async () => {
      const { uow, cleanup, seedMail } = await factory();
      try {
        const tag = randomUUID().slice(0, 8);
        const domain = `c-${tag}.test`;
        const { domainId, mailboxId } = await seedMail({
          domain,
          address: `owner@${domain}`,
          alias: `hello@${domain}`,
          quotaBytes: 1024,
        });
        expect(await uow.run((r) => r.directory.getDomain(domainId))).toMatchObject({ name: domain, stalwartId: null });
        const mb = await uow.run((r) => r.directory.getMailbox(mailboxId));
        expect(mb).toMatchObject({ address: `owner@${domain}`, quotaBytes: 1024 });
        expect(mb?.aliases.map((a) => a.address)).toEqual([`hello@${domain}`]);
        await uow.run(async (r) => {
          await r.directory.markDomain(domainId, { stalwartId: "s-dom", lastError: null });
          await r.directory.markMailbox(mailboxId, { status: "active", stalwartId: "s-mb", lastError: null });
        });
        expect((await uow.run((r) => r.directory.getDomain(domainId)))?.stalwartId).toBe("s-dom");
        expect((await uow.run((r) => r.directory.getMailbox(mailboxId)))?.stalwartId).toBe("s-mb");
        const desired = await uow.run((r) => r.directory.desired());
        expect(desired.domains).toContain(domain);
        expect(desired.mailboxes).toContainEqual({
          id: mailboxId,
          address: `owner@${domain}`,
          quotaBytes: 1024,
          status: "active",
          provisioned: true,
        });
        expect(await uow.run((r) => r.directory.getMailbox("not-a-uuid"))).toBeNull();
      } finally {
        await cleanup();
      }
    });

    it("mailbox lifecycle: conditional transitions, purge listing, delete-if-due with its aliases", async () => {
      const { uow, cleanup, seedMail } = await factory();
      try {
        const tag = randomUUID().slice(0, 8);
        const domain = `life-${tag}.test`;
        const address = `owner@${domain}`;
        const alias = `hello@${domain}`;
        const { mailboxId } = await seedMail({ domain, address, alias, quotaBytes: 1024 });
        const accountId = (await uow.run((r) => r.directory.getMailbox(mailboxId)))?.accountId ?? "";

        // A new intent clears the error from applying the previous one.
        await uow.run((r) => r.directory.markMailbox(mailboxId, { status: "active", lastError: "Error: gave up" }));
        // Conditional: only from one of the listed statuses.
        expect(await uow.run((r) => r.mailboxes.transition(mailboxId, ["suspended"], "active", null))).toBe(false);
        expect(await uow.run((r) => r.mailboxes.transition(mailboxId, [], "suspended", null))).toBe(false);
        expect(await uow.run((r) => r.mailboxes.transition(mailboxId, ["active"], "suspended", null))).toBe(true);
        expect(await uow.run((r) => r.mailboxes.get(accountId, mailboxId))).toMatchObject({
          status: "suspended",
          purgeAfter: null,
          lastError: null,
        });

        // Far in the past, so this row sorts first among anything else due in a shared database.
        const purgeAfter = new Date(Date.UTC(1990, 0, 1));
        expect(
          await uow.run((r) => r.mailboxes.transition(mailboxId, ["active", "suspended"], "deleting", purgeAfter)),
        ).toBe(true);
        expect((await uow.run((r) => r.mailboxes.get(accountId, mailboxId)))?.purgeAfter).toEqual(purgeAfter);
        expect((await uow.run((r) => r.directory.getMailbox(mailboxId)))?.purgeAfter).toEqual(purgeAfter);
        expect((await uow.run((r) => r.directory.desired())).mailboxes).toContainEqual({
          id: mailboxId,
          address,
          quotaBytes: 1024,
          status: "deleting",
          provisioned: false,
        });

        // Not due before purgeAfter; due at or after it.
        const before = new Date(purgeAfter.getTime() - 1);
        expect((await uow.run((r) => r.mailboxes.dueForPurge(before, 1000))).map((m) => m.id)).not.toContain(mailboxId);
        expect((await uow.run((r) => r.mailboxes.dueForPurge(purgeAfter, 1000))).map((m) => m.id)).toContain(mailboxId);
        expect(await uow.run((r) => r.mailboxes.deleteIfDue(mailboxId, before))).toBe(false);

        // A restore wins: no longer deleting, so nothing is deleted.
        await uow.run((r) => r.mailboxes.transition(mailboxId, ["deleting"], "provisioning", null));
        expect(await uow.run((r) => r.mailboxes.deleteIfDue(mailboxId, new Date()))).toBe(false);
        expect((await uow.run((r) => r.mailboxes.dueForPurge(new Date(), 1000))).map((m) => m.id)).not.toContain(
          mailboxId,
        );

        await uow.run((r) => r.mailboxes.transition(mailboxId, ["provisioning"], "deleting", purgeAfter));
        expect(await uow.run((r) => r.mailboxes.deleteIfDue(mailboxId, new Date()))).toBe(true);
        expect(await uow.run((r) => r.mailboxes.get(accountId, mailboxId))).toBeNull();
        expect(await uow.run((r) => r.directory.getMailbox(mailboxId))).toBeNull();
        // Its aliases went with it, so both addresses are free again.
        expect(await uow.run((r) => r.mailboxes.addressTaken(address))).toBe(false);
        expect(await uow.run((r) => r.mailboxes.addressTaken(alias))).toBe(false);
        expect(await uow.run((r) => r.mailboxes.deleteIfDue(mailboxId, new Date()))).toBe(false);
      } finally {
        await cleanup();
      }
    });

    it("mailbox passwords: a waiting hash, compare-and-clear when applied, recorded credential, reconciler view", async () => {
      const { uow, cleanup, seedMail } = await factory();
      try {
        const tag = randomUUID().slice(0, 8);
        const domain = `pw-${tag}.test`;
        const { mailboxId } = await seedMail({ domain, address: `a@${domain}`, alias: `b@${domain}`, quotaBytes: 1 });
        const other = await seedMail({
          domain: `pw2-${tag}.test`,
          address: `x@pw2-${tag}.test`,
          alias: `y@pw2-${tag}.test`,
          quotaBytes: 1,
        });
        const h1 = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdDE$aGFzaDE";
        const h2 = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdDI$aGFzaDI";
        expect(await uow.run((r) => r.mailboxPasswords.pending(mailboxId))).toBe(false);
        expect(await uow.run((r) => r.directory.getMailbox(mailboxId))).toMatchObject({
          pendingPasswordHash: null,
          passwordCredentialId: null,
        });
        await uow.run((r) => r.mailboxPasswords.setPending(mailboxId, h1, null));
        expect(await uow.run((r) => r.mailboxPasswords.pending(mailboxId))).toBe(true);
        expect(await uow.run((r) => r.mailboxPasswords.pending(other.mailboxId))).toBe(false);
        expect((await uow.run((r) => r.directory.getMailbox(mailboxId)))?.pendingPasswordHash).toBe(h1);
        // A newer password set meanwhile survives the older one being applied.
        await uow.run((r) => r.mailboxPasswords.setPending(mailboxId, h2, "g2"));
        await uow.run((r) => r.directory.passwordApplied(mailboxId, h1, "b"));
        expect(await uow.run((r) => r.directory.getMailbox(mailboxId))).toMatchObject({
          pendingPasswordHash: h2,
          pendingPasswordGrant: "g2",
          passwordCredentialId: "b",
        });
        await uow.run((r) =>
          r.directory.markMailbox(mailboxId, { status: "active", stalwartId: `s-${tag}`, lastError: null }),
        );
        expect(
          (await uow.run((r) => r.appPasswords.mailboxesOnServer())).find((x) => x.id === mailboxId),
        ).toMatchObject({
          passwordCredentialId: "b",
          passwordPending: true,
        });
        await uow.run((r) => r.directory.passwordApplied(mailboxId, h2, "c"));
        expect(await uow.run((r) => r.directory.getMailbox(mailboxId))).toMatchObject({
          pendingPasswordHash: null,
          pendingPasswordGrant: null,
          passwordCredentialId: "c",
        });
        // Recording only (no hash applied) leaves a waiting one alone; clearing drops it.
        await uow.run((r) => r.mailboxPasswords.setPending(mailboxId, h1, null));
        await uow.run((r) => r.directory.passwordApplied(mailboxId, null, "d"));
        expect(await uow.run((r) => r.directory.getMailbox(mailboxId))).toMatchObject({
          pendingPasswordHash: h1,
          passwordCredentialId: "d",
        });
        await uow.run((r) => r.directory.clearPendingPassword(mailboxId));
        expect(await uow.run((r) => r.mailboxPasswords.pending(mailboxId))).toBe(false);
        expect((await uow.run((r) => r.directory.getMailbox(other.mailboxId)))?.passwordCredentialId).toBeNull();
        // Unknown and malformed ids are no-ops.
        await uow.run(async (r) => {
          await r.directory.passwordApplied("not-a-uuid", null, "x");
          await r.directory.clearPendingPassword("not-a-uuid");
        });
      } finally {
        await cleanup();
      }
    });

    it("people: account-scoped list with names and join dates, conditional role change and removal", async () => {
      const { uow, cleanup, createUser } = await factory();
      try {
        const a = await uow.run((r) => r.accounts.create({ name: "Contract people A", plan: "plus" }));
        const b = await uow.run((r) => r.accounts.create({ name: "Contract people B", plan: "plus" }));
        const tag = randomUUID().slice(0, 8);
        const owner = await createUser(`aa-${tag}@example.com`);
        const kid = await createUser(`bb-${tag}@example.com`);
        await uow.run(async (r) => {
          await r.accounts.addMember({ accountId: a.id, userId: owner, role: "owner" });
          await r.accounts.addMember({ accountId: a.id, userId: kid, role: "member" });
        });
        const list = await uow.run((r) => r.people.list(a.id));
        expect(list.map((m) => [m.userId, m.email, m.role, m.suspended])).toEqual([
          [owner, `aa-${tag}@example.com`, "owner", false],
          [kid, `bb-${tag}@example.com`, "member", false],
        ]);
        expect(list[0]?.name).toBeTruthy();
        expect(list[0]?.joinedAt).toBeInstanceOf(Date);
        expect(await uow.run((r) => r.people.list(b.id))).toEqual([]);

        // Scoped writes: another account's id changes nothing.
        expect(await uow.run((r) => r.people.setRole(b.id, kid, "user_admin"))).toBe(false);
        expect(await uow.run((r) => r.people.setRole(a.id, kid, "user_admin"))).toBe(true);
        expect((await uow.run((r) => r.people.list(a.id)))[1]?.role).toBe("user_admin");
        expect(await uow.run((r) => r.people.remove(b.id, kid))).toBe(false);
        expect(await uow.run((r) => r.people.remove(a.id, kid))).toBe(true);
        expect(await uow.run((r) => r.people.remove(a.id, kid))).toBe(false);
        expect((await uow.run((r) => r.people.list(a.id))).map((m) => m.userId)).toEqual([owner]);

        // Logins by email (case-insensitive); creating one for a taken address is a conflict.
        expect((await uow.run((r) => r.people.userByEmail(`AA-${tag}@example.com`)))?.id).toBe(owner);
        expect(await uow.run((r) => r.people.userByEmail(`nobody-${tag}@example.com`))).toBeNull();
        const login = {
          email: `cc-${tag}@example.com`,
          name: "Cee Example",
          firstName: "Cee",
          lastName: "Example",
          passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA",
        };
        const { id } = await uow.run((r) => r.people.createLogin(login));
        expect(await uow.run((r) => r.people.userByEmail(login.email))).toEqual({ id, name: "Cee Example" });
        await expect(uow.run((r) => r.people.createLogin(login))).rejects.toThrow("already has a login");
      } finally {
        await cleanup();
      }
    });

    it("invites: scoped reads, pending list, token look-up, conditional reissue, revoke and single-use accept", async () => {
      const { uow, cleanup, createUser } = await factory();
      try {
        const a = await uow.run((r) => r.accounts.create({ name: "Contract invites A", plan: "plus" }));
        const b = await uow.run((r) => r.accounts.create({ name: "Contract invites B", plan: "plus" }));
        const tag = randomUUID().slice(0, 8);
        const now = new Date();
        const later = new Date(now.getTime() + 3600_000);
        const make = (email: string, tokenHash: string, createdAt: Date) =>
          uow.run((r) =>
            r.invites.create({
              accountId: a.id,
              email,
              role: "member",
              expiresAt: later,
              createdBy: null,
              createdAt,
              tokenHash,
            }),
          );
        const first = await make(`one-${tag}@example.com`, `h1-${tag}`, new Date(now.getTime() - 1000));
        const second = await make(`two-${tag}@example.com`, `h2-${tag}`, now);
        expect(first).toMatchObject({ accountId: a.id, status: "pending", role: "member" });
        expect((await uow.run((r) => r.invites.listPending(a.id))).map((i) => i.id)).toEqual([second.id, first.id]);
        expect(await uow.run((r) => r.invites.listPending(b.id))).toEqual([]);
        expect(await uow.run((r) => r.invites.get(b.id, first.id))).toBeNull();
        expect((await uow.run((r) => r.invites.get(a.id, first.id)))?.email).toBe(`one-${tag}@example.com`);
        expect((await uow.run((r) => r.invites.findByToken(`h1-${tag}`)))?.id).toBe(first.id);
        expect(await uow.run((r) => r.invites.findByToken(`nope-${tag}`))).toBeNull();

        // Reissue swaps the token: the old link stops matching.
        const fresh = new Date(now.getTime() + 7200_000);
        expect(await uow.run((r) => r.invites.reissue(first.id, `h1b-${tag}`, fresh))).toBe(true);
        expect(await uow.run((r) => r.invites.findByToken(`h1-${tag}`))).toBeNull();
        expect((await uow.run((r) => r.invites.findByToken(`h1b-${tag}`)))?.expiresAt).toEqual(fresh);

        // Accept is single-use and refused after expiry.
        const user = await createUser(`acc-${tag}@example.com`);
        expect(await uow.run((r) => r.invites.accept(first.id, user, new Date(fresh.getTime() + 1)))).toBe(false);
        expect(await uow.run((r) => r.invites.accept(first.id, user, now))).toBe(true);
        expect(await uow.run((r) => r.invites.accept(first.id, user, now))).toBe(false);
        expect((await uow.run((r) => r.invites.get(a.id, first.id)))?.status).toBe("accepted");
        expect(await uow.run((r) => r.invites.reissue(first.id, `h1c-${tag}`, fresh))).toBe(false);

        expect(await uow.run((r) => r.invites.revoke(second.id))).toBe(true);
        expect(await uow.run((r) => r.invites.revoke(second.id))).toBe(false);
        expect(await uow.run((r) => r.invites.accept(second.id, user, now))).toBe(false);
        expect(await uow.run((r) => r.invites.listPending(a.id))).toEqual([]);

        // The send log counts every send per account in a window, whatever happened to the invites since.
        const t0 = new Date(Date.UTC(2100, 0, 1));
        await uow.run(async (r) => {
          await r.invites.recordSend(a.id, first.id, t0);
          await r.invites.recordSend(a.id, first.id, new Date(t0.getTime() + 60_000));
          await r.invites.recordSend(b.id, second.id, new Date(t0.getTime() + 60_000));
        });
        expect(await uow.run((r) => r.invites.sendsSince(a.id, t0))).toBe(2);
        expect(await uow.run((r) => r.invites.sendsSince(a.id, new Date(t0.getTime() + 1)))).toBe(1);
        expect(await uow.run((r) => r.invites.sendsSince(b.id, t0))).toBe(1);
        expect(await uow.run((r) => r.invites.sendsSince("not-a-uuid", t0))).toBe(0);
      } finally {
        await cleanup();
      }
    });

    it("audit: filters by area, actor kind (act-as counts as staff) and result", async () => {
      const { uow, cleanup } = await factory();
      try {
        const scope = `account:${randomUUID()}` as const;
        const entry = (over: Partial<AuditEntryInput>): AuditEntryInput => ({ ...auditInput(scope), ...over });
        const staff = { type: "staff" as const, userId: "s", email: "s@anhourtec.test", role: null, accountId: null };
        const member = { type: "user" as const, userId: "u", email: "u@example.test", role: null, accountId: null };
        const system = { type: "system" as const, userId: null, email: "worker", role: null, accountId: null };
        await uow.run(async (r) => {
          await r.audit.append(entry({ action: "mailbox.created", actor: member }), new Date());
          await r.audit.append(entry({ action: "mailbox.suspended", actor: staff, result: "denied" }), new Date());
          await r.audit.append(
            entry({ action: "alias.created", actor: member, onBehalfOf: { userId: "s", email: "s@anhourtec.test" } }),
            new Date(),
          );
          await r.audit.append(
            entry({ action: "platform.mailbox_purged", actor: system, result: "failed" }),
            new Date(),
          );
        });
        const actions = async (q: Omit<AuditQuery, "scope" | "limit">) =>
          (await uow.run((r) => r.audit.list({ scope, limit: 10, ...q }))).map((e) => e.action);
        expect(await actions({ area: "mailbox" })).toEqual(["mailbox.suspended", "mailbox.created"]);
        expect(await actions({ area: "mail" })).toEqual([]);
        expect(await actions({ actorKind: "staff" })).toEqual(["alias.created", "mailbox.suspended"]);
        expect(await actions({ actorKind: "user" })).toEqual(["mailbox.created"]);
        expect(await actions({ actorKind: "system" })).toEqual(["platform.mailbox_purged"]);
        expect(await actions({ actorKind: "anonymous" })).toEqual([]);
        expect(await actions({ result: "denied" })).toEqual(["mailbox.suspended"]);
        expect(await actions({ actorUserId: "u", area: "alias" })).toEqual(["alias.created"]);
      } finally {
        await cleanup();
      }
    });

    it("platform accounts: search by name, id or member email, with counts, newest first and paged", async () => {
      const { uow, cleanup, createUser } = await factory();
      try {
        const tag = randomUUID().slice(0, 8);
        const older = await uow.run((r) => r.accounts.create({ name: `Platform ${tag} older_%`, plan: "plus" }));
        await new Promise((resolve) => setTimeout(resolve, 5));
        const newer = await uow.run((r) => r.accounts.create({ name: `Platform ${tag} newer`, plan: "free" }));
        const person = await createUser(`find-${tag}@example.com`);
        await uow.run((r) => r.accounts.addMember({ accountId: older.id, userId: person, role: "owner" }));

        const byName = await uow.run((r) =>
          r.platformAccounts.search({ query: `platform ${tag}`, limit: 10, offset: 0 }),
        );
        expect(byName.total).toBe(2);
        expect(byName.rows.map((x) => x.id)).toEqual([newer.id, older.id]);
        expect(byName.rows[1]).toMatchObject({
          name: `Platform ${tag} older_%`,
          plan: "plus",
          members: 1,
          mailboxes: 0,
          domains: 0,
        });
        const paged = await uow.run((r) =>
          r.platformAccounts.search({ query: `platform ${tag}`, limit: 1, offset: 1 }),
        );
        expect(paged).toMatchObject({ total: 2, rows: [{ id: older.id }] });
        // `%` and `_` are literal, not wildcards.
        expect(
          (await uow.run((r) => r.platformAccounts.search({ query: `${tag} older_%`, limit: 10, offset: 0 }))).total,
        ).toBe(1);
        expect(
          (await uow.run((r) => r.platformAccounts.search({ query: `${tag} o%`, limit: 10, offset: 0 }))).total,
        ).toBe(0);
        const byEmail = await uow.run((r) => r.platformAccounts.search({ query: `FIND-${tag}`, limit: 10, offset: 0 }));
        expect(byEmail.rows.map((x) => x.id)).toEqual([older.id]);
        const byId = await uow.run((r) => r.platformAccounts.search({ query: newer.id, limit: 10, offset: 0 }));
        expect(byId.rows.map((x) => x.id)).toEqual([newer.id]);
        const all = await uow.run((r) => r.platformAccounts.search({ query: null, limit: 1, offset: 0 }));
        expect(all.total).toBeGreaterThanOrEqual(2);
        expect(await uow.run((r) => r.platformAccounts.summary(older.id))).toMatchObject({ id: older.id, members: 1 });
        expect(await uow.run((r) => r.platformAccounts.summary(randomUUID()))).toBeNull();
        expect(await uow.run((r) => r.platformAccounts.summary("not-a-uuid"))).toBeNull();
      } finally {
        await cleanup();
      }
    });

    it("access: unknown users have no roles and are not suspended", async () => {
      const { uow, cleanup } = await factory();
      try {
        const id = `missing-${randomUUID()}`;
        expect(await uow.run((r) => r.access.platformRoles(id))).toEqual([]);
        expect(await uow.run((r) => r.access.memberships(id))).toEqual([]);
        expect(await uow.run((r) => r.access.isSuspended(id))).toBe(false);
        expect(await uow.run((r) => r.access.accountNames([randomUUID(), "not-a-uuid"]))).toEqual({});
      } finally {
        await cleanup();
      }
    });

    it("security: factors, sessions, passkeys and trusted devices stay scoped to their person", async () => {
      const { uow, cleanup, createUser, seedAuth } = await factory();
      try {
        const now = new Date();
        const at = (min: number) => new Date(now.getTime() + min * 60_000);
        const sam = await createUser(`sec-sam-${randomUUID()}@example.com`);
        const lee = await createUser(`sec-lee-${randomUUID()}@example.com`);
        const [s1, s2, s3, sl] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
        const [pk, pkl] = [randomUUID(), randomUUID()];
        await seedAuth(sam, {
          sessions: [
            { id: s1, expiresAt: at(600), updatedAt: at(-30), ip: "203.0.113.4", userAgent: "UA one" },
            { id: s2, expiresAt: at(600), updatedAt: at(-5) },
            { id: s3, expiresAt: at(-1), updatedAt: at(-90) },
          ],
          passkeys: [{ id: pk, name: "Laptop", createdAt: at(-10) }],
          recoveryCodes: 3,
          trustedDevices: 2,
        });
        await seedAuth(lee, {
          sessions: [{ id: sl, expiresAt: at(600), updatedAt: at(-1) }],
          passkeys: [{ id: pkl, name: "Key", createdAt: at(-10) }],
          trustedDevices: 1,
        });

        expect(await uow.run((r) => r.security.factors(sam))).toEqual({
          totp: true,
          passkeys: 1,
          recoveryCodesLeft: 3,
        });
        expect(await uow.run((r) => r.security.factors(lee))).toEqual({
          totp: false,
          passkeys: 1,
          recoveryCodesLeft: 0,
        });
        const live = await uow.run((r) => r.security.sessions(sam, now));
        expect(live.map((x) => x.id)).toEqual([s2, s1]);
        expect(live[1]).toMatchObject({ ip: "203.0.113.4", userAgent: "UA one" });
        expect(Object.keys(live[0] ?? {}).sort()).toEqual(
          ["createdAt", "expiresAt", "id", "ip", "lastActiveAt", "userAgent"].sort(),
        );

        // Another person's ids behave as unknown.
        expect(await uow.run((r) => r.security.revokeSession(sam, sl))).toBeNull();
        expect(await uow.run((r) => r.security.renamePasskey(sam, pkl, "Mine"))).toBeNull();
        expect(await uow.run((r) => r.security.removePasskey(sam, pkl))).toBeNull();
        expect((await uow.run((r) => r.security.passkeys(lee)))[0]?.name).toBe("Key");

        expect(await uow.run((r) => r.security.revokeSession(sam, s1))).toMatchObject({ id: s1 });
        expect(await uow.run((r) => r.security.revokeOtherSessions(sam, s2))).toBe(1);
        expect((await uow.run((r) => r.security.sessions(sam, now))).map((x) => x.id)).toEqual([s2]);
        expect((await uow.run((r) => r.security.sessions(lee, now))).map((x) => x.id)).toEqual([sl]);
        expect(await uow.run((r) => r.security.forgetTrustedDevices(sam))).toBe(2);
        expect(await uow.run((r) => r.security.forgetTrustedDevices(sam))).toBe(0);
        expect(await uow.run((r) => r.security.forgetTrustedDevices(lee))).toBe(1);

        expect(await uow.run((r) => r.security.renamePasskey(sam, pk, "Phone"))).toMatchObject({
          id: pk,
          name: "Phone",
        });
        const keys = await uow.run((r) => r.security.passkeys(sam));
        expect(keys).toHaveLength(1);
        expect(Object.keys(keys[0] ?? {}).sort()).toEqual(
          ["aaguid", "backedUp", "createdAt", "deviceType", "id", "name"].sort(),
        );
        expect(await uow.run((r) => r.security.removePasskey(sam, pk))).toMatchObject({ id: pk });
        expect(await uow.run((r) => r.security.factors(sam))).toMatchObject({ passkeys: 0 });
      } finally {
        await cleanup();
      }
    });

    it("security: account sign-in policies default to none and follow memberships", async () => {
      const { uow, cleanup, createUser } = await factory();
      try {
        const userId = await createUser(`sec-pol-${randomUUID()}@example.com`);
        const { id } = await uow.run((r) => r.accounts.create({ name: "Contract policy", plan: "plus" }));
        await uow.run((r) => r.accounts.addMember({ accountId: id, userId, role: "owner" }));
        expect(await uow.run((r) => r.security.accountPolicy(id))).toBe("none");
        expect(await uow.run((r) => r.security.policies(userId))).toEqual([{ accountId: id, policy: "none" }]);
        await uow.run((r) => r.security.setAccountPolicy(id, "passkey"));
        expect(await uow.run((r) => r.security.accountPolicy(id))).toBe("passkey");
        expect(await uow.run((r) => r.security.policies(userId))).toEqual([{ accountId: id, policy: "passkey" }]);
        expect(await uow.run((r) => r.security.accountPolicy(randomUUID()))).toBeNull();
        expect(await uow.run((r) => r.security.accountPolicy("not-a-uuid"))).toBeNull();
        expect(await uow.run((r) => r.security.policies(`missing-${randomUUID()}`))).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    it("webmail settings: preferences per mailbox, one forwarding target, token look-up", async () => {
      const { uow, cleanup, seedMail } = await factory();
      try {
        const tag = randomUUID().slice(0, 8);
        const domain = `wm-${tag}.test`;
        const address = `owner@${domain}`;
        const { mailboxId } = await seedMail({ domain, address, alias: `hi@${domain}`, quotaBytes: 1024 });
        const found = await uow.run((r) => r.webmailSettings.mailboxByAddress(address.toUpperCase()));
        expect(found).toMatchObject({ id: mailboxId, address });
        expect(await uow.run((r) => r.webmailSettings.mailboxByAddress(`nobody@${domain}`))).toBeNull();

        expect(await uow.run((r) => r.webmailSettings.preferences(mailboxId))).toBeNull();
        expect(await uow.run((r) => r.webmailSettings.preferences("not-a-uuid"))).toBeNull();
        await uow.run((r) => r.webmailSettings.savePreferences(mailboxId, { density: "compact" }, new Date()));
        await uow.run((r) =>
          r.webmailSettings.savePreferences(mailboxId, { density: "roomy", previewLines: 1 }, new Date()),
        );
        expect(await uow.run((r) => r.webmailSettings.preferences(mailboxId))).toEqual({
          density: "roomy",
          previewLines: 1,
        });

        const now = new Date();
        const target = {
          mailboxId,
          accountId: found?.accountId ?? "",
          address: `copy-${tag}@example.org`,
          status: "pending" as const,
          tokenHash: `hash-${tag}`,
          expiresAt: new Date(now.getTime() + 3_600_000),
          confirmedAt: null,
          requestedAt: now,
          sendsInWindow: 1,
          windowStartedAt: now,
        };
        expect(await uow.run((r) => r.webmailSettings.forwarding(mailboxId))).toBeNull();
        await uow.run((r) => r.webmailSettings.saveForwarding(target));
        expect(await uow.run((r) => r.webmailSettings.forwardingByToken(`hash-${tag}`))).toMatchObject({
          mailboxId,
          status: "pending",
          sendsInWindow: 1,
        });
        await uow.run((r) =>
          r.webmailSettings.saveForwarding({ ...target, status: "confirmed", tokenHash: null, confirmedAt: now }),
        );
        expect(await uow.run((r) => r.webmailSettings.forwardingByToken(`hash-${tag}`))).toBeNull();
        expect(await uow.run((r) => r.webmailSettings.forwarding(mailboxId))).toMatchObject({
          status: "confirmed",
          tokenHash: null,
          address: `copy-${tag}@example.org`,
        });
        await uow.run((r) => r.webmailSettings.clearForwarding(mailboxId));
        expect(await uow.run((r) => r.webmailSettings.forwarding(mailboxId))).toBeNull();

        // The counter lock: nothing to read on a first request, and a refused request leaves nothing behind.
        const accountId = found?.accountId ?? "";
        await expect(
          uow.run(async (r) => {
            expect(await r.webmailSettings.forwardingForUpdate(mailboxId, accountId)).toBeNull();
            throw new Error("refused");
          }),
        ).rejects.toThrow("refused");
        expect(await uow.run((r) => r.webmailSettings.forwarding(mailboxId))).toBeNull();
        // Even a placeholder that was committed never reads as a target.
        await uow.run((r) => r.webmailSettings.forwardingForUpdate(mailboxId, accountId));
        expect(await uow.run((r) => r.webmailSettings.forwarding(mailboxId))).toBeNull();
        await uow.run((r) => r.webmailSettings.saveForwarding(target));
        expect(await uow.run((r) => r.webmailSettings.forwardingForUpdate(mailboxId, accountId))).toMatchObject({
          address: target.address,
        });
      } finally {
        await cleanup();
      }
    });

    it("app passwords: metadata per mailbox, newest first, conditional revoke, rows go with their mailbox", async () => {
      const { uow, cleanup, seedMail } = await factory();
      try {
        const tag = randomUUID().slice(0, 8);
        const domain = `ap-${tag}.test`;
        const address = `owner@${domain}`;
        const { mailboxId } = await seedMail({ domain, address, alias: `hi@${domain}`, quotaBytes: 1024 });
        const other = await seedMail({
          domain: `ap2-${tag}.test`,
          address: `x@ap2-${tag}.test`,
          alias: `y@ap2-${tag}.test`,
          quotaBytes: 1,
        });
        const accountId = (await uow.run((r) => r.directory.getMailbox(mailboxId)))?.accountId ?? "";
        const row = (name: string, at: number) => ({
          id: randomUUID(),
          accountId,
          mailboxId,
          name,
          protocols: ["imap" as const, "smtp" as const],
          credentialId: `c-${name}`,
          credentialCreatedAt: new Date(Date.UTC(2026, 9, 22, 11, 40, 37)),
          createdAt: new Date(Date.UTC(2026, 9, 22, 12, at)),
          createdBy: null,
          status: "active" as const,
        });
        const phone = row("Phone", 1);
        const laptop = row("Laptop", 2);
        const printer = row("Printer", 3);
        await uow.run(async (r) => {
          for (const p of [phone, laptop, printer]) await r.appPasswords.insert(p);
        });
        const listed = await uow.run((r) => r.appPasswords.listByMailbox(mailboxId));
        expect(listed.map((p) => p.name)).toEqual(["Printer", "Laptop", "Phone"]);
        expect(listed[2]).toEqual(phone);
        expect(await uow.run((r) => r.appPasswords.listByMailbox(other.mailboxId))).toEqual([]);
        expect(await uow.run((r) => r.appPasswords.get(other.mailboxId, phone.id))).toBeNull();
        expect(await uow.run((r) => r.appPasswords.get(mailboxId, "not-a-uuid"))).toBeNull();
        expect(await uow.run((r) => r.appPasswords.listByMailbox("not-a-uuid"))).toEqual([]);

        // Revoke one: only active ones move, and only once.
        expect((await uow.run((r) => r.appPasswords.markRevoking(mailboxId, phone.id))).map((p) => p.id)).toEqual([
          phone.id,
        ]);
        expect(await uow.run((r) => r.appPasswords.markRevoking(mailboxId, phone.id))).toEqual([]);
        expect(await uow.run((r) => r.appPasswords.markRevoking(other.mailboxId, laptop.id))).toEqual([]);
        // Revoke all: the rest.
        const all = await uow.run((r) => r.appPasswords.markRevoking(mailboxId, null));
        expect(all.map((p) => p.name).sort()).toEqual(["Laptop", "Printer"]);
        expect((await uow.run((r) => r.appPasswords.revoking(mailboxId))).map((p) => p.name)).toEqual([
          "Phone",
          "Laptop",
          "Printer",
        ]);
        // The reconciler's views: mailboxes with pending revocations (and whether a job is open), mailboxes on the server.
        expect(
          (await uow.run((r) => r.appPasswords.mailboxesWithRevoking())).find((x) => x.mailboxId === mailboxId),
        ).toEqual({ mailboxId, jobOpen: false });
        await uow.run((r) =>
          r.provisioning.enqueue({ kind: "app_password.revoke", subjectId: mailboxId, runAfter: new Date() }),
        );
        expect(
          (await uow.run((r) => r.appPasswords.mailboxesWithRevoking())).find((x) => x.mailboxId === mailboxId),
        ).toEqual({ mailboxId, jobOpen: true });
        expect((await uow.run((r) => r.appPasswords.mailboxesOnServer())).map((x) => x.id)).not.toContain(mailboxId);
        await uow.run((r) =>
          r.directory.markMailbox(mailboxId, { status: "active", stalwartId: `s-${tag}`, lastError: null }),
        );
        expect((await uow.run((r) => r.appPasswords.mailboxesOnServer())).find((x) => x.id === mailboxId)).toEqual({
          id: mailboxId,
          accountId,
          address,
          stalwartId: `s-${tag}`,
          status: "active",
          passwordCredentialId: null,
          passwordPending: false,
        });
        await uow.run((r) => r.appPasswords.deleteRevoked(phone.id));
        expect((await uow.run((r) => r.appPasswords.listByMailbox(mailboxId))).map((p) => p.name)).toEqual([
          "Printer",
          "Laptop",
        ]);

        // An active row is never deleted as revoked; every row goes with its mailbox.
        const keep = row("Keep", 4);
        await uow.run((r) => r.appPasswords.insert(keep));
        await uow.run((r) => r.appPasswords.deleteRevoked(keep.id));
        expect(await uow.run((r) => r.appPasswords.get(mailboxId, keep.id))).toMatchObject({ status: "active" });
        const purgeAfter = new Date(Date.UTC(1990, 0, 1));
        await uow.run((r) => r.mailboxes.transition(mailboxId, ["active"], "deleting", purgeAfter));
        expect(await uow.run((r) => r.mailboxes.deleteIfDue(mailboxId, new Date()))).toBe(true);
        expect(await uow.run((r) => r.appPasswords.listByMailbox(mailboxId))).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    it("catch-all: per domain, cleared for a mailbox, applied only while its mailbox is active", async () => {
      const { uow, cleanup, seedMail } = await factory();
      try {
        const tag = randomUUID().slice(0, 8);
        const domain = `ca-${tag}.test`;
        const address = `owner@${domain}`;
        const { domainId, mailboxId } = await seedMail({ domain, address, alias: `hi@${domain}`, quotaBytes: 1 });
        const other = await seedMail({
          domain: `ca2-${tag}.test`,
          address: `x@ca2-${tag}.test`,
          alias: `y@ca2-${tag}.test`,
          quotaBytes: 1,
        });
        expect(await uow.run((r) => r.catchAll.get(domainId))).toBeNull();
        expect(await uow.run((r) => r.catchAll.targetAddress(domainId))).toBeNull();
        await uow.run((r) => r.catchAll.set(domainId, mailboxId));
        await uow.run((r) => r.catchAll.set(other.domainId, mailboxId));
        expect(await uow.run((r) => r.catchAll.get(domainId))).toBe(mailboxId);
        expect(await uow.run((r) => r.catchAll.targetAddress(domainId))).toBe(address);
        expect(await uow.run((r) => r.catchAll.get("not-a-uuid"))).toBeNull();
        // Another account's mailbox is never applied as a domain's catch-all, whatever the row says.
        expect(await uow.run((r) => r.catchAll.targetAddress(other.domainId))).toBeNull();

        // Not applied while the mailbox isn't active (the setting itself stays until cleared).
        await uow.run((r) => r.mailboxes.transition(mailboxId, ["active"], "suspended", null));
        expect(await uow.run((r) => r.catchAll.targetAddress(domainId))).toBeNull();
        await uow.run((r) => r.mailboxes.transition(mailboxId, ["suspended"], "active", null));

        const off = await uow.run((r) => r.catchAll.clearForMailbox(mailboxId));
        expect(off).toEqual([
          { id: domainId, name: domain },
          { id: other.domainId, name: `ca2-${tag}.test` },
        ]);
        expect(await uow.run((r) => r.catchAll.get(domainId))).toBeNull();
        expect(await uow.run((r) => r.catchAll.clearForMailbox(mailboxId))).toEqual([]);

        // Set, then the mailbox is purged: the catch-all is off (Postgres: ON DELETE SET NULL).
        await uow.run((r) => r.catchAll.set(other.domainId, mailboxId));
        await uow.run((r) => r.mailboxes.transition(mailboxId, ["active"], "deleting", new Date(Date.UTC(1990, 0, 1))));
        await uow.run((r) => r.mailboxes.deleteIfDue(mailboxId, new Date()));
        expect(await uow.run((r) => r.catchAll.get(other.domainId))).toBeNull();
      } finally {
        await cleanup();
      }
    });

    it("security: a step-up is fresh only for its own session and person, until it expires", async () => {
      const { uow, cleanup, createUser, seedAuth } = await factory();
      try {
        const now = new Date();
        const sam = await createUser(`stepup-sam-${randomUUID()}@example.com`);
        const lee = await createUser(`stepup-lee-${randomUUID()}@example.com`);
        const [s1, s2] = [randomUUID(), randomUUID()];
        await seedAuth(sam, {
          stepUps: [
            { sessionId: s1, expiresAt: new Date(now.getTime() + 60_000) },
            { sessionId: s2, expiresAt: new Date(now.getTime() - 1) },
          ],
        });
        expect(await uow.run((r) => r.security.stepUpFresh(sam, s1, now))).toBe(true);
        expect(await uow.run((r) => r.security.stepUpFresh(sam, s2, now))).toBe(false);
        expect(await uow.run((r) => r.security.stepUpFresh(lee, s1, now))).toBe(false);
        expect(await uow.run((r) => r.security.stepUpFresh(sam, randomUUID(), now))).toBe(false);
        expect(await uow.run((r) => r.security.stepUpFresh(sam, s1, new Date(now.getTime() + 61_000)))).toBe(false);
      } finally {
        await cleanup();
      }
    });

    it("staff: a password-less login, a platform role and a set-password token; duplicates refused", async () => {
      const { uow, cleanup } = await factory();
      try {
        const email = `bootstrap-${randomUUID()}@example.test`;
        const names = { name: "First Admin", firstName: "First", lastName: "Admin" };
        // Rolled back with the unit of work like every other write.
        await expect(
          uow.run(async (r) => {
            await r.staff.createLogin({ email, ...names });
            throw new Error("boom");
          }),
        ).rejects.toThrow("boom");
        expect(await uow.run((r) => r.people.userByEmail(email))).toBeNull();

        const id = await uow.run(async (r) => {
          await r.staff.lockBootstrap();
          const { id: created } = await r.staff.createLogin({ email, ...names });
          await r.staff.grantRole(created, "global_admin", "contract");
          await r.staff.grantRole(created, "global_admin", "contract"); // idempotent
          await r.staff.issuePasswordSetToken(created, `t-${randomUUID()}`, new Date(Date.now() + 60_000));
          return created;
        });
        expect(await uow.run((r) => r.people.userByEmail(email))).toEqual({ id, name: "First Admin" });
        expect(await uow.run((r) => r.access.platformRoles(id))).toEqual(["global_admin"]);
        expect(await uow.run((r) => r.staff.anyPlatformRole())).toBe(true);
        await expect(uow.run((r) => r.staff.createLogin({ email, ...names }))).rejects.toBeInstanceOf(ConflictError);
      } finally {
        await cleanup();
      }
    });
  });
}
