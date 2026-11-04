// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Ceilings in the create services (ADR-0029 §7): the mailbox ceiling grows with the extra mailboxes in force (and the
 * people ceiling with it), the pool with the storage blocks in force, and the account-wide address ceiling from
 * configuration refuses mailbox and alias creation with 409 `address_ceiling`, audited as denied, fail closed. Staff
 * set a per-account override with a step-up, audited in the account's log.
 */
import { describe, expect, it } from "vitest";

import { mailboxCeiling, MAX_MAILBOXES } from "@anhourmail/shared/plans";

import {
  ACCOUNT_A,
  ACCOUNT_B,
  actingStaff,
  deps as makeDeps,
  fakeHasher,
  fixedClock,
  MAILBOX_PW,
  req,
  user,
} from "../__tests__/helpers";
import type { Actor } from "../actor";
import { createAlias } from "../aliases/service";
import { ForbiddenError, NotFoundError, PlanLimitError, StepUpRequiredError, ValidationError } from "../errors";
import { createMailbox, mailboxOptions, mailboxStoragePool, staffCreatePlatformMailbox } from "../mailboxes/service";
import { listPeople } from "../people/service";
import type { Deps } from "../ports";

import { accountCeilingsOf, addressCeilingReached, DEV_ADDRESS_CEILING } from "./ceilings";
import { BillingError } from "./entitlements";
import { defaultBilling } from "./lifecycle";
import { setAddressCeilingOverride } from "./service";

const DOMAIN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const owner = user({ id: "owner", account: [[ACCOUNT_A, "owner"]] });
const billingStaff = user({ id: "staff-billing", platform: ["billing_admin"] });
const supportStaff = user({ id: "staff-support", platform: ["support_admin"] });
const SESSION = { sessionId: "session-1" };

function setup(opts: { ceiling?: number; extraMailboxes?: number; storageBlocks?: number } = {}) {
  const clock = fixedClock("2026-11-04T12:00:00Z");
  const d: Deps & { uow: ReturnType<typeof makeDeps>["uow"] } = {
    ...makeDeps(clock),
    ...(opts.ceiling === undefined ? {} : { limits: { addressCeiling: opts.ceiling } }),
  };
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "A", plan: "plus" }, { id: ACCOUNT_B, name: "B", plan: "free" });
  s.memberships.push({ userId: "owner", accountId: ACCOUNT_A, role: "owner" });
  s.userEmails.owner = "owner@example.ca";
  s.userEmails["staff-billing"] = "billing@anhourtec.test";
  s.domains.push({
    id: DOMAIN_A,
    accountId: ACCOUNT_A,
    name: "family.ca",
    status: "active",
    verifyToken: "t",
    stalwartId: null,
    lastError: null,
    createdAt: new Date(0),
  });
  const extra = opts.extraMailboxes ?? 0;
  const blocks = opts.storageBlocks ?? 0;
  s.billing.push({
    ...defaultBilling(ACCOUNT_A, "plus", clock.now()),
    planSource: "stripe",
    extraMailboxes: extra,
    periodPaidExtraMailboxes: extra,
    storageBlocks: blocks,
    periodPaidStorageBlocks: blocks,
  });
  s.stepUps.push({ userId: "staff-billing", sessionId: SESSION.sessionId, expiresAt: new Date("2099-01-01") });
  return d;
}

const mailbox = (d: Deps, actor: Actor, local: string) =>
  createMailbox(
    d,
    actor,
    ACCOUNT_A,
    { localPart: local, domainId: DOMAIN_A, password: MAILBOX_PW, quotaGb: 1 },
    req,
    fakeHasher,
  );

describe("the mailbox ceiling follows the extra mailboxes in force (ADR-0029 §7)", () => {
  it("Plus with no extras: the included ten, then 403 plan_limit (as before billing)", async () => {
    const d = setup();
    for (let i = 0; i < MAX_MAILBOXES; i++) await mailbox(d, owner, `m${String(i)}`);
    await expect(mailbox(d, owner, "one-more")).rejects.toThrow(PlanLimitError);
    expect((await mailboxOptions(d, owner, ACCOUNT_A)).remaining).toBe(0);
  });

  it("with two extra mailboxes and a storage block: twelve mailboxes, and the pool grows by the block", async () => {
    const d = setup({ extraMailboxes: 2, storageBlocks: 1 });
    expect(await d.uow.run((r) => accountCeilingsOf(r, ACCOUNT_A))).toMatchObject({ mailboxes: 12, people: 12 });
    expect((await mailboxStoragePool(d, owner, ACCOUNT_A)).poolBytes).toBeGreaterThan(10 * 1024 ** 3);
    for (let i = 0; i < 12; i++) await mailbox(d, owner, `m${String(i)}`);
    await expect(mailbox(d, owner, "one-more")).rejects.toThrow(PlanLimitError);
    expect((await listPeople(d, owner, ACCOUNT_A)).limits.max).toBe(12);
  });

  it("extras count only in a paid state: a lapsed account is back to Free's one mailbox", async () => {
    const d = setup({ extraMailboxes: 5 });
    const b = d.uow.state.billing[0];
    if (b) Object.assign(b, { state: "lapsed", paidPlan: null, planSource: "none" });
    const a = d.uow.state.accounts[0];
    if (a) a.plan = "free";
    expect(await d.uow.run((r) => accountCeilingsOf(r, ACCOUNT_A))).toMatchObject({
      plan: "free",
      mailboxes: mailboxCeiling("free"),
      people: 1,
    });
  });
});

