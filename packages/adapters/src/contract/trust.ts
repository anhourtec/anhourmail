// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Trust tier repository contract (ADR-0034 §1–§3, §6), part of the adapter contract: memory in `npm test`, Postgres in
 * `npm run test:int`. Includes the scoping rule: another account's mailbox reads as unknown and is never changed. The
 * Postgres database is shared with other suites, so list results are checked for this run's own rows only.
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { UnitOfWork } from "@anhourmail/core";
import type { AuditEntryInput } from "@anhourmail/core/audit";
import { defaultBilling } from "@anhourmail/core/billing";
import type { MailboxSendingRestriction, TrustTierChange } from "@anhourmail/core/trust";
import { SUSPENSION_REASONS, type SuspensionReason } from "@anhourmail/shared/platform";

import type { AdapterFactory } from ".";

const MINUTE = 60_000;
const T = new Date("2026-11-11T12:00:00.000Z");

const newAccount = (uow: UnitOfWork) =>
  uow.run(async (r) => (await r.accounts.create({ name: `Trust contract ${randomUUID()}`, plan: "free" })).id);

const change = (over: Partial<TrustTierChange> = {}): TrustTierChange => ({
  tier: "standard",
  since: T,
  source: "staff",
  reason: "spam",
  note: "internal note",
  setBy: "staff-1",
  ...over,
});

const restriction = (over: Partial<MailboxSendingRestriction> = {}): MailboxSendingRestriction => ({
  at: T,
  reason: "phishing",
  note: "looks compromised",
  byUserId: "staff-1",
  ...over,
});

const heldEntry = (accountId: string): AuditEntryInput => ({
  scope: `account:${accountId}`,
  action: "trust.send_held",
  actor: { type: "user", userId: null, email: null, role: null, accountId },
  onBehalfOf: null,
  target: { type: "mailbox", id: null, label: null },
  result: "denied",
  errorCode: "sending_held",
  requestId: "req-trust",
  ip: null,
  userAgent: null,
  meta: { externalRecipients: 1 },
});

