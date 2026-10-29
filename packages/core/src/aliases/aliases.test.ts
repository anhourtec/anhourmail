// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ACCOUNT_A, ACCOUNT_B, anonymous, deps as makeDeps, fixedClock, req, user } from "../__tests__/helpers";
import {
  AliasAdminLockedError,
  AliasDailyLimitError,
  AliasMailboxLimitError,
  AliasYearlyLimitError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PlanLimitError,
  UnauthenticatedError,
  ValidationError,
} from "../errors";
import { maskedLocalPart, normaliseDescription } from "./entity";
import { createAlias, deleteAlias, listAliases, setAliasEnabled, yearlyUse } from "./service";
import { ALIAS_CREATIONS_PER_YEAR, ALIASES_PER_MAILBOX, PLANS } from "@anhourmail/shared/plans";

const owner = user({ id: "owner", account: [[ACCOUNT_A, "owner"]] });
const userAdmin = user({ id: "uadmin", account: [[ACCOUNT_A, "user_admin"]] });
const member = user({ id: "member", account: [[ACCOUNT_A, "member"]] });
const auditor = user({ id: "auditor", account: [[ACCOUNT_A, "auditor"]] });
const ownerB = user({ id: "owner-b", account: [[ACCOUNT_B, "owner"]] });

const DOMAIN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PENDING_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DOMAIN_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MBX_OWNER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const MBX_MEMBER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const MBX_B = "ffffffff-ffff-4fff-8fff-ffffffffffff";

function setup(plan: "free" | "plus" = "plus") {
  const d = makeDeps(fixedClock("2026-10-22T12:00:00Z"));
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "A", plan }, { id: ACCOUNT_B, name: "B", plan: "plus" });
  const domain = (id: string, accountId: string, name: string, status: "active" | "pending_dns") => ({
    id,
    accountId,
    name,
    status,
    verifyToken: "t",
    stalwartId: null,
    lastError: null,
    createdAt: new Date(0),
  });
  s.domains.push(
    domain(DOMAIN_A, ACCOUNT_A, "family.ca", "active"),
    domain(PENDING_A, ACCOUNT_A, "later.ca", "pending_dns"),
    domain(DOMAIN_B, ACCOUNT_B, "other.ca", "active"),
  );
  const mailbox = (id: string, accountId: string, address: string, userId: string | null) => ({
    id,
    accountId,
    userId,
    address,
    status: "active" as const,
    quotaBytes: 1,
    stalwartId: "s",
    lastError: null,
    purgeAfter: null,
    createdAt: new Date(0),
  });
  s.mailboxes.push(
    mailbox(MBX_OWNER, ACCOUNT_A, "owner@family.ca", "owner"),
    mailbox(MBX_MEMBER, ACCOUNT_A, "kid@family.ca", "member"),
    mailbox(MBX_B, ACCOUNT_B, "b@other.ca", "owner-b"),
  );
  return d;
}

const chosen = (localPart: string, mailboxId = MBX_OWNER) => ({ localPart, domainId: DOMAIN_A, mailboxId });

describe("alias entity", () => {
  it("masked local parts are 12 unambiguous characters and start with a letter", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const v = maskedLocalPart();
      expect(v).toMatch(/^[a-hjkmnp-z][a-hjkmnp-z2-9]{11}$/);
      seen.add(v);
    }
    expect(seen.size).toBe(200);
  });

  it("notes are trimmed, optional, one line and short", () => {
    expect(normaliseDescription("  shop.example ")).toBe("shop.example");
    expect(normaliseDescription(undefined)).toBeNull();
    expect(normaliseDescription("   ")).toBeNull();
    for (const bad of [42, "a\nb", "x".repeat(101)]) expect(() => normaliseDescription(bad)).toThrow(ValidationError);
  });
});

