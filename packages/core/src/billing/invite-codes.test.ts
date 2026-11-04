// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  hashInviteCode,
  inviteCodePermission,
  inviteCodeSpecProblem,
  inviteCodeStatus,
  newInviteCode,
  normaliseCodeEmail,
  normaliseInviteCode,
  type InviteCodeSpec,
} from "./invite-codes";

const NOW = new Date("2026-11-04T00:00:00Z");
const DAY = 86_400_000;

describe("invite codes (ADR-0029 §8)", () => {
  it("a new code is 32 Crockford characters in groups of 4; only its sha256 is kept", () => {
    const { code, codeHash } = newInviteCode();
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
    const canonical = code.replaceAll("-", "");
    expect(codeHash).toBe(createHash("sha256").update(canonical).digest("hex"));
    expect(newInviteCode().code).not.toBe(code);
  });

  it("encodes the random bytes exactly (all zeros, all ones)", () => {
    expect(newInviteCode((n) => new Uint8Array(n)).code).toBe("0000-0000-0000-0000-0000-0000-0000-0000");
    expect(newInviteCode((n) => new Uint8Array(n).fill(255)).code).toBe("ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ");
  });

  it("normalises what someone typed: case, spaces, dashes and look-alikes", () => {
    const { code } = newInviteCode();
    const canonical = code.replaceAll("-", "");
    expect(normaliseInviteCode(code.toLowerCase())).toBe(canonical);
    expect(normaliseInviteCode(` ${code.replaceAll("-", " ")} `)).toBe(canonical);
    expect(normaliseInviteCode("ILO0".repeat(8))).toBe("1100".repeat(8));
    expect(hashInviteCode(normaliseInviteCode(code) ?? "")).toBe(hashInviteCode(canonical));
  });

  it.each([["short"], ["U".repeat(32)], ["!".repeat(32)], ["A".repeat(65)], [42], [null]])(
    "rejects %j (answered like any wrong code)",
    (input) => {
      expect(normaliseInviteCode(input)).toBeNull();
    },
  );

  it("status: redeemed, revoked, expired or active", () => {
    const c = { redeemedAt: null, revokedAt: null, expiresAt: new Date(NOW.getTime() + DAY) };
    expect(inviteCodeStatus(c, NOW)).toBe("active");
    expect(inviteCodeStatus({ ...c, expiresAt: NOW }, NOW)).toBe("expired");
    expect(inviteCodeStatus({ ...c, revokedAt: NOW }, NOW)).toBe("revoked");
    expect(inviteCodeStatus({ ...c, redeemedAt: NOW, revokedAt: NOW }, NOW)).toBe("redeemed");
  });

  describe("spec", () => {
    const spec = (over: Partial<InviteCodeSpec> = {}): InviteCodeSpec => ({
      label: "Beta wave 1",
      grantsSignup: true,
      compPlan: null,
      compDays: null,
      email: null,
      expiresAt: new Date(NOW.getTime() + 30 * DAY),
      ...over,
    });

    it("accepts sign-up, comp, or both, with an expiry within 90 days", () => {
      expect(inviteCodeSpecProblem(spec(), NOW)).toBeNull();
      expect(inviteCodeSpecProblem(spec({ grantsSignup: false, compPlan: "plus", compDays: 365 }), NOW)).toBeNull();
      expect(
        inviteCodeSpecProblem(
          spec({ compPlan: "supporter", compDays: 1, email: "a@b.c", expiresAt: new Date(NOW.getTime() + 90 * DAY) }),
          NOW,
        ),
      ).toBeNull();
    });

    it.each([
      [{ grantsSignup: false }, /must grant/],
      [{ compPlan: "plus" as const }, /number of days/],
      [{ compDays: 10 }, /number of days/],
      [{ compPlan: "free" as never, compDays: 10 }, /Plus or Supporter/],
      [{ compPlan: "plus" as const, compDays: 0 }, /1 to 365/],
      [{ compPlan: "plus" as const, compDays: 366 }, /1 to 365/],
      [{ compPlan: "plus" as const, compDays: 1.5 }, /1 to 365/],
      [{ expiresAt: NOW }, /future/],
      [{ expiresAt: new Date(NOW.getTime() + 90 * DAY + 1) }, /within 90 days/],
      [{ label: "x".repeat(201) }, /under 200/],
      [{ email: "not-an-email" }, /email address/],
    ])("refuses %j", (over, problem) => {
      expect(inviteCodeSpecProblem(spec(over), NOW)).toMatch(problem);
    });

    it("comp codes need platform.billing.manage; sign-up-only codes platform.invites.manage", () => {
      expect(inviteCodePermission({ compPlan: null })).toBe("platform.invites.manage");
      expect(inviteCodePermission({ compPlan: "plus" })).toBe("platform.billing.manage");
    });

    it("bound emails are compared lower-cased and trimmed", () => {
      expect(normaliseCodeEmail("  Ana@Example.ORG ")).toBe("ana@example.org");
    });
  });
});
