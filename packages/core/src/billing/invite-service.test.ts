// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Invite codes as services (ADR-0029 §8; slice 12): who may create which kind (sign-up codes: Global and Support;
 * comp codes: Global and Billing, with a step-up), the code shown once and stored only as a hash, listing and revoking,
 * redeeming a comp code on the Billing page (Free or lapsed only, bound email, one redemption of concurrent ones), and
 * the sign-up check and redemption (closed sign-up needs a sign-up code). Every wrong code is the same 404.
 */
import { describe, expect, it } from "vitest";

import { ACCOUNT_A, ACCOUNT_B, actAs, deps as makeDeps, fixedClock, req, user } from "../__tests__/helpers";

import { defaultBilling } from "./lifecycle";
import {
  claimSignUpCode,
  completeSignUpCode,
  createInviteCode,
  listInviteCodes,
  parseInviteCodeInput,
  redeemInviteCode,
  releaseSignUpCode,
  revokeInviteCode,
} from "./invite-service";
import { hashInviteCode, normaliseInviteCode } from "./invite-codes";

const DAY = 86_400_000;
const SESSION = { sessionId: "staff-session" };
const global = user({ id: "staff-global", platform: ["global_admin"] });
const support = user({ id: "staff-support", platform: ["support_admin"] });
const billingStaff = user({ id: "staff-billing", platform: ["billing_admin"] });
const trust = user({ id: "staff-trust", platform: ["trust_safety_admin"] });
const owner = user({ id: "owner-1", account: [[ACCOUNT_A, "owner"]] });
const billingAdmin = user({ id: "billing-1", account: [[ACCOUNT_A, "billing_admin"]] });
const member = user({ id: "member-1", account: [[ACCOUNT_A, "member"]] });
const outsider = user({ id: "outsider-1", account: [[ACCOUNT_B, "owner"]] });

function world() {
  const clock = fixedClock("2026-11-05T10:00:00Z");
  const d = makeDeps(clock);
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "Acme", plan: "free" }, { id: ACCOUNT_B, name: "Other", plan: "free" });
  for (const u of [global, support, billingStaff, owner, billingAdmin]) s.userEmails[u.userId] = u.email;
  for (const id of [global.userId, billingStaff.userId]) {
    s.stepUps.push({ userId: id, sessionId: SESSION.sessionId, expiresAt: new Date("2099-01-01") });
  }
  const platformLog = (action: string) => s.audit.filter((e) => e.action === action && e.scope === "platform");
  const accountLog = (action: string) =>
    s.audit.filter((e) => e.action === action && e.scope === `account:${ACCOUNT_A}`);
  const row = () => d.uow.run((r) => r.billing.get(ACCOUNT_A));
  return { clock, d, s, platformLog, accountLog, row };
}

const comp = { compPlan: "plus", compDays: 30, expiresInDays: 30 } as const;
const signup = { grantsSignup: true, expiresInDays: 14 } as const;

describe("parseInviteCodeInput", () => {
  const now = new Date("2026-11-05T10:00:00Z");
  it("reads a code to create, normalising the bound email", () => {
    expect(parseInviteCodeInput({ ...comp, label: " Beta ", email: " Pat@Example.TEST " }, now)).toMatchObject({
      label: "Beta",
      grantsSignup: false,
      compPlan: "plus",
      compDays: 30,
      email: "pat@example.test",
      expiresAt: new Date(now.getTime() + 30 * DAY),
    });
  });
  it.each([
    [{ expiresInDays: 30 }, "A code must grant"],
    [{ ...signup, expiresInDays: 91 }, "within 1 to 90 days"],
    [{ ...signup, expiresInDays: undefined }, "within 1 to 90 days"],
    [{ ...comp, compPlan: "free" }, "Comp Plus or Supporter."],
    [{ ...comp, compDays: 400 }, "Comp from 1 to 365 days."],
    [{ ...signup, label: "x".repeat(201) }, "Keep the note under"],
    [{ ...signup, email: "nope" }, "Bind the code to an email address."],
  ])("refuses %j", (input, message) => {
    expect(() => parseInviteCodeInput(input, now)).toThrow(message);
  });
});

