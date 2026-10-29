// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ACCOUNT_A, ACCOUNT_B, anonymous, deps as makeDeps, fixedClock, req, user } from "../__tests__/helpers";
import {
  AliasAdminLockedError,
  AliasDailyLimitError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PlanLimitError,
  UnauthenticatedError,
  ValidationError,
} from "../errors";
import { maskedLocalPart, normaliseDescription } from "./entity";
import { createAlias, deleteAlias, listAliases, setAliasEnabled } from "./service";
import { PLANS } from "@anhourmail/shared/plans";

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
    for (let i = 0; i < 5; i++) await createAlias(d, owner, ACCOUNT_A, chosen(`a${String(i)}`), req);
    await expect(createAlias(d, owner, ACCOUNT_A, chosen("a5"), req)).rejects.toThrow(PlanLimitError);
    await createAlias(d, owner, ACCOUNT_A, { kind: "masked", mailboxId: MBX_OWNER }, req);
    const o = await listAliases(d, owner, ACCOUNT_A);
    expect(o.limits).toEqual({
      alias: { used: 5, max: 5, createdToday: 5, perDay: PLANS.free.aliasCreationsPerDay.alias },
      masked: { used: 1, max: 10, createdToday: 1, perDay: PLANS.free.aliasCreationsPerDay.masked },
    });
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
  const perDay = PLANS.free.aliasCreationsPerDay;

  it("counts creations per UTC day and kind, not live aliases: deleting gives none back", async () => {
    const d = setup("free");
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
    const d = setup("free");
    d.clock = clock;
    for (let i = 0; i < perDay.masked; i++) {
      const m = await createAlias(d, owner, ACCOUNT_A, { kind: "masked", mailboxId: MBX_OWNER }, req);
      await deleteAlias(d, owner, ACCOUNT_A, m.id, req);
    }
    await expect(createAlias(d, member, ACCOUNT_A, { kind: "masked", mailboxId: MBX_MEMBER }, req)).rejects.toThrow(
      AliasDailyLimitError,
    );
    // Another account isn't affected.
    expect(await createAlias(d, ownerB, ACCOUNT_B, { kind: "masked", mailboxId: MBX_B }, req)).toBeTruthy();
    clock.set(new Date("2026-10-23T00:00:00Z"));
    expect(await createAlias(d, owner, ACCOUNT_A, { kind: "masked", mailboxId: MBX_OWNER }, req)).toBeTruthy();
    expect((await listAliases(d, owner, ACCOUNT_A)).limits.masked.createdToday).toBe(1);
  });

  it("paid plans have their own (higher) daily caps", () => {
    expect(PLANS.plus.aliasCreationsPerDay.alias).toBeGreaterThan(perDay.alias);
    expect(PLANS.supporter.aliasCreationsPerDay).toEqual(PLANS.plus.aliasCreationsPerDay);
  });

  it("a refused create (bad input, plan limit) isn't counted", async () => {
    const d = setup("free");
    await expect(createAlias(d, owner, ACCOUNT_A, chosen("bad local"), req)).rejects.toThrow(ValidationError);
    await expect(createAlias(d, ownerB, ACCOUNT_A, chosen("x"), req)).rejects.toThrow(NotFoundError);
    expect((await listAliases(d, owner, ACCOUNT_A)).limits.alias.createdToday).toBe(0);
  });
});