describe("aliases service", () => {
  it("creates a chosen alias, queues the mailbox sync and audits it", async () => {
    const d = setup();
    const a = await createAlias(d, owner, ACCOUNT_A, { ...chosen(" Hello "), description: "public" }, req);
    expect(a).toMatchObject({
      address: "hello@family.ca",
      kind: "alias",
      enabled: true,
      description: "public",
      mailbox: { id: MBX_OWNER, address: "owner@family.ca" },
    });
    expect(d.uow.state.jobs.at(-1)).toMatchObject({ kind: "mailbox.ensure", subjectId: MBX_OWNER });
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "alias.created",
      result: "success",
      target: { type: "alias", id: a.id, label: "hello@family.ca" },
    });
    expect(JSON.stringify(d.uow.state.audit.at(-1)?.meta)).not.toContain("public");
  });

  it("creates a masked alias on the mailbox's own domain", async () => {
    const d = setup();
    const a = await createAlias(d, member, ACCOUNT_A, { kind: "masked", mailboxId: MBX_MEMBER }, req);
    expect(a.address).toMatch(/^[a-z2-9]{12}@family\.ca$/);
    expect(a.kind).toBe("masked");
    expect(d.uow.state.audit.at(-1)?.action).toBe("masked_alias.created");
  });

  it("refuses bad input: kind, mailbox, domain, local part, note", async () => {
    const d = setup();
    const bad = [
      { kind: "other", ...chosen("x") },
      { localPart: "x", domainId: DOMAIN_A, mailboxId: "nope" },
      { localPart: "x", domainId: PENDING_A, mailboxId: MBX_OWNER },
      { localPart: "x", domainId: DOMAIN_B, mailboxId: MBX_OWNER },
      chosen("a+b"),
      { ...chosen("x"), description: "a\u0007b" },
      { localPart: "x", domainId: DOMAIN_A, mailboxId: MBX_B },
    ];
    for (const input of bad) {
      await expect(createAlias(d, owner, ACCOUNT_A, input, req)).rejects.toThrow(ValidationError);
    }
    expect(d.uow.state.aliases).toEqual([]);
  });

  it("an address is used once, across mailboxes and aliases", async () => {
    const d = setup();
    await expect(createAlias(d, owner, ACCOUNT_A, chosen("kid"), req)).rejects.toThrow(ConflictError);
    await createAlias(d, owner, ACCOUNT_A, chosen("hi"), req);
    await expect(createAlias(d, owner, ACCOUNT_A, chosen("hi", MBX_MEMBER), req)).rejects.toThrow(ConflictError);
  });

  it("enforces the plan's limits per account and kind", async () => {
    const d = setup("free");
    for (let i = 0; i < 10; i++) await createAlias(d, owner, ACCOUNT_A, chosen(`a${String(i)}`), req);
    const err = await createAlias(d, owner, ACCOUNT_A, chosen("a10"), req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanLimitError);
    expect(err).toMatchObject({ message: "This account can have up to 10 aliases at a time." });
    await createAlias(d, owner, ACCOUNT_A, { kind: "masked", mailboxId: MBX_OWNER }, req);
    const o = await listAliases(d, owner, ACCOUNT_A);
    expect(o.limits).toEqual({
      alias: {
        used: 10,
        max: 10,
        createdToday: 10,
        perDay: PLANS.free.aliasCreationsPerDay.alias,
        createdThisYear: 10,
        perYear: 10,
        nextSlot: "2027-10-22",
      },
      masked: {
        used: 1,
        max: 10,
        createdToday: 1,
        perDay: PLANS.free.aliasCreationsPerDay.masked,
        createdThisYear: 1,
        perYear: ALIAS_CREATIONS_PER_YEAR.free.masked,
        nextSlot: null,
      },
    });
    expect(o.perMailbox).toBe(ALIASES_PER_MAILBOX);
    expect(o.mailboxes.find((m) => m.id === MBX_OWNER)).toMatchObject({ addresses: 11 });
  });

  it("masked aliases need the mailbox's domain to still be the account's", async () => {
    const d = setup();
    d.uow.state.domains[0]!.status = "pending_dns";
    await expect(createAlias(d, owner, ACCOUNT_A, { kind: "masked", mailboxId: MBX_OWNER }, req)).rejects.toThrow(
      ConflictError,
    );
  });

  it("with own-only rights, a person sees and manages only their mailboxes' aliases", async () => {
    const d = setup();
    const ownerAlias = await createAlias(d, owner, ACCOUNT_A, chosen("boss"), req);
    const kidAlias = await createAlias(d, owner, ACCOUNT_A, chosen("kiddo", MBX_MEMBER), req);

    const seen = await listAliases(d, member, ACCOUNT_A);
    expect(seen.mailboxes.map((m) => m.id)).toEqual([MBX_MEMBER]);
    expect(seen.aliases.map((a) => a.id)).toEqual([kidAlias.id]);
    expect(seen.domains).toEqual([{ id: DOMAIN_A, name: "family.ca" }]);

    await expect(createAlias(d, member, ACCOUNT_A, chosen("sneaky", MBX_OWNER), req)).rejects.toThrow(ValidationError);
    await expect(setAliasEnabled(d, member, ACCOUNT_A, ownerAlias.id, { enabled: false }, req)).rejects.toThrow(
      NotFoundError,
    );
    await expect(deleteAlias(d, member, ACCOUNT_A, ownerAlias.id, req)).rejects.toThrow(NotFoundError);
    expect((await setAliasEnabled(d, member, ACCOUNT_A, kidAlias.id, { enabled: false }, req)).enabled).toBe(false);

    // Admins with alias.manage.any reach every mailbox.
    const all = await listAliases(d, userAdmin, ACCOUNT_A);
    expect(all.aliases).toHaveLength(2);
    expect(all.limits.alias).toMatchObject({ used: 2, max: null }); // Plus: unlimited
  });

  it("role addresses (postmaster@, admin@, …) are for account admins only", async () => {
    const d = setup();
    for (const local of ["postmaster", "admin", "Webmaster", "abuse"]) {
      await expect(createAlias(d, member, ACCOUNT_A, chosen(local, MBX_MEMBER), req)).rejects.toThrow(
        /Only an account admin/,
      );
    }
    expect(d.uow.state.aliases).toHaveLength(0);
    expect((await createAlias(d, userAdmin, ACCOUNT_A, chosen("postmaster", MBX_MEMBER), req)).address).toBe(
      "postmaster@family.ca",
    );
    // Masked aliases stay open to everyone: their local part is random.
    expect((await createAlias(d, member, ACCOUNT_A, { kind: "masked", mailboxId: MBX_MEMBER }, req)).kind).toBe(
      "masked",
    );
  });

  it("turns aliases off and on, and deletes them, syncing the mailbox each time", async () => {
    const d = setup();
    const m = await createAlias(d, owner, ACCOUNT_A, { kind: "masked", mailboxId: MBX_OWNER }, req);
    const off = await setAliasEnabled(d, owner, ACCOUNT_A, m.id, { enabled: false }, req);
    expect(off.enabled).toBe(false);
    expect(d.uow.state.aliases[0]?.enabled).toBe(false);
    expect(d.uow.state.audit.at(-1)).toMatchObject({ action: "masked_alias.toggled", meta: { enabled: false } });
    await expect(setAliasEnabled(d, owner, ACCOUNT_A, m.id, { enabled: "no" }, req)).rejects.toThrow(ValidationError);

    expect(await deleteAlias(d, owner, ACCOUNT_A, m.id, req)).toEqual({ id: m.id });
    expect(d.uow.state.aliases).toEqual([]);
    expect(d.uow.state.audit.at(-1)).toMatchObject({ action: "masked_alias.deleted", result: "success" });
    expect(d.uow.state.jobs.filter((j) => j.subjectId === MBX_OWNER)).not.toHaveLength(0);
    await expect(deleteAlias(d, owner, ACCOUNT_A, m.id, req)).rejects.toThrow(NotFoundError);
  });

  it("other accounts, roles without alias rights and signed-out callers are refused", async () => {
    const d = setup();
    const a = await createAlias(d, owner, ACCOUNT_A, chosen("hi"), req);
    await expect(listAliases(d, ownerB, ACCOUNT_A)).rejects.toThrow(NotFoundError);
    await expect(createAlias(d, ownerB, ACCOUNT_A, chosen("x"), req)).rejects.toThrow(NotFoundError);
    await expect(deleteAlias(d, ownerB, ACCOUNT_A, a.id, req)).rejects.toThrow(NotFoundError);
    await expect(setAliasEnabled(d, ownerB, ACCOUNT_B, a.id, { enabled: false }, req)).rejects.toThrow(NotFoundError);
    await expect(deleteAlias(d, owner, ACCOUNT_A, "not-an-id", req)).rejects.toThrow(NotFoundError);
    await expect(listAliases(d, auditor, ACCOUNT_A)).rejects.toThrow(ForbiddenError);
    await expect(createAlias(d, auditor, ACCOUNT_A, chosen("x"), req)).rejects.toThrow(ForbiddenError);
    await expect(listAliases(d, anonymous, ACCOUNT_A)).rejects.toThrow(UnauthenticatedError);
    expect(d.uow.state.audit.some((e) => e.result === "denied" && e.action === "alias.created")).toBe(true);
    expect(d.uow.state.aliases).toHaveLength(1);
  });
});

