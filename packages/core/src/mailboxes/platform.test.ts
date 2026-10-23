// SPDX-License-Identifier: AGPL-3.0-only
import { platformFacts } from "@anhourmail/shared/platform";
import { MAX_MAILBOXES } from "@anhourmail/shared/plans";
import { describe, expect, it, vi } from "vitest";

import type * as AliasEntity from "../aliases/entity";

/** Masked local parts the next masked aliases get (then random again): to force a reserved-looking draw. */
const forcedMasked: string[] = [];
vi.mock("../aliases/entity", async (importOriginal) => {
  const actual = await importOriginal<typeof AliasEntity>();
  return { ...actual, maskedLocalPart: () => forcedMasked.shift() ?? actual.maskedLocalPart() };
});

import {
  ACCOUNT_A,
  ACCOUNT_B,
  anonymous,
  deps as makeDeps,
  fakeHasher,
  fixedClock,
  MAILBOX_PW,
  req,
  user,
} from "../__tests__/helpers";
import type { Actor } from "../actor";
import { createAlias, deleteAlias } from "../aliases/service";
import {
  ConflictError,
  EmailUnverifiedError,
  ForbiddenError,
  NotFoundError,
  PlanLimitError,
  UnauthenticatedError,
  ValidationError,
} from "../errors";
import type { Deps } from "../ports";
import type { MailServer } from "../provisioning/ports";
import { CHECK_REFUSED, checkPlatformAddress, normalisePlatformLocalPart, PLATFORM_DOMAIN_ID } from "./platform";
import { createMailbox, deleteMailbox, mailboxOptions, purgeDueMailboxes, staffCreatePlatformMailbox } from "./service";

const PLATFORM = "platform-mail.test"; // TEST_PLATFORM's domain
const owner = user({ id: "owner", account: [[ACCOUNT_A, "owner"]] });
const member = user({ id: "member", account: [[ACCOUNT_A, "member"]] });
const ownerB = user({ id: "owner-b", account: [[ACCOUNT_B, "owner"]] });
const globalAdmin = user({ id: "ga", platform: ["global_admin"] });
const supportAdmin = user({ id: "sa", platform: ["support_admin"] });

function setup(planA: "free" | "plus" = "free", planB: "free" | "plus" = "free") {
  const clock = fixedClock("2026-10-23T12:00:00Z");
  const d = makeDeps(clock);
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "A", plan: planA }, { id: ACCOUNT_B, name: "B", plan: planB });
  for (const [userId, accountId, role] of [
    ["owner", ACCOUNT_A, "owner"],
    ["member", ACCOUNT_A, "member"],
    ["owner-b", ACCOUNT_B, "owner"],
  ] as const) {
    s.memberships.push({ userId, accountId, role });
    s.userEmails[userId] = `${userId}@example.ca`;
  }
  return { d, clock };
}

const claim = (d: Deps, actor: Actor, accountId: string, localPart: unknown, extra: Record<string, unknown> = {}) =>
  createMailbox(
    d,
    actor,
    accountId,
    { localPart, domainId: PLATFORM_DOMAIN_ID, password: MAILBOX_PW, ...extra },
    req,
    fakeHasher,
  );

const DAY = 24 * 3600_000;

function fakeMail(): MailServer {
  const unused = () => Promise.reject(new Error("not used"));
  return {
    ensureDomain: unused,
    ensureMailbox: unused,
    removeDomain: unused,
    listDomains: unused,
    listMailboxes: unused,
    revokeAppPassword: unused,
    setMailboxPassword: unused,
    destroyMailbox: async () => undefined,
  };
}

/** Deletes a mailbox and lets its grace period run out, then purges it. */
async function purge(
  d: Deps & { uow: { state: { mailboxes: { id: string }[] } } },
  clock: ReturnType<typeof fixedClock>,
  actor: Actor,
  accountId: string,
  id: string,
) {
  await deleteMailbox(d, actor, accountId, id, req);
  clock.set(new Date(clock.now().getTime() + 31 * DAY));
  expect(await purgeDueMailboxes(d, fakeMail())).toEqual({ purged: 1, failed: 0 });
}

describe("platform-domain local parts", () => {
  it("lowercases and trims, and applies the shared rules (length, reserved, characters)", () => {
    expect(normalisePlatformLocalPart("  Jane.Doe ")).toBe("jane.doe");
    for (const bad of [undefined, 42, "", "abc", "x".repeat(33), "admin", "svc-ops", "jane..doe", ".jane", "jane+1"]) {
      expect(() => normalisePlatformLocalPart(bad)).toThrow(ValidationError);
    }
  });
});