export function describeTrustContract(name: string, factory: AdapterFactory): void {
  describe(`${name} trust repositories`, () => {
    it("a new account reads as new / default; unknown and malformed ids read as null", async () => {
      const { uow, cleanup } = await factory();
      try {
        const a = await newAccount(uow);
        const t = await uow.run((r) => r.trust.get(a));
        expect(t).toMatchObject({
          accountId: a,
          tier: "new",
          source: "default",
          reason: null,
          note: null,
          setBy: null,
          lastRestrictedAt: null,
        });
        expect(t?.since).toBeInstanceOf(Date);
        expect(await uow.run((r) => r.trust.get(randomUUID()))).toBeNull();
        expect(await uow.run((r) => r.trust.get("not-an-id"))).toBeNull();
      } finally {
        await cleanup();
      }
    });

    it("setTier writes one account only; markRestricted only moves forward", async () => {
      const { uow, cleanup } = await factory();
      try {
        const a = await newAccount(uow);
        const b = await newAccount(uow);
        expect(await uow.run((r) => r.trust.setTier(a, change()))).toBe(true);
        expect(await uow.run((r) => r.trust.get(a))).toEqual({ accountId: a, ...change(), lastRestrictedAt: null });
        expect(await uow.run((r) => r.trust.get(b))).toMatchObject({ tier: "new", source: "default", note: null });
        // Back to automatic, without reason or note.
        const auto = change({ tier: "new", source: "automatic", reason: null, note: null, setBy: null });
        await uow.run((r) => r.trust.setTier(a, auto));
        expect(await uow.run((r) => r.trust.get(a))).toMatchObject(auto);
        expect(await uow.run((r) => r.trust.setTier(randomUUID(), change()))).toBe(false);
        expect(await uow.run((r) => r.trust.setTier("not-an-id", change()))).toBe(false);

        const later = new Date(T.getTime() + 10 * MINUTE);
        await uow.run((r) => r.trust.markRestricted(a, later));
        await uow.run((r) => r.trust.markRestricted(a, T)); // earlier: ignored
        expect((await uow.run((r) => r.trust.get(a)))?.lastRestrictedAt).toEqual(later);
        expect((await uow.run((r) => r.trust.get(b)))?.lastRestrictedAt).toBeNull();
        // A tier change keeps the restriction mark.
        await uow.run((r) => r.trust.setTier(a, change()));
        expect((await uow.run((r) => r.trust.get(a)))?.lastRestrictedAt).toEqual(later);
        await uow.run((r) => r.trust.markRestricted(randomUUID(), T)); // unknown: nothing happens
      } finally {
        await cleanup();
      }
    });

    it("promotion candidates: only established new accounts in good standing, oldest first", async () => {
      const { uow, cleanup, createUser } = await factory();
      try {
        const tag = randomUUID();
        /** An account with one owner (email confirmed unless said otherwise). */
        const account = async (opts: { verified?: boolean; owner?: boolean } = {}) => {
          const id = await newAccount(uow);
          const userId = await createUser(`owner-${randomUUID()}@trust-${tag}.test`, {
            emailVerified: opts.verified ?? true,
          });
          await uow.run((r) =>
            r.accounts.addMember({ accountId: id, userId, role: opts.owner === false ? "member" : "owner" }),
          );
          return { id, userId };
        };
        const eligible = await account();
        const automatic = await account();
        await uow.run((r) => r.trust.setTier(automatic.id, change({ tier: "new", source: "automatic" })));
        const pastDue = await account();
        await uow.run((r) =>
          r.billing.save({ ...defaultBilling(pastDue.id, "free", T), state: "past_due", updatedAt: T }),
        );
        const heldOnce = await account();
        await uow.run((r) => r.audit.append(heldEntry(heldOnce.id), new Date()));
        const heldEarlier = await account(); // entries before the window don't count
        for (let i = 0; i < 3; i++) {
          await uow.run((r) => r.audit.append(heldEntry(heldEarlier.id), new Date(Date.now() - 120 * MINUTE)));
        }

        const frozen = await account();
        await uow.run((r) => r.trust.setTier(frozen.id, change({ tier: "new", source: "staff" })));
        const standard = await account();
        await uow.run((r) => r.trust.setTier(standard.id, change({ source: "billing" })));
        const restrictedBefore = await account();
        await uow.run((r) => r.trust.markRestricted(restrictedBefore.id, T));
        const unpaid = await account();
        await uow.run((r) =>
          r.billing.save({ ...defaultBilling(unpaid.id, "free", T), state: "restricted", updatedAt: T }),
        );
        const lapsed = await account();
        await uow.run((r) =>
          r.billing.save({ ...defaultBilling(lapsed.id, "free", T), state: "lapsed", updatedAt: T }),
        );
        const suspended = await account();
        const record = { reason: "spam" as const, note: null, at: T, byUserId: null };
        await uow.run((r) => r.suspensions.setAccount(suspended.id, record));
        const personSuspended = await account();
        const member = await createUser(`member-${randomUUID()}@trust-${tag}.test`);
        await uow.run((r) => r.accounts.addMember({ accountId: personSuspended.id, userId: member, role: "member" }));
        await uow.run((r) => r.suspensions.setPerson(member, record));
        const unverified = await account({ verified: false });
        const ownerless = await account({ owner: false });
        const heldTwice = await account();
        for (let i = 0; i < 2; i++) await uow.run((r) => r.audit.append(heldEntry(heldTwice.id), new Date()));

        const ours = new Set(
          [
            eligible,
            automatic,
            pastDue,
            heldOnce,
            heldEarlier,
            frozen,
            standard,
            restrictedBefore,
            unpaid,
            lapsed,
            suspended,
            personSuspended,
            unverified,
            ownerless,
            heldTwice,
          ].map((x) => x.id),
        );
        const candidates = (createdBefore: Date, limit = 100_000) =>
          uow.run((r) =>
            r.trust.promotionCandidates({
              createdBefore,
              heldSince: new Date(Date.now() - 60 * MINUTE),
              maxHeld: 2,
              limit,
            }),
          );
        const found = (await candidates(new Date(Date.now() + MINUTE))).filter((c) => ours.has(c.accountId));
        expect(found.map((c) => c.accountId).sort()).toEqual(
          [eligible, automatic, pastDue, heldOnce, heldEarlier].map((x) => x.id).sort(),
        );
        for (const c of found) expect(c.createdAt).toBeInstanceOf(Date);
        for (let i = 1; i < found.length; i++) {
          expect(found[i]?.createdAt.getTime()).toBeGreaterThanOrEqual(found[i - 1]?.createdAt.getTime() ?? 0);
        }
        // Too young: none of this run's accounts were created a day ago.
        const old = await candidates(new Date(Date.now() - 24 * 60 * MINUTE));
        expect(old.filter((c) => ours.has(c.accountId))).toEqual([]);
        expect(await candidates(new Date(Date.now() + MINUTE), 0)).toEqual([]);
        expect((await candidates(new Date(Date.now() + MINUTE), 1)).length).toBeLessThanOrEqual(1);
      } finally {
        await cleanup();
      }
    });

    it("mailbox restrictions: set, read and clear within the account; another account's mailbox is unknown", async () => {
      const { uow, cleanup, seedMail } = await factory();
      try {
        const tag = randomUUID().slice(0, 8);
        const one = await seedMail({
          domain: `trust-a-${tag}.test`,
          address: `a@trust-a-${tag}.test`,
          alias: `a-alias@trust-a-${tag}.test`,
          quotaBytes: 1024,
        });
        const two = await seedMail({
          domain: `trust-b-${tag}.test`,
          address: `b@trust-b-${tag}.test`,
          alias: `b-alias@trust-b-${tag}.test`,
          quotaBytes: 1024,
        });
        const accountOf = async (mailboxId: string) =>
          (await uow.run((r) => r.directory.getMailbox(mailboxId)))?.accountId ?? "";
        const a = await accountOf(one.mailboxId);
        const b = await accountOf(two.mailboxId);
        expect(a).not.toBe(b);

        expect(await uow.run((r) => r.trust.mailbox(a, one.mailboxId))).toEqual({
          mailboxId: one.mailboxId,
          accountId: a,
          address: `a@trust-a-${tag}.test`,
          restriction: null,
        });
        expect(await uow.run((r) => r.trust.setMailboxRestriction(a, one.mailboxId, restriction()))).toBe(true);
        expect((await uow.run((r) => r.trust.mailbox(a, one.mailboxId)))?.restriction).toEqual(restriction());
        expect(await uow.run((r) => r.trust.mailboxes(a))).toEqual([
          { mailboxId: one.mailboxId, accountId: a, address: `a@trust-a-${tag}.test`, restriction: restriction() },
        ]);

        // Cross-account: reads as unknown, writes change nothing.
        expect(await uow.run((r) => r.trust.mailbox(b, one.mailboxId))).toBeNull();
        expect(await uow.run((r) => r.trust.setMailboxRestriction(b, one.mailboxId, null))).toBe(false);
        expect((await uow.run((r) => r.trust.mailbox(a, one.mailboxId)))?.restriction).toEqual(restriction());
        expect(await uow.run((r) => r.trust.setMailboxRestriction(a, two.mailboxId, restriction()))).toBe(false);
        expect((await uow.run((r) => r.trust.mailbox(b, two.mailboxId)))?.restriction).toBeNull();
        expect(await uow.run((r) => r.trust.mailboxes(b))).toEqual([
          { mailboxId: two.mailboxId, accountId: b, address: `b@trust-b-${tag}.test`, restriction: null },
        ]);
        expect(await uow.run((r) => r.trust.mailbox(a, randomUUID()))).toBeNull();
        expect(await uow.run((r) => r.trust.mailbox(a, "not-an-id"))).toBeNull();
        expect(await uow.run((r) => r.trust.mailboxes(randomUUID()))).toEqual([]);

        // A restriction without a note; then lifted.
        const noNote = restriction({ note: null, byUserId: null, reason: "abuse" });
        await uow.run((r) => r.trust.setMailboxRestriction(a, one.mailboxId, noNote));
        expect((await uow.run((r) => r.trust.mailbox(a, one.mailboxId)))?.restriction).toEqual(noNote);
        expect(await uow.run((r) => r.trust.setMailboxRestriction(a, one.mailboxId, null))).toBe(true);
        expect((await uow.run((r) => r.trust.mailbox(a, one.mailboxId)))?.restriction).toBeNull();
      } finally {
        await cleanup();
      }
    });

    it("a mailbox restriction reads as restricted in every reader, for every reason", async () => {
      const { uow, cleanup, seedMail } = await factory();
      try {
        const tag = randomUUID().slice(0, 8);
        const address = `r@trust-r-${tag}.test`;
        const { mailboxId } = await seedMail({
          domain: `trust-r-${tag}.test`,
          address,
          alias: `r-alias@trust-r-${tag}.test`,
          quotaBytes: 1024,
        });
        const accountId = (await uow.run((r) => r.directory.getMailbox(mailboxId)))?.accountId ?? "";
        for (const reason of Object.keys(SUSPENSION_REASONS) as SuspensionReason[]) {
          const set = restriction({ reason, note: null, byUserId: null });
          await uow.run((r) => r.trust.setMailboxRestriction(accountId, mailboxId, set));
          expect((await uow.run((r) => r.trust.mailbox(accountId, mailboxId)))?.restriction).toEqual(set);
          expect((await uow.run((r) => r.trust.mailboxes(accountId)))[0]?.restriction).toEqual(set);
          expect((await uow.run((r) => r.trust.standingByAddress(address)))?.mailboxRestricted).toBe(true);
        }
        await uow.run((r) => r.trust.setMailboxRestriction(accountId, mailboxId, null));
        expect((await uow.run((r) => r.trust.mailbox(accountId, mailboxId)))?.restriction).toBeNull();
        expect((await uow.run((r) => r.trust.standingByAddress(address)))?.mailboxRestricted).toBe(false);
      } finally {
        await cleanup();
      }
    });

    it("standing by address: the account's tier and the mailbox restriction; any case; unknown is null", async () => {
      const { uow, cleanup, seedMail } = await factory();
      try {
        const tag = randomUUID().slice(0, 8);
        const address = `s@trust-s-${tag}.test`;
        const { mailboxId } = await seedMail({
          domain: `trust-s-${tag}.test`,
          address,
          alias: `s-alias@trust-s-${tag}.test`,
          quotaBytes: 1024,
        });
        const accountId = (await uow.run((r) => r.directory.getMailbox(mailboxId)))?.accountId ?? "";
        expect(await uow.run((r) => r.trust.standingByAddress(address))).toEqual({
          accountId,
          mailboxId,
          accountTier: "new",
          mailboxRestricted: false,
        });
        await uow.run((r) => r.trust.setTier(accountId, change({ source: "billing", reason: null, note: null })));
        await uow.run((r) => r.trust.setMailboxRestriction(accountId, mailboxId, restriction()));
        expect(await uow.run((r) => r.trust.standingByAddress(address.toUpperCase()))).toEqual({
          accountId,
          mailboxId,
          accountTier: "standard",
          mailboxRestricted: true,
        });
        expect(await uow.run((r) => r.trust.standingByAddress(`nobody-${tag}@trust-s-${tag}.test`))).toBeNull();
        // An alias is not a mailbox: its sends are the mailbox's (the webmail sends from the mailbox address).
        expect(await uow.run((r) => r.trust.standingByAddress(`s-alias@trust-s-${tag}.test`))).toBeNull();
      } finally {
        await cleanup();
      }
    });

    it("hosted domains: verified customer domains only, any case, de-duplicated", async () => {
      const { uow, cleanup, seedMail } = await factory();
      try {
        const tag = randomUUID().slice(0, 8);
        const active = `trust-h-${tag}.test`;
        const { mailboxId } = await seedMail({
          domain: active,
          address: `h@${active}`,
          alias: `h-alias@${active}`,
          quotaBytes: 1024,
        });
        const accountId = (await uow.run((r) => r.directory.getMailbox(mailboxId)))?.accountId ?? "";
        const pending = `trust-p-${tag}.test`;
        await uow.run((r) =>
          r.domains.insert({
            id: randomUUID(),
            accountId,
            name: pending,
            status: "pending_dns",
            verifyToken: "t",
            stalwartId: "on-the-mail-server",
            lastError: null,
            createdAt: T,
          }),
        );
        const hosted = await uow.run((r) =>
          r.directory.hostedDomains([active.toUpperCase(), active, pending, `elsewhere-${tag}.test`]),
        );
        expect(hosted).toEqual([active]);
        expect(await uow.run((r) => r.directory.hostedDomains([]))).toEqual([]);
      } finally {
        await cleanup();
      }
    });
  });
}