describe("admin lock: an alias an administrator turned off", () => {
  async function lockedByAdmin(admin = userAdmin) {
    const d = setup();
    const a = await createAlias(d, member, ACCOUNT_A, chosen("kid.shop", MBX_MEMBER), req);
    const off = await setAliasEnabled(d, admin, ACCOUNT_A, a.id, { enabled: false }, req);
    return { d, a, off };
  }

  it("an administrator turning off someone else's alias locks it, audited", async () => {
    const { d, off } = await lockedByAdmin();
    expect(off).toMatchObject({ enabled: false, adminLocked: true });
    expect(d.uow.state.aliases[0]).toMatchObject({ enabled: false, adminLocked: true });
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "alias.toggled",
      result: "success",
      meta: { enabled: false, adminLocked: true },
    });
    // Its person still sees it, marked.
    const seen = await listAliases(d, member, ACCOUNT_A);
    expect(seen.aliases).toEqual([expect.objectContaining({ address: "kid.shop@family.ca", adminLocked: true })]);
  });

  it("its person can't turn it back on or delete it (403, audited as denied); nothing changes", async () => {
    const { d, a } = await lockedByAdmin();
    await expect(setAliasEnabled(d, member, ACCOUNT_A, a.id, { enabled: true }, req)).rejects.toThrow(
      AliasAdminLockedError,
    );
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "alias.toggled",
      result: "denied",
      errorCode: "alias_admin_locked",
      target: { id: a.id, label: "kid.shop@family.ca" },
    });
    await expect(deleteAlias(d, member, ACCOUNT_A, a.id, req)).rejects.toThrow(AliasAdminLockedError);
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "alias.deleted",
      result: "denied",
      errorCode: "alias_admin_locked",
    });
    expect(new AliasAdminLockedError()).toBeInstanceOf(ForbiddenError);
    // Turning it off again is allowed and keeps the lock.
    expect(await setAliasEnabled(d, member, ACCOUNT_A, a.id, { enabled: false }, req)).toMatchObject({
      adminLocked: true,
    });
    expect(d.uow.state.aliases[0]).toMatchObject({ enabled: false, adminLocked: true });
  });

  it("an administrator lifts it by turning it on; then its person manages it again", async () => {
    const { d, a } = await lockedByAdmin(owner);
    const on = await setAliasEnabled(d, owner, ACCOUNT_A, a.id, { enabled: true }, req);
    expect(on).toMatchObject({ enabled: true, adminLocked: false });
    expect(d.uow.state.audit.at(-1)).toMatchObject({ meta: { enabled: true, adminLockLifted: true } });
    // Off by its own person: no lock, so they can turn it on again.
    expect(await setAliasEnabled(d, member, ACCOUNT_A, a.id, { enabled: false }, req)).toMatchObject({
      adminLocked: false,
    });
    expect(await setAliasEnabled(d, member, ACCOUNT_A, a.id, { enabled: true }, req)).toMatchObject({
      enabled: true,
    });
    expect(await deleteAlias(d, member, ACCOUNT_A, a.id, req)).toEqual({ id: a.id });
  });

  it("an administrator may delete a locked alias", async () => {
    const { d, a } = await lockedByAdmin();
    expect(await deleteAlias(d, userAdmin, ACCOUNT_A, a.id, req)).toEqual({ id: a.id });
  });

  it("an administrator turning off their own mailbox's alias doesn't lock it", async () => {
    const d = setup();
    const a = await createAlias(d, owner, ACCOUNT_A, chosen("me"), req);
    expect(await setAliasEnabled(d, owner, ACCOUNT_A, a.id, { enabled: false }, req)).toMatchObject({
      adminLocked: false,
    });
    expect(d.uow.state.audit.at(-1)?.meta).toEqual({ enabled: false });
  });

  it("out of scope stays 404, not the lock: another account and another person's mailbox", async () => {
    const { d, a } = await lockedByAdmin();
    const otherMember = user({ id: "other", account: [[ACCOUNT_A, "member"]] });
    await expect(setAliasEnabled(d, otherMember, ACCOUNT_A, a.id, { enabled: true }, req)).rejects.toThrow(
      NotFoundError,
    );
    await expect(setAliasEnabled(d, ownerB, ACCOUNT_A, a.id, { enabled: true }, req)).rejects.toThrow(NotFoundError);
    expect(d.uow.state.aliases[0]).toMatchObject({ enabled: false, adminLocked: true });
  });
});

