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
        await expect(uow.run((r) => r.waitlist.insert({ ...e, id: randomUUID() }))).rejects.toThrow();
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