describe("creating a free platform address", () => {
  it("a Free account gets one: a provisioning job, the password's hash, audited as a platform address", async () => {
    const { d } = setup();
    const m = await claim(d, owner, ACCOUNT_A, "Jane.Doe", { ownerUserId: "owner" });
    expect(m).toMatchObject({ address: `jane.doe@${PLATFORM}`, status: "provisioning", owner: { userId: "owner" } });
    expect(m.quotaBytes).toBe(10 * 1024 ** 3);
    const s = d.uow.state;
    expect(s.jobs).toMatchObject([{ kind: "mailbox.ensure", subjectId: m.id }]);
    expect(s.mailboxPasswords.find((p) => p.mailboxId === m.id)?.pendingHash).toBe(await fakeHasher.hash(MAILBOX_PW));
    expect(s.audit.at(-1)).toMatchObject({
      scope: `account:${ACCOUNT_A}`,
      action: "mailbox.created",
      result: "success",
      target: { label: `jane.doe@${PLATFORM}` },
      meta: { platformAddress: true },
    });
    expect(JSON.stringify(s.audit)).not.toContain(MAILBOX_PW);
  });

  it("refuses a second one on Free, and says why; the options say there is no room", async () => {
    const { d } = setup();
    await claim(d, owner, ACCOUNT_A, "first");
    await expect(claim(d, owner, ACCOUNT_A, "second")).rejects.toThrow(
      new PlanLimitError(`This plan includes one free @${PLATFORM} address.`),
    );
    expect((await mailboxOptions(d, owner, ACCOUNT_A)).platform).toMatchObject({ used: 1, max: 1, allowed: false });
    expect(d.uow.state.audit.at(-1)).toMatchObject({ result: "failed", errorCode: "plan_limit" });
  });

  it("a deleting free address still holds the account's one place", async () => {
    const { d } = setup();
    const m = await claim(d, owner, ACCOUNT_A, "first");
    await deleteMailbox(d, owner, ACCOUNT_A, m.id, req);
    await expect(claim(d, owner, ACCOUNT_A, "second")).rejects.toThrow(PlanLimitError);
  });

  it("paid plans: platform addresses count toward the mailbox ceiling like any other", async () => {
    const { d } = setup("plus");
    for (let i = 0; i < MAX_MAILBOXES; i++) await claim(d, owner, ACCOUNT_A, `name${String(i)}`);
    await expect(claim(d, owner, ACCOUNT_A, "onemore")).rejects.toThrow(
      new PlanLimitError(`An account can have up to ${String(MAX_MAILBOXES)} mailboxes.`),
    );
    expect((await mailboxOptions(d, owner, ACCOUNT_A)).platform).toMatchObject({
      used: MAX_MAILBOXES,
      max: null,
      allowed: false,
    });
  });

  it("needs the person's sign-in email confirmed (403 email_unverified, audited as denied, nothing written)", async () => {
    const { d } = setup();
    d.uow.state.unverifiedEmails.push("owner");
    await expect(claim(d, owner, ACCOUNT_A, "jane")).rejects.toThrow(EmailUnverifiedError);
    expect(d.uow.state.mailboxes).toHaveLength(0);
    expect(d.uow.state.audit.at(-1)).toMatchObject({ result: "denied", errorCode: "email_unverified" });
    expect((await mailboxOptions(d, owner, ACCOUNT_A)).platform.emailVerified).toBe(false);
  });

  it("names are global and case-insensitive: another account's address (mailbox or alias) is in use", async () => {
    const { d } = setup();
    await claim(d, owner, ACCOUNT_A, "jane");
    await expect(claim(d, ownerB, ACCOUNT_B, "JANE")).rejects.toThrow(ConflictError);
    d.uow.state.aliases.push({
      id: "a1",
      accountId: ACCOUNT_A,
      mailboxId: d.uow.state.mailboxes[0]?.id ?? "",
      address: `alias.taken@${PLATFORM}`,
      kind: "masked",
      enabled: true,
      description: null,
      createdAt: new Date(0),
    });
    await expect(claim(d, ownerB, ACCOUNT_B, "alias.taken")).rejects.toThrow(ConflictError);
  });

  it("refuses imitations of reserved names and our own names", async () => {
    const { d } = setup();
    for (const name of ["no.reply", "post_master", "admin2", "mailerdaemon", "anhourmail.help"]) {
      await expect(claim(d, owner, ACCOUNT_A, name)).rejects.toThrow(/reserved/);
    }
    expect(d.uow.state.mailboxes).toHaveLength(0);
  });

  it("refuses reserved and short names with the rule, before anything is written", async () => {
    const { d } = setup();
    await expect(claim(d, owner, ACCOUNT_A, "abc")).rejects.toThrow(/at least 4/);
    await expect(claim(d, owner, ACCOUNT_A, "postmaster")).rejects.toThrow(/reserved/);
    await expect(claim(d, owner, ACCOUNT_A, "Support")).rejects.toThrow(/reserved/);
    expect(d.uow.state.mailboxes).toHaveLength(0);
  });

  it("permission and scope: a Member is refused (403), another account's id is not found (404), signed out 401", async () => {
    const { d } = setup();
    await expect(claim(d, member, ACCOUNT_A, "jane")).rejects.toThrow(ForbiddenError);
    await expect(claim(d, ownerB, ACCOUNT_A, "jane")).rejects.toThrow(NotFoundError);
    await expect(claim(d, anonymous, ACCOUNT_A, "jane")).rejects.toThrow(UnauthenticatedError);
    expect(d.uow.state.mailboxes).toHaveLength(0);
    expect(d.uow.state.audit.filter((e) => e.result === "denied").map((e) => e.scope)).toEqual([
      `account:${ACCOUNT_A}`,
      "platform",
      "platform",
    ]);
  });

  it("is refused while staff act as someone", async () => {
    const { d } = setup();
    const actingAs = {
      ...owner,
      actingAs: { staffUserId: "ga", staffEmail: "ga@anhourtec.test", staffRole: "global_admin" as const, reason: "t" },
    };
    await expect(claim(d, actingAs, ACCOUNT_A, "jane")).rejects.toThrow(ForbiddenError);
    expect(d.uow.state.mailboxes).toHaveLength(0);
  });

  it("never on the company's staff domain (rule 28)", async () => {
    const { d } = setup();
    const staffDomain = { ...d, platform: platformFacts("anhourtec.com") };
    await expect(claim(staffDomain, owner, ACCOUNT_A, "jane")).rejects.toThrow(ValidationError);
    await expect(checkPlatformAddress(staffDomain, owner, ACCOUNT_A, "jane")).rejects.toThrow(ValidationError);
  });
});