describe("daily alias creation cap", () => {
  // Free's daily caps are no tighter than its yearly ones, so the daily brake is shown on a paid plan.
  const perDay = PLANS.plus.aliasCreationsPerDay;

  it("counts creations per UTC day and kind, not live aliases: deleting gives none back", async () => {
    const d = setup("plus");
    for (let i = 0; i < perDay.alias; i++) {
      const a = await createAlias(d, owner, ACCOUNT_A, chosen(`churn${String(i)}`), req);
      await deleteAlias(d, owner, ACCOUNT_A, a.id, req);
    }
    expect(d.uow.state.aliases).toHaveLength(0);
    const err = await createAlias(d, owner, ACCOUNT_A, chosen("one.more"), req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AliasDailyLimitError);
    expect(err).toMatchObject({
      code: "alias_daily_limit",
      message: `This account has created ${String(perDay.alias)} aliases today, the most it can in one day. You can create more after midnight UTC.`,
    });
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "alias.created",
      result: "denied",
      errorCode: "alias_daily_limit",
      meta: { kind: "alias", perDay: perDay.alias },
    });
    expect(d.uow.state.aliases).toHaveLength(0); // nothing created
    // Masked aliases have their own count.
    expect(await createAlias(d, owner, ACCOUNT_A, { kind: "masked", mailboxId: MBX_OWNER }, req)).toMatchObject({
      kind: "masked",
    });
    expect((await listAliases(d, owner, ACCOUNT_A)).limits.alias).toMatchObject({
      used: 0,
      createdToday: perDay.alias,
      perDay: perDay.alias,
    });
  });

  it("is per account, and resets at midnight UTC", async () => {
    const clock = fixedClock("2026-10-22T23:59:00Z");
    const d = setup("plus");
    d.clock = clock;
    for (let i = 0; i < perDay.alias; i++) {
      const m = await createAlias(d, owner, ACCOUNT_A, chosen(`day${String(i)}`), req);
      await deleteAlias(d, owner, ACCOUNT_A, m.id, req);
    }
    await expect(createAlias(d, member, ACCOUNT_A, chosen("kid.one", MBX_MEMBER), req)).rejects.toThrow(
      AliasDailyLimitError,
    );
    // Another account isn't affected.
    expect(await createAlias(d, ownerB, ACCOUNT_B, { kind: "masked", mailboxId: MBX_B }, req)).toBeTruthy();
    clock.set(new Date("2026-10-23T00:00:00Z"));
    expect(await createAlias(d, owner, ACCOUNT_A, chosen("next.day"), req)).toBeTruthy();
    expect((await listAliases(d, owner, ACCOUNT_A)).limits.alias.createdToday).toBe(1);
  });

  it("each plan has daily caps; paid plans' are higher and Free's are no looser than its yearly ones", () => {
    expect(PLANS.plus.aliasCreationsPerDay.alias).toBeGreaterThan(PLANS.free.aliasCreationsPerDay.alias);
    expect(PLANS.supporter.aliasCreationsPerDay).toEqual(PLANS.plus.aliasCreationsPerDay);
    expect(PLANS.free.aliasCreationsPerDay.alias).toBeLessThanOrEqual(ALIAS_CREATIONS_PER_YEAR.free.alias);
    expect(PLANS.free.aliasCreationsPerDay.masked).toBeLessThanOrEqual(ALIAS_CREATIONS_PER_YEAR.free.masked);
  });

  it("a refused create (bad input, plan limit) isn't counted", async () => {
    const d = setup("free");
    await expect(createAlias(d, owner, ACCOUNT_A, chosen("bad local"), req)).rejects.toThrow(ValidationError);
    await expect(createAlias(d, ownerB, ACCOUNT_A, chosen("x"), req)).rejects.toThrow(NotFoundError);
    expect((await listAliases(d, owner, ACCOUNT_A)).limits.alias.createdToday).toBe(0);
  });
});