describe("the account address ceiling (ADR-0029 §7)", () => {
  it("counts mailboxes and both kinds of alias; refuses a mailbox with 409 address_ceiling, audited as denied", async () => {
    const d = setup({ ceiling: 3 });
    const first = await mailbox(d, owner, "one");
    await createAlias(
      d,
      owner,
      ACCOUNT_A,
      { kind: "alias", mailboxId: first.id, localPart: "hi", domainId: DOMAIN_A },
      req,
    );
    await createAlias(d, owner, ACCOUNT_A, { kind: "masked", mailboxId: first.id }, req);
    expect(await d.uow.run((r) => addressCeilingReached(d, r, ACCOUNT_A))).toBe(true);
    const refused = mailbox(d, owner, "two");
    await expect(refused).rejects.toThrow(BillingError);
    await expect(refused).rejects.toMatchObject({ code: "address_ceiling" });
    // The message never says the number (rule 33).
    await expect(refused).rejects.not.toThrow(/3/);
    expect(d.uow.state.mailboxes).toHaveLength(1);
    const denied = d.uow.state.audit.filter((e) => e.action === "mailbox.created" && e.result === "denied");
    expect(denied.map((e) => [e.errorCode, e.scope])).toContainEqual(["address_ceiling", `account:${ACCOUNT_A}`]);
  });

  it("refuses an alias with 409 address_ceiling, audited as denied, nothing created or counted", async () => {
    const d = setup({ ceiling: 1 });
    const only = await mailbox(d, owner, "one");
    const refused = createAlias(
      d,
      owner,
      ACCOUNT_A,
      { kind: "alias", mailboxId: only.id, localPart: "hi", domainId: DOMAIN_A },
      req,
    );
    await expect(refused).rejects.toMatchObject({ code: "address_ceiling" });
    expect(d.uow.state.aliases).toEqual([]);
    expect(d.uow.state.aliasCreations).toEqual([]);
    expect(
      d.uow.state.audit.some(
        (e) => e.action === "alias.created" && e.result === "denied" && e.errorCode === "address_ceiling",
      ),
    ).toBe(true);
  });

  it("holds for staff creating a platform address too", async () => {
    const d = setup({ ceiling: 1 });
    await mailbox(d, owner, "one");
    const ga = user({ id: "ga", platform: ["global_admin"] });
    await expect(staffCreatePlatformMailbox(d, ga, ACCOUNT_A, { localPart: "staffmade" }, req)).rejects.toMatchObject({
      code: "address_ceiling",
    });
  });

  it("defaults to the dev ceiling when none is configured; the staff override wins over the configured one", async () => {
    const d = setup();
    expect(DEV_ADDRESS_CEILING).toBeGreaterThan(MAX_MAILBOXES);
    expect(await d.uow.run((r) => addressCeilingReached(d, r, ACCOUNT_A, DEV_ADDRESS_CEILING))).toBe(false);
    expect(await d.uow.run((r) => addressCeilingReached(d, r, ACCOUNT_A, DEV_ADDRESS_CEILING + 1))).toBe(true);
    const tight = setup({ ceiling: 1 });
    await mailbox(tight, owner, "one");
    await setAddressCeilingOverride(tight, billingStaff, ACCOUNT_A, { ceiling: 2 }, SESSION, req);
    await mailbox(tight, owner, "two");
    await expect(mailbox(tight, owner, "three")).rejects.toMatchObject({ code: "address_ceiling" });
  });
});