describe("retired platform addresses", () => {
  it("a purged free address never goes to another account; the account that held it may take it back", async () => {
    const { d, clock } = setup();
    const m = await claim(d, owner, ACCOUNT_A, "jane");
    d.uow.state.mailboxes.find((x) => x.id === m.id)!.status = "active";
    await purge(d, clock, owner, ACCOUNT_A, m.id);
    expect(d.uow.state.retiredPlatformAddresses).toMatchObject([{ address: `jane@${PLATFORM}`, accountId: ACCOUNT_A }]);
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "platform.mailbox_purged",
      meta: { retiredPlatformAddresses: 1 },
    });
    await expect(claim(d, ownerB, ACCOUNT_B, "jane")).rejects.toThrow(ConflictError);
    expect(await checkPlatformAddress(d, ownerB, ACCOUNT_B, "jane")).toEqual({
      address: `jane@${PLATFORM}`,
      available: false,
      problem: null,
    });
    expect((await checkPlatformAddress(d, owner, ACCOUNT_A, "jane")).available).toBe(true);
    expect((await claim(d, owner, ACCOUNT_A, "jane")).address).toBe(`jane@${PLATFORM}`);
  });

  it("purging a custom-domain mailbox retires nothing", async () => {
    const { d, clock } = setup("plus");
    d.uow.state.domains.push({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      accountId: ACCOUNT_A,
      name: "family.ca",
      status: "active",
      verifyToken: "t",
      stalwartId: null,
      lastError: null,
      createdAt: new Date(0),
    });
    const m = await createMailbox(
      d,
      owner,
      ACCOUNT_A,
      { localPart: "jo", domainId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", password: MAILBOX_PW },
      req,
      fakeHasher,
    );
    await purge(d, clock, owner, ACCOUNT_A, m.id);
    expect(d.uow.state.retiredPlatformAddresses).toEqual([]);
  });

  it("masked aliases on the platform domain: a deleted one is retired, and its masked aliases go with a purge", async () => {
    const { d, clock } = setup();
    const m = await claim(d, owner, ACCOUNT_A, "jane", { ownerUserId: "owner" });
    d.uow.state.mailboxes.find((x) => x.id === m.id)!.status = "active";
    const kept = await createAlias(d, owner, ACCOUNT_A, { kind: "masked", mailboxId: m.id }, req);
    const gone = await createAlias(d, owner, ACCOUNT_A, { kind: "masked", mailboxId: m.id }, req);
    expect(kept.address.endsWith(`@${PLATFORM}`)).toBe(true);
    await deleteAlias(d, owner, ACCOUNT_A, gone.id, req);
    expect(d.uow.state.retiredPlatformAddresses.map((r) => r.address)).toEqual([gone.address]);
    await purge(d, clock, owner, ACCOUNT_A, m.id);
    expect(d.uow.state.retiredPlatformAddresses.map((r) => r.address).sort()).toEqual(
      [gone.address, kept.address, `jane@${PLATFORM}`].sort(),
    );
  });
});