describe("createInviteCode / listInviteCodes / revokeInviteCode", () => {
  it("Support creates sign-up codes (no step-up); the code is shown once and only its hash is stored", async () => {
    const w = world();
    const out = await createInviteCode(w.d, support, { ...signup, label: "Wave 1" }, { sessionId: null }, req);
    expect(out.code).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
    expect(w.s.inviteCodes[0]?.codeHash).toBe(hashInviteCode(normaliseInviteCode(out.code) ?? ""));
    expect(JSON.stringify(out.invite)).not.toContain(w.s.inviteCodes[0]?.codeHash ?? "x");
    const entry = w.platformLog("platform.invite_code_created")[0];
    expect(entry?.meta).toMatchObject({ grantsSignup: true, compPlan: null, compDays: null, bound: false });
    expect(Object.keys(entry?.meta ?? {}).sort()).toEqual([
      "bound",
      "compDays",
      "compPlan",
      "expiresAt",
      "grantsSignup",
    ]);
    expect(JSON.stringify(w.s.audit)).not.toContain(out.code);
  });

  it("comp codes need platform.billing.manage and a fresh step-up", async () => {
    const w = world();
    await expect(createInviteCode(w.d, support, comp, { sessionId: null }, req)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(createInviteCode(w.d, billingStaff, comp, { sessionId: "stale" }, req)).rejects.toMatchObject({
      code: "step_up_required",
    });
    await expect(createInviteCode(w.d, billingStaff, comp, SESSION, req)).resolves.toHaveProperty("code");
    await expect(createInviteCode(w.d, billingStaff, signup, SESSION, req)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(createInviteCode(w.d, global, { ...comp, grantsSignup: true }, SESSION, req)).resolves.toHaveProperty(
      "code",
    );
  });

  it("customers and staff without either permission can't create or list codes", async () => {
    const w = world();
    await expect(createInviteCode(w.d, owner, signup, SESSION, req)).rejects.toMatchObject({ code: "forbidden" });
    await expect(createInviteCode(w.d, trust, signup, SESSION, req)).rejects.toMatchObject({ code: "forbidden" });
    await expect(listInviteCodes(w.d, trust)).rejects.toMatchObject({ code: "forbidden" });
    await expect(listInviteCodes(w.d, owner)).rejects.toMatchObject({ code: "forbidden" });
    await expect(listInviteCodes(w.d, { ...support, actingAs: actAs(ACCOUNT_A) })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("lists codes with their status and revokes an unused one once; comp codes need billing staff to revoke", async () => {
    const w = world();
    const a = await createInviteCode(w.d, support, signup, { sessionId: null }, req);
    const b = await createInviteCode(w.d, billingStaff, comp, SESSION, req);
    expect((await listInviteCodes(w.d, billingStaff)).map((c) => c.status)).toEqual(["active", "active"]);
    await expect(revokeInviteCode(w.d, support, b.invite.id, req)).rejects.toMatchObject({ code: "forbidden" });
    await expect(revokeInviteCode(w.d, support, a.invite.id, req)).resolves.toEqual({ revoked: true });
    await expect(revokeInviteCode(w.d, support, a.invite.id, req)).rejects.toMatchObject({ code: "conflict" });
    await expect(revokeInviteCode(w.d, support, "44444444-4444-4444-8444-444444444444", req)).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await listInviteCodes(w.d, support)).find((c) => c.id === a.invite.id)?.status).toBe("revoked");
    w.clock.set(new Date(w.clock.now().getTime() + 31 * DAY));
    expect((await listInviteCodes(w.d, support)).find((c) => c.id === b.invite.id)?.status).toBe("expired");
  });
});

describe("redeemInviteCode (Billing page)", () => {
  it("an Owner redeems a comp code on Free: the plan starts at once, audited in the account's and platform logs", async () => {
    const w = world();
    const { code } = await createInviteCode(w.d, billingStaff, comp, SESSION, req);
    const out = await redeemInviteCode(w.d, owner, ACCOUNT_A, { code: code.toLowerCase() }, req);
    expect(out.plan).toBe("plus");
    expect(out.until.getTime()).toBe(w.clock.now().getTime() + 30 * DAY);
    expect(await w.row()).toMatchObject({ state: "active", planSource: "comp", paidPlan: "plus" });
    expect(w.accountLog("billing.comp_redeemed")[0]).toMatchObject({
      result: "success",
      meta: { plan: "plus", days: 30 },
    });
    expect(w.platformLog("platform.invite_code_redeemed")[0]?.meta).toMatchObject({ accountId: ACCOUNT_A });
    expect(JSON.stringify(w.s.audit)).not.toContain(code);
    // Used: the same answer as any wrong code.
    await expect(redeemInviteCode(w.d, owner, ACCOUNT_B, { code }, req)).rejects.toMatchObject({ code: "not_found" });
  });

  it("every wrong code is the same 404: unknown, malformed, sign-up-only, expired, revoked, bound elsewhere", async () => {
    const w = world();
    const signupOnly = await createInviteCode(w.d, support, signup, { sessionId: null }, req);
    const bound = await createInviteCode(w.d, billingStaff, { ...comp, email: "someone@else.test" }, SESSION, req);
    const revoked = await createInviteCode(w.d, billingStaff, comp, SESSION, req);
    await revokeInviteCode(w.d, billingStaff, revoked.invite.id, req);
    const codes = ["0000-0000-0000-0000-0000-0000-0000-0000", "nope", signupOnly.code, bound.code, revoked.code];
    for (const code of codes) {
      await expect(redeemInviteCode(w.d, owner, ACCOUNT_A, { code }, req)).rejects.toMatchObject({
        code: "invite_code_invalid",
        message: "That code isn't valid. Check it, or ask whoever sent it.",
      });
    }
    const expiring = await createInviteCode(w.d, billingStaff, { ...comp, expiresInDays: 1 }, SESSION, req);
    w.clock.set(new Date(w.clock.now().getTime() + 2 * DAY));
    await expect(redeemInviteCode(w.d, owner, ACCOUNT_A, { code: expiring.code }, req)).rejects.toMatchObject({
      code: "invite_code_invalid",
    });
    expect(w.accountLog("billing.comp_redeemed").every((e) => e.result === "denied")).toBe(true);
    expect(await w.row()).toBeNull();
  });

  it("only on Free or lapsed, with a confirmed email, by billing managers in the account, never while acting", async () => {
    const w = world();
    const { code } = await createInviteCode(w.d, billingStaff, comp, SESSION, req);
    await expect(redeemInviteCode(w.d, member, ACCOUNT_A, { code }, req)).rejects.toMatchObject({ code: "forbidden" });
    await expect(redeemInviteCode(w.d, outsider, ACCOUNT_A, { code }, req)).rejects.toMatchObject({
      code: "not_found",
    });
    const acting = { ...billingAdmin, actingAs: actAs(ACCOUNT_A) };
    await expect(redeemInviteCode(w.d, acting, ACCOUNT_A, { code }, req)).rejects.toMatchObject({ code: "forbidden" });
    w.s.unverifiedEmails.push(billingAdmin.userId);
    await expect(redeemInviteCode(w.d, billingAdmin, ACCOUNT_A, { code }, req)).rejects.toMatchObject({
      code: "email_unverified",
    });
    w.s.billing.push({ ...defaultBilling(ACCOUNT_A, "plus", w.clock.now()), planSource: "stripe" });
    await expect(redeemInviteCode(w.d, owner, ACCOUNT_A, { code }, req)).rejects.toMatchObject({
      code: "already_subscribed",
    });
    // Nothing was claimed by the refusals.
    expect((await listInviteCodes(w.d, billingStaff))[0]?.status).toBe("active");
  });

  it("a bound code works for its own email", async () => {
    const w = world();
    const { code } = await createInviteCode(
      w.d,
      billingStaff,
      { ...comp, email: owner.email.toUpperCase() },
      SESSION,
      req,
    );
    await expect(redeemInviteCode(w.d, owner, ACCOUNT_A, { code }, req)).resolves.toMatchObject({ plan: "plus" });
  });
});

describe("sign-up codes (run-67 N1, N2)", () => {
  const email = "new@person.test";

  it("the claim is the admission: closed sign-up takes only a sign-up code; open takes any redeemable one", async () => {
    const w = world();
    const s = await createInviteCode(w.d, support, signup, { sessionId: null }, req);
    const c = await createInviteCode(w.d, billingStaff, comp, SESSION, req);
    expect(await claimSignUpCode(w.d, { code: c.code, email }, { signUpOpen: false }, req)).toBeNull();
    expect(await claimSignUpCode(w.d, { code: s.code, email }, { signUpOpen: false }, req)).toEqual({
      codeId: s.invite.id,
    });
    // Claimed: a second sign-up with it is refused.
    expect(await claimSignUpCode(w.d, { code: s.code, email }, { signUpOpen: true }, req)).toBeNull();
    expect(await claimSignUpCode(w.d, { code: c.code, email }, { signUpOpen: true }, req)).not.toBeNull();
    expect(await claimSignUpCode(w.d, { code: "garbage", email }, { signUpOpen: true }, req)).toBeNull();
    expect(w.platformLog("platform.invite_code_redeemed").map((e) => e.result)).toEqual([
      "denied",
      "success",
      "denied",
      "success",
    ]);
  });

  it("a concurrent Billing redemption and a sign-up: exactly one wins", async () => {
    const w = world();
    const { code } = await createInviteCode(w.d, global, { ...comp, grantsSignup: true }, SESSION, req);
    const results = await Promise.allSettled([
      redeemInviteCode(w.d, owner, ACCOUNT_A, { code }, req),
      claimSignUpCode(w.d, { code, email }, { signUpOpen: false }, req),
    ]);
    const billingWon = results[0].status === "fulfilled";
    const signUpWon = results[1].status === "fulfilled" && results[1].value !== null;
    expect([billingWon, signUpWon].filter(Boolean)).toHaveLength(1);
  });

  it("a code revoked before the sign-up admits no one", async () => {
    const w = world();
    const s = await createInviteCode(w.d, support, signup, { sessionId: null }, req);
    await revokeInviteCode(w.d, support, s.invite.id, req);
    expect(await claimSignUpCode(w.d, { code: s.code, email }, { signUpOpen: false }, req)).toBeNull();
  });

  it("a failed sign-up gives the code back: it is redeemable again", async () => {
    const w = world();
    const s = await createInviteCode(w.d, support, signup, { sessionId: null }, req);
    const claim = await claimSignUpCode(w.d, { code: s.code, email }, { signUpOpen: false }, req);
    if (!claim) throw new Error("not claimed");
    expect(await releaseSignUpCode(w.d, claim, req)).toBe(true);
    expect(await releaseSignUpCode(w.d, claim, req)).toBe(false);
    expect(w.platformLog("platform.invite_code_released")[0]).toMatchObject({ result: "success" });
    expect(await claimSignUpCode(w.d, { code: s.code, email }, { signUpOpen: false }, req)).not.toBeNull();
  });

  it("after the account exists: attaches the person and account and applies an unbound comp once", async () => {
    const w = world();
    w.s.userEmails["new-user"] = email;
    const { code } = await createInviteCode(w.d, global, { ...comp, grantsSignup: true }, SESSION, req);
    const claim = await claimSignUpCode(w.d, { code, email }, { signUpOpen: false }, req);
    if (!claim) throw new Error("not claimed");
    const done = await completeSignUpCode(w.d, { ...claim, userId: "new-user", accountId: ACCOUNT_A }, req);
    expect(done).toMatchObject({ attached: true, comp: { plan: "plus" } });
    expect(await w.row()).toMatchObject({ state: "active", planSource: "comp" });
    expect(w.accountLog("billing.comp_redeemed")).toHaveLength(1);
    expect(w.s.inviteCodes[0]).toMatchObject({ redeemedBy: "new-user", redeemedAccountId: ACCOUNT_A });
    // Once only; and attached claims can't be given back.
    expect(await completeSignUpCode(w.d, { ...claim, userId: "new-user", accountId: ACCOUNT_A }, req)).toEqual({
      attached: false,
      comp: null,
    });
    expect(await releaseSignUpCode(w.d, claim, req)).toBe(false);
  });

  it("N2: a bound code with a plan is never claimed at sign-up, and can't be made to open sign-up too", async () => {
    const w = world();
    const bound = await createInviteCode(w.d, billingStaff, { ...comp, email }, SESSION, req);
    expect(await claimSignUpCode(w.d, { code: bound.code, email }, { signUpOpen: true }, req)).toBeNull();
    await expect(
      createInviteCode(w.d, global, { ...comp, grantsSignup: true, email }, SESSION, req),
    ).rejects.toMatchObject({ code: "bad_request" });
    // A bound sign-up code admits its own email only.
    const s = await createInviteCode(w.d, support, { ...signup, email: "X@Y.test" }, { sessionId: null }, req);
    expect(await claimSignUpCode(w.d, { code: s.code, email }, { signUpOpen: false }, req)).toBeNull();
    expect(await claimSignUpCode(w.d, { code: s.code, email: "x@y.test" }, { signUpOpen: false }, req)).not.toBeNull();
  });
});