describe("yearly alias creation cap (Free)", () => {
  const perYear = ALIAS_CREATIONS_PER_YEAR.free;

  /** Creates and deletes `n` aliases of a kind on the owner's mailbox (so the at-a-time limit never binds). */
  async function churn(d: ReturnType<typeof setup>, n: number, kind: "alias" | "masked", tag: string) {
    for (let i = 0; i < n; i++) {
      const input = kind === "alias" ? chosen(`${tag}${String(i)}`) : { kind, mailboxId: MBX_OWNER };
      const a = await createAlias(d, owner, ACCOUNT_A, input, req);
      await deleteAlias(d, owner, ACCOUNT_A, a.id, req);
    }
  }

  it("Free allows 10 new aliases a year; paid plans have no yearly cap", () => {
    expect(PLANS.free.aliases).toBe(10);
    expect(PLANS.free.aliasCreationsPerYear).toEqual({ alias: 10, masked: perYear.masked });
    expect(PLANS.free.maskedAliases).toBe(10); // masked aliases keep their own at-a-time limit
    expect(PLANS.plus.aliasCreationsPerYear).toBeNull();
    expect(PLANS.supporter.aliasCreationsPerYear).toBeNull();
    expect(PLANS.plus.aliases).toBeNull();
    expect(ALIASES_PER_MAILBOX).toBe(400);
  });

  it("deleting gives no slot back: refused with the date one returns (429 code), audited as denied", async () => {
    const d = setup("free");
    await churn(d, perYear.alias, "alias", "y");
    expect(d.uow.state.aliases).toHaveLength(0);
    const err = await createAlias(d, owner, ACCOUNT_A, chosen("one.more"), req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AliasYearlyLimitError);
    expect(err).toMatchObject({
      code: "alias_yearly_limit",
      message: "You can create 10 new aliases a year on Free; you can add more on Oct 22, 2027.",
    });
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "alias.created",
      result: "denied",
      errorCode: "alias_yearly_limit",
      meta: { kind: "alias", perYear: perYear.alias, nextSlot: "2027-10-22" },
    });
    expect(d.uow.state.aliases).toHaveLength(0);
    expect((await listAliases(d, owner, ACCOUNT_A)).limits.alias).toMatchObject({
      used: 0,
      createdThisYear: perYear.alias,
      perYear: perYear.alias,
      nextSlot: "2027-10-22",
    });
    // Masked aliases have their own yearly count.
    expect(await createAlias(d, owner, ACCOUNT_A, { kind: "masked", mailboxId: MBX_OWNER }, req)).toMatchObject({
      kind: "masked",
    });
  });

  it("masked aliases have a yearly cap of the same shape", async () => {
    const d = setup("free");
    d.clock = fixedClock("2026-10-22T12:00:00Z");
    await churn(d, 10, "masked", "m");
    (d.clock as ReturnType<typeof fixedClock>).set(new Date("2026-10-23T12:00:00Z")); // past the daily brake
    await churn(d, perYear.masked - 10, "masked", "m");
    const err = await createAlias(d, owner, ACCOUNT_A, { kind: "masked", mailboxId: MBX_OWNER }, req).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({
      code: "alias_yearly_limit",
      message: `You can create ${String(perYear.masked)} new masked aliases a year on Free; you can add more on Oct 22, 2027.`,
    });
    expect(d.uow.state.audit.at(-1)).toMatchObject({ action: "masked_alias.created", result: "denied" });
  });

  it("the year rolls: each creation counts for 365 days, then its slot comes back", async () => {
    const clock = fixedClock("2026-01-10T08:00:00Z");
    const d = setup("free");
    d.clock = clock;
    await churn(d, 3, "alias", "jan");
    clock.set(new Date("2026-06-01T08:00:00Z"));
    await churn(d, 7, "alias", "jun");
    clock.set(new Date("2026-12-01T08:00:00Z"));
    await expect(createAlias(d, owner, ACCOUNT_A, chosen("dec"), req)).rejects.toThrow(
      "you can add more on Jan 10, 2027.",
    );
    clock.set(new Date("2027-01-09T23:59:59Z")); // the January creations still count, day 365
    await expect(createAlias(d, owner, ACCOUNT_A, chosen("dec"), req)).rejects.toThrow(AliasYearlyLimitError);
    clock.set(new Date("2027-01-10T00:00:00Z")); // …and drop out at midnight UTC: three slots back
    expect((await listAliases(d, owner, ACCOUNT_A)).limits.alias).toMatchObject({
      createdThisYear: 7,
      nextSlot: null,
    });
    await churn(d, 3, "alias", "back");
    await expect(createAlias(d, owner, ACCOUNT_A, chosen("dec"), req)).rejects.toThrow(
      "you can add more on Jun 1, 2027.",
    );
  });

  it("holds under concurrent creates: exactly the remaining slots succeed", async () => {
    const d = setup("free");
    await churn(d, perYear.masked - 5, "masked", "c");
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => createAlias(d, owner, ACCOUNT_A, { kind: "masked", mailboxId: MBX_OWNER }, req)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    const refused = results.flatMap((r) => (r.status === "rejected" ? [r.reason as unknown] : []));
    expect(refused).toHaveLength(5);
    for (const e of refused) expect(e).toBeInstanceOf(AliasYearlyLimitError);
    expect((await listAliases(d, owner, ACCOUNT_A)).limits.masked).toMatchObject({
      used: 5,
      createdThisYear: perYear.masked,
    });
  });

  it("refused creates never count: yearly, at-a-time, bad input", async () => {
    const d = setup("free");
    await churn(d, perYear.alias, "alias", "r");
    for (let i = 0; i < 3; i++) {
      await expect(createAlias(d, owner, ACCOUNT_A, chosen(`r.more${String(i)}`), req)).rejects.toThrow(
        AliasYearlyLimitError,
      );
    }
    await expect(createAlias(d, owner, ACCOUNT_A, chosen("bad local"), req)).rejects.toThrow(ValidationError);
    expect((await listAliases(d, owner, ACCOUNT_A)).limits.alias.createdThisYear).toBe(perYear.alias);
    // At-a-time refusals don't count either.
    const e = setup("free");
    for (let i = 0; i < 10; i++) await createAlias(e, owner, ACCOUNT_A, { kind: "masked", mailboxId: MBX_OWNER }, req);
    await expect(createAlias(e, owner, ACCOUNT_A, { kind: "masked", mailboxId: MBX_OWNER }, req)).rejects.toThrow(
      PlanLimitError,
    );
    expect((await listAliases(e, owner, ACCOUNT_A)).limits.masked.createdThisYear).toBe(10);
  });

  it("is per account", async () => {
    const d = setup("free");
    d.uow.state.accounts[1]!.plan = "free";
    await churn(d, perYear.alias, "alias", "p");
    await expect(createAlias(d, owner, ACCOUNT_A, chosen("p.more"), req)).rejects.toThrow(AliasYearlyLimitError);
    expect(
      await createAlias(d, ownerB, ACCOUNT_B, { localPart: "fine", domainId: DOMAIN_B, mailboxId: MBX_B }, req),
    ).toBeTruthy();
  });

  it("paid plans have no yearly cap", async () => {
    const d = setup("plus");
    expect((await listAliases(d, owner, ACCOUNT_A)).limits.alias).toMatchObject({ perYear: null, nextSlot: null });
  });

  it("yearlyUse finds the day enough of the oldest creations drop out", () => {
    expect(yearlyUse([], 10)).toEqual({ used: 0, nextSlot: null });
    expect(yearlyUse([{ day: "2026-03-01", count: 4 }], null)).toEqual({ used: 4, nextSlot: null });
    const days = [
      { day: "2026-06-01", count: 6 },
      { day: "2026-01-10", count: 3 },
      { day: "2026-02-28", count: 1 },
    ];
    expect(yearlyUse(days, 11)).toEqual({ used: 10, nextSlot: null });
    expect(yearlyUse(days, 10)).toEqual({ used: 10, nextSlot: "2027-01-10" }); // one slot: January's go first
    expect(yearlyUse(days, 8)).toEqual({ used: 10, nextSlot: "2027-01-10" }); // three needed: January's three
    expect(yearlyUse(days, 7)).toEqual({ used: 10, nextSlot: "2027-02-28" }); // four needed: 3 + 1 by February
    expect(yearlyUse(days, 6)).toEqual({ used: 10, nextSlot: "2027-06-01" });
    expect(yearlyUse(days, 2)).toEqual({ used: 10, nextSlot: "2027-06-01" });
    // Across a leap day: 365 days after 2027-03-01 is 2028-02-29.
    expect(yearlyUse([{ day: "2027-03-01", count: 1 }], 1)).toEqual({ used: 1, nextSlot: "2028-02-29" });
  });
});

