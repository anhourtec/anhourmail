// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared contract every adapter must pass (ADR-0008). Swapping the database = a new adapter that passes these,
 * with no service or UI changes. Run by memory.test.ts (unit) and postgres.int.test.ts (integration).
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { UnitOfWork } from "@anhourmail/core";
import { type AuditEntryInput, verifyChain } from "@anhourmail/core/audit";
import { hashEmail, type WaitlistEntry } from "@anhourmail/core/waitlist";

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
}>;

const entry = (email: string, createdAt = new Date()): WaitlistEntry => ({
  id: randomUUID(),
  email,
  emailHash: hashEmail(email),
  community: "reddit",
  ref: null,
  utm: { source: "test" },
  status: "pending",
  createdAt,
  confirmSentAt: null,
  confirmedAt: null,
});

const auditInput = (
  scope: AuditEntryInput["scope"],
  action: AuditEntryInput["action"] = "waitlist.joined",
): AuditEntryInput => ({
  scope,
  action,
  actor: { type: "anonymous", userId: null, email: null, role: null, accountId: null },
  onBehalfOf: null,
  target: { type: "waitlist_entry", id: null, label: null },
  result: "success",
  errorCode: null,
  requestId: "req-1",
  ip: null,
  userAgent: null,
  meta: { n: 1 },
});

export function describeAdapterContract(name: string, factory: AdapterFactory): void {
  describe(`${name} adapter contract`, () => {
    it("waitlist: insert, find by hash, count, list newest first", async () => {
      const { uow, cleanup } = await factory();
      try {
        const tag = randomUUID().slice(0, 8);
        // Far-future, per-run timestamps: these rows are the newest even in a shared, long-lived test database.
        const base = Date.UTC(2200, 0, 1) + Date.now(); // later than every earlier run
        const a = entry(`a-${tag}@example.com`, new Date(base));
        const b = entry(`b-${tag}@example.com`, new Date(base + 1));
        await uow.run(async (r) => {
          await r.waitlist.insert(a);
          await r.waitlist.insert(b);
        });
        const found = await uow.run((r) => r.waitlist.findByEmailHash(a.emailHash));
        expect(found?.email).toBe(a.email);
        expect(found?.utm).toEqual({ source: "test" });
        expect(await uow.run((r) => r.waitlist.findByEmailHash("nope"))).toBeNull();
        const list = await uow.run((r) => r.waitlist.list({ limit: 2 }));
        expect(list.map((e) => e.id)).toEqual([b.id, a.id]);
        const older = await uow.run((r) => r.waitlist.list({ limit: 10, before: b.createdAt }));
        expect(older.map((e) => e.id)).toContain(a.id);
        expect(older.map((e) => e.id)).not.toContain(b.id);
        expect(await uow.run((r) => r.waitlist.count())).toBeGreaterThanOrEqual(2);
      } finally {
        await cleanup();
      }
    });

    it("waitlist: duplicate email hash is rejected", async () => {
      const { uow, cleanup } = await factory();
      try {
        const e = entry(`dup-${randomUUID()}@example.com`);
        await uow.run((r) => r.waitlist.insert(e));
        // Duplicate email hash: refused without throwing (a concurrent join must not surface as a 500).
        expect(await uow.run((r) => r.waitlist.insert({ ...e, id: randomUUID() }))).toBe(false);
      } finally {
        await cleanup();
      }
    });

    it("waitlist: double opt-in token lifecycle and invited state", async () => {
      const { uow, cleanup } = await factory();
      try {
        const e = entry(`optin-${randomUUID()}@example.com`);
        const hash = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
        const now = new Date();
        await uow.run(async (r) => {
          await r.waitlist.insert(e);
          await r.waitlist.setConfirmation(e.id, {
            tokenHash: hash,
            expiresAt: new Date(now.getTime() + 60_000),
            sentAt: now,
          });
        });
        expect((await uow.run((r) => r.waitlist.findByConfirmToken(hash, now)))?.id).toBe(e.id);
        expect(await uow.run((r) => r.waitlist.findByConfirmToken(hash, new Date(now.getTime() + 120_000)))).toBeNull();
        expect((await uow.run((r) => r.waitlist.get(e.id)))?.confirmSentAt?.getTime()).toBe(now.getTime());
        expect(await uow.run((r) => r.waitlist.markConfirmed(e.id, now))).toBe(true);
        expect(await uow.run((r) => r.waitlist.markConfirmed(e.id, now))).toBe(false);
        expect(await uow.run((r) => r.waitlist.findByConfirmToken(hash, now))).toBeNull();
        expect(await uow.run((r) => r.waitlist.get(e.id))).toMatchObject({ status: "confirmed" });
        expect(await uow.run((r) => r.waitlist.markInvited(e.id))).toBe(true);
        expect((await uow.run((r) => r.waitlist.get(e.id)))?.status).toBe("invited");
        // Only a confirmed entry can be claimed: a second (concurrent) invite loses.
        expect(await uow.run((r) => r.waitlist.markInvited(e.id))).toBe(false);
        expect(await uow.run((r) => r.waitlist.get(randomUUID()))).toBeNull();
      } finally {
        await cleanup();
      }
    });

    it("invites: create, find valid, expiry, single use", async () => {
      const { uow, cleanup, createUser } = await factory();
      try {
        const hash = `inv-${randomUUID()}`;
        const now = new Date();
        const email = `invited-${randomUUID()}@example.com`;
        const { id } = await uow.run((r) =>
          r.invites.create({
            email,
            tokenHash: hash,
            expiresAt: new Date(now.getTime() + 60_000),
            source: "waitlist",
            createdBy: null,
            waitlistEntryId: null,
            accountId: null,
            role: null,
          }),
        );
        expect(await uow.run((r) => r.invites.findValid(hash, now))).toMatchObject({ id, email, source: "waitlist" });
        expect(await uow.run((r) => r.invites.findValid(hash, new Date(now.getTime() + 120_000)))).toBeNull();
        const userId = await createUser(`acc-${randomUUID()}@example.com`);
        await uow.run((r) => r.invites.markAccepted(id, userId, now));
        expect(await uow.run((r) => r.invites.findValid(hash, now))).toBeNull();
      } finally {
        await cleanup();
      }
    });

    it("unit of work is atomic: a throw rolls back every write, audit included", async () => {
      const { uow, cleanup } = await factory();
      try {
        const scope = `account:${randomUUID()}` as const;
        const e = entry(`rollback-${randomUUID()}@example.com`);
        await expect(
          uow.run(async (r) => {
            await r.waitlist.insert(e);
            await r.audit.append(auditInput(scope), new Date());
            throw new Error("boom");
          }),
        ).rejects.toThrow("boom");
        expect(await uow.run((r) => r.waitlist.findByEmailHash(e.emailHash))).toBeNull();
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
        expect(desired.mailboxes).toContainEqual({ address: `owner@${domain}`, quotaBytes: 1024 });
        expect(await uow.run((r) => r.directory.getMailbox("not-a-uuid"))).toBeNull();
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
  });
}