describe("no new mailbox on what a downgrade held (SA60-01)", () => {
  it("a held custom domain refuses a mailbox, even before the sync moved the plan; Free refuses any custom domain", async () => {
    const d = setup();
    d.uow.state.planHolds.push({
      id: "h-d",
      accountId: ACCOUNT_A,
      subjectType: "domain",
      subjectId: DOMAIN_A,
      heldAt: new Date(0),
      receiveUntil: null,
    });
    await expect(mailbox(d, owner, "held")).rejects.toMatchObject({ code: "plan_limit" });
    d.uow.state.planHolds = [];
    const a = d.uow.state.accounts[0];
    if (a) a.plan = "free";
    await expect(mailbox(d, owner, "free")).rejects.toThrow(PlanLimitError);
    expect(d.uow.state.mailboxes).toEqual([]);
    const denied = d.uow.state.audit.filter((e) => e.action === "mailbox.created" && e.result === "denied");
    expect(denied.map((e) => e.errorCode)).toEqual(["plan_limit", "plan_limit"]);
  });
});

describe("setAddressCeilingOverride (staff, platform.billing.manage ★)", () => {
  it("sets and resets; audited by staff in the account's log without the number, with it in the platform copy", async () => {
    const d = setup();
    expect(await setAddressCeilingOverride(d, billingStaff, ACCOUNT_A, { ceiling: 9000 }, SESSION, req)).toEqual({
      ceiling: 9000,
    });
    expect(d.uow.state.billing[0]?.addressCeilingOverride).toBe(9000);
    expect(await setAddressCeilingOverride(d, billingStaff, ACCOUNT_A, { ceiling: null }, SESSION, req)).toEqual({
      ceiling: null,
    });
    const entries = d.uow.state.audit.filter((e) => e.action === "billing.ceiling_changed");
    const inAccount = entries.filter((e) => e.scope === `account:${ACCOUNT_A}`);
    expect(inAccount.map((e) => e.meta)).toEqual([{ override: "set" }, { override: "reset" }]);
    expect(inAccount.every((e) => e.actor.type === "staff" && e.result === "success")).toBe(true);
    expect(entries.filter((e) => e.scope === "platform").map((e) => e.meta)).toEqual([
      { accountId: ACCOUNT_A, from: null, set: 9000 },
      { accountId: ACCOUNT_A, from: 9000, set: null },
    ]);
  });

  it("403 without the permission (customer or support staff), 404 for an unknown account, both audited", async () => {
    const d = setup();
    await expect(setAddressCeilingOverride(d, owner, ACCOUNT_A, { ceiling: 10 }, SESSION, req)).rejects.toThrow(
      ForbiddenError,
    );
    await expect(setAddressCeilingOverride(d, supportStaff, ACCOUNT_A, { ceiling: 10 }, SESSION, req)).rejects.toThrow(
      ForbiddenError,
    );
    await expect(
      setAddressCeilingOverride(d, billingStaff, "99999999-9999-4999-8999-999999999999", { ceiling: 10 }, SESSION, req),
    ).rejects.toThrow(NotFoundError);
    await expect(setAddressCeilingOverride(d, billingStaff, "junk", { ceiling: 10 }, SESSION, req)).rejects.toThrow(
      NotFoundError,
    );
    const denied = d.uow.state.audit.filter((e) => e.action === "billing.ceiling_changed" && e.result === "denied");
    expect(denied.map((e) => e.errorCode)).toEqual(["forbidden", "forbidden", "not_found", "not_found"]);
    expect(d.uow.state.billing[0]?.addressCeilingOverride).toBeNull();
  });

  it("needs a fresh step-up; refused while acting as someone; 400 for a bad value", async () => {
    const d = setup();
    await expect(
      setAddressCeilingOverride(d, billingStaff, ACCOUNT_A, { ceiling: 10 }, { sessionId: "other" }, req),
    ).rejects.toThrow(StepUpRequiredError);
    await expect(
      setAddressCeilingOverride(d, actingStaff(ACCOUNT_A, "billing_admin"), ACCOUNT_A, { ceiling: 10 }, SESSION, req),
    ).rejects.toThrow(ForbiddenError);
    for (const bad of [0, -1, 1.5, "10", 1_000_001, undefined]) {
      await expect(
        setAddressCeilingOverride(d, billingStaff, ACCOUNT_A, { ceiling: bad }, SESSION, req),
      ).rejects.toThrow(ValidationError);
    }
    expect(d.uow.state.billing[0]?.addressCeilingOverride).toBeNull();
    expect(
      d.uow.state.audit
        .filter((e) => e.action === "billing.ceiling_changed" && e.result === "denied")
        .map((e) => e.errorCode),
      // Acting staff have their platform roles set aside (ADR-0023): refused at the permission check.
    ).toEqual(["step_up_required", "forbidden"]);
  });
});