describe("addresses per mailbox", () => {
  /** Puts `n` aliases (both kinds) straight onto a mailbox, as if created over time. */
  function fill(d: ReturnType<typeof setup>, mailboxId: string, n: number) {
    for (let i = 0; i < n; i++) {
      d.uow.state.aliases.push({
        id: crypto.randomUUID(),
        accountId: ACCOUNT_A,
        mailboxId,
        address: `fill${String(i)}-${mailboxId.slice(0, 4)}@family.ca`,
        kind: i % 2 === 0 ? "alias" : "masked",
        enabled: true,
        adminLocked: false,
        description: null,
        createdAt: new Date(0),
      });
    }
  }

  it("a mailbox takes up to 400 aliases and masked aliases together (409 code), audited as denied", async () => {
    const d = setup("plus");
    fill(d, MBX_OWNER, ALIASES_PER_MAILBOX - 1);
    expect(await createAlias(d, owner, ACCOUNT_A, chosen("last"), req)).toMatchObject({ address: "last@family.ca" });
    for (const input of [chosen("over"), { kind: "masked", mailboxId: MBX_OWNER }]) {
      const err = await createAlias(d, owner, ACCOUNT_A, input, req).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AliasMailboxLimitError);
      expect(err).toMatchObject({
        code: "alias_mailbox_limit",
        message:
          "A mailbox can have at most 400 addresses (aliases and masked aliases together). Delete one, or point the new one at another mailbox.",
      });
    }
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "masked_alias.created",
      result: "denied",
      errorCode: "alias_mailbox_limit",
      meta: { kind: "masked", perMailbox: ALIASES_PER_MAILBOX, mailbox: "o***@family.ca" }, // redacted like any address
    });
    expect(d.uow.state.aliases).toHaveLength(ALIASES_PER_MAILBOX);
    // Refusals aren't counted toward the daily cap.
    expect((await listAliases(d, owner, ACCOUNT_A)).limits.alias.createdToday).toBe(1);
  });

  it("is per mailbox, not per account; deleting one makes room again", async () => {
    const d = setup("plus");
    fill(d, MBX_OWNER, ALIASES_PER_MAILBOX);
    expect(await createAlias(d, owner, ACCOUNT_A, chosen("kid.extra", MBX_MEMBER), req)).toBeTruthy();
    const o = await listAliases(d, owner, ACCOUNT_A);
    expect(o.mailboxes).toHaveLength(2);
    expect(o.mailboxes).toEqual(
      expect.arrayContaining([
        { id: MBX_OWNER, address: "owner@family.ca", addresses: ALIASES_PER_MAILBOX },
        { id: MBX_MEMBER, address: "kid@family.ca", addresses: 1 },
      ]),
    );
    expect(o.limits.alias.max).toBeNull();
    const one = d.uow.state.aliases.find((a) => a.mailboxId === MBX_OWNER);
    await deleteAlias(d, owner, ACCOUNT_A, one!.id, req);
    expect(await createAlias(d, owner, ACCOUNT_A, chosen("room"), req)).toBeTruthy();
  });
});