describe("masked aliases on the platform domain", () => {
  it("skip a random name that reads as a reserved one", async () => {
    const { d } = setup();
    const m = await claim(d, owner, ACCOUNT_A, "jane", { ownerUserId: "owner" });
    forcedMasked.push("news23456789", "bounces23456", "kq7m2xp9vb3t");
    const a = await createAlias(d, owner, ACCOUNT_A, { kind: "masked", mailboxId: m.id }, req);
    expect(a.address).toBe(`kq7m2xp9vb3t@${PLATFORM}`);
  });
});

describe("availability check", () => {
  it("answers only available or not (never why), and the rule for a malformed name", async () => {
    const { d } = setup();
    await claim(d, owner, ACCOUNT_A, "taken");
    expect(await checkPlatformAddress(d, ownerB, ACCOUNT_B, "Free.Name")).toEqual({
      address: `free.name@${PLATFORM}`,
      available: true,
      problem: null,
    });
    expect(await checkPlatformAddress(d, ownerB, ACCOUNT_B, "taken")).toEqual({
      address: `taken@${PLATFORM}`,
      available: false,
      problem: null,
    });
    expect(await checkPlatformAddress(d, ownerB, ACCOUNT_B, "ab")).toMatchObject({ available: false, address: null });
    expect((await checkPlatformAddress(d, ownerB, ACCOUNT_B, "admin")).problem).toBe("That name is reserved.");
    expect(await checkPlatformAddress(d, ownerB, ACCOUNT_B, 7)).toMatchObject({ available: false, address: null });
  });

  it("only answers someone who could claim one: confirmed email and room in the allowance (one generic 403)", async () => {
    const { d } = setup();
    d.uow.state.unverifiedEmails.push("owner-b");
    await expect(checkPlatformAddress(d, ownerB, ACCOUNT_B, "jane")).rejects.toThrow(new ForbiddenError(CHECK_REFUSED));
    d.uow.state.unverifiedEmails = [];
    await claim(d, owner, ACCOUNT_A, "first"); // Free: no room left in A
    await expect(checkPlatformAddress(d, owner, ACCOUNT_A, "jane")).rejects.toThrow(new ForbiddenError(CHECK_REFUSED));
    expect((await checkPlatformAddress(d, ownerB, ACCOUNT_B, "jane")).available).toBe(true);
  });

  it("in use and retired look the same, and both look-ups always run", async () => {
    const { d, clock } = setup("plus", "plus");
    const m = await claim(d, owner, ACCOUNT_A, "gone.name");
    d.uow.state.mailboxes.find((x) => x.id === m.id)!.status = "active";
    await purge(d, clock, owner, ACCOUNT_A, m.id);
    await claim(d, owner, ACCOUNT_A, "live.name");
    const calls: string[] = [];
    const counting: Deps = {
      ...d,
      uow: {
        run: (fn) =>
          d.uow.run((r) =>
            fn({
              ...r,
              mailboxes: {
                ...r.mailboxes,
                addressTaken: async (a) => {
                  calls.push("taken");
                  return r.mailboxes.addressTaken(a);
                },
              },
              platformAddresses: {
                ...r.platformAddresses,
                retiredFrom: async (a) => {
                  calls.push("retired");
                  return r.platformAddresses.retiredFrom(a);
                },
              },
            }),
          ),
      },
    };
    const retired = await checkPlatformAddress(counting, ownerB, ACCOUNT_B, "gone.name");
    const inUse = await checkPlatformAddress(counting, ownerB, ACCOUNT_B, "live.name");
    expect([retired.available, retired.problem]).toEqual([inUse.available, inUse.problem]);
    expect(calls).toEqual(["taken", "retired", "taken", "retired"]);
  });

  it("needs mailbox.manage in that account: 403 for a Member, 404 for another account, 401 signed out", async () => {
    const { d } = setup();
    await expect(checkPlatformAddress(d, member, ACCOUNT_A, "jane")).rejects.toThrow(ForbiddenError);
    await expect(checkPlatformAddress(d, ownerB, ACCOUNT_A, "jane")).rejects.toThrow(NotFoundError);
    await expect(checkPlatformAddress(d, anonymous, ACCOUNT_A, "jane")).rejects.toThrow(UnauthenticatedError);
  });
});

describe("staff create a platform address in a customer account", () => {
  it("a Global Administrator creates one without a password; audited as staff in the account's own log", async () => {
    const { d } = setup();
    d.uow.state.unverifiedEmails.push("owner"); // staff vouch for it: no email-confirmation requirement
    const m = await staffCreatePlatformMailbox(
      d,
      globalAdmin,
      ACCOUNT_A,
      { localPart: "Pat.Lee", ownerUserId: "owner" },
      req,
    );
    expect(m).toMatchObject({ address: `pat.lee@${PLATFORM}`, status: "provisioning", owner: { userId: "owner" } });
    expect(d.uow.state.mailboxPasswords.find((p) => p.mailboxId === m.id)).toBeUndefined();
    expect(d.uow.state.jobs).toMatchObject([{ kind: "mailbox.ensure", subjectId: m.id }]);
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      scope: `account:${ACCOUNT_A}`,
      action: "mailbox.created",
      result: "success",
      actor: { type: "staff", userId: "ga" },
      meta: { platformAddress: true, passwordSetBy: "account" },
    });
  });

  it("keeps the same rules: name, uniqueness, the plan's allowance and someone in the account", async () => {
    const { d } = setup();
    await expect(staffCreatePlatformMailbox(d, globalAdmin, ACCOUNT_A, { localPart: "abc" }, req)).rejects.toThrow(
      ValidationError,
    );
    await expect(
      staffCreatePlatformMailbox(d, globalAdmin, ACCOUNT_A, { localPart: "jane", ownerUserId: "owner-b" }, req),
    ).rejects.toThrow(/Choose someone in this account/);
    await claim(d, ownerB, ACCOUNT_B, "jane");
    await expect(staffCreatePlatformMailbox(d, globalAdmin, ACCOUNT_A, { localPart: "jane" }, req)).rejects.toThrow(
      ConflictError,
    );
    await staffCreatePlatformMailbox(d, globalAdmin, ACCOUNT_A, { localPart: "first" }, req);
    await expect(staffCreatePlatformMailbox(d, globalAdmin, ACCOUNT_A, { localPart: "second" }, req)).rejects.toThrow(
      PlanLimitError,
    );
  });

  it("other staff and customers are refused (403, audited in the platform log only); unknown accounts are 404", async () => {
    const { d } = setup();
    await expect(staffCreatePlatformMailbox(d, supportAdmin, ACCOUNT_A, { localPart: "jane" }, req)).rejects.toThrow(
      ForbiddenError,
    );
    await expect(staffCreatePlatformMailbox(d, owner, ACCOUNT_A, { localPart: "jane" }, req)).rejects.toThrow(
      ForbiddenError,
    );
    await expect(staffCreatePlatformMailbox(d, anonymous, ACCOUNT_A, { localPart: "jane" }, req)).rejects.toThrow(
      UnauthenticatedError,
    );
    const unknown = "33333333-3333-4333-8333-333333333333";
    await expect(staffCreatePlatformMailbox(d, globalAdmin, unknown, { localPart: "jane" }, req)).rejects.toThrow(
      NotFoundError,
    );
    await expect(staffCreatePlatformMailbox(d, globalAdmin, "not-an-id", { localPart: "jane" }, req)).rejects.toThrow(
      NotFoundError,
    );
    expect(d.uow.state.mailboxes).toHaveLength(0);
    const denied = d.uow.state.audit.filter((e) => e.result === "denied");
    expect(denied.map((e) => [e.scope, e.errorCode])).toEqual([
      ["platform", "forbidden"],
      ["platform", "forbidden"],
      ["platform", "unauthorized"],
      ["platform", "not_found"],
      ["platform", "not_found"],
    ]);
    expect(d.uow.state.audit.some((e) => e.scope === `account:${ACCOUNT_A}`)).toBe(false);
  });

  it("is refused while acting as someone (audited as denied in the account's log)", async () => {
    const { d } = setup();
    const actingAs = {
      ...globalAdmin,
      actingAs: { staffUserId: "ga", staffEmail: "ga@anhourtec.test", staffRole: "global_admin" as const, reason: "t" },
    };
    await expect(staffCreatePlatformMailbox(d, actingAs, ACCOUNT_A, { localPart: "jane" }, req)).rejects.toThrow(
      ForbiddenError,
    );
    expect(d.uow.state.mailboxes).toHaveLength(0);
    expect(d.uow.state.audit.at(-1)).toMatchObject({ result: "denied", errorCode: "act_as" });
  });
});
