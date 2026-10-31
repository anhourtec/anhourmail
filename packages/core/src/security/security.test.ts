// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ACCOUNT_A, ACCOUNT_B, anonymous, deps, fixedClock, req, user } from "../__tests__/helpers";
import type { UserActor } from "../actor";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  StepUpRequiredError,
  UnauthenticatedError,
  ValidationError,
} from "../errors";
import {
  describeDevice,
  missingAfterRemoving,
  missingFactor,
  passkeyName,
  sessionRefusal,
  strictestPolicy,
} from "./rules";
import {
  factorRemovalRefusal,
  getSecurityOverview,
  recordSecurityEvent,
  afterPasswordChange,
  endSessionForRequirement,
  noteFactorAdded,
  notePasskeysRemoved,
  removePasskey,
  sessionRefusalFor,
  renamePasskey,
  requiredEnrolment,
  revokeOtherSessions,
  revokeSession,
  setSignInPolicy,
} from "./service";

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";

const NOW = new Date("2026-10-21T12:00:00Z");
const later = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

/** Account A (owner Sam, member Kim), account B (owner Lee). Sam has two sessions, a passkey and two-factor on. */
function world() {
  const d = deps(fixedClock(NOW.toISOString()));
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "Family A", plan: "plus" }, { id: ACCOUNT_B, name: "Family B", plan: "plus" });
  s.memberships.push(
    { userId: "sam", accountId: ACCOUNT_A, role: "owner" },
    { userId: "kim", accountId: ACCOUNT_A, role: "member" },
    { userId: "lee", accountId: ACCOUNT_B, role: "owner" },
  );
  s.sessions.push(
    {
      userId: "sam",
      id: "s-here",
      createdAt: NOW,
      lastActiveAt: NOW,
      expiresAt: later(7),
      ip: "203.0.113.7",
      userAgent: CHROME_MAC,
    },
    {
      userId: "sam",
      id: "s-phone",
      createdAt: NOW,
      lastActiveAt: later(-1),
      expiresAt: later(3),
      ip: "2001:db8:1:2::9",
      userAgent: FIREFOX_LINUX,
    },
    {
      userId: "sam",
      id: "s-old",
      createdAt: later(-9),
      lastActiveAt: later(-9),
      expiresAt: later(-2),
      ip: null,
      userAgent: null,
    },
    { userId: "lee", id: "s-lee", createdAt: NOW, lastActiveAt: NOW, expiresAt: later(7), ip: null, userAgent: null },
  );
  s.passkeys.push({
    userId: "sam",
    id: "pk-1",
    name: "Laptop",
    createdAt: NOW,
    deviceType: "multiDevice",
    backedUp: true,
    aaguid: null,
  });
  s.passkeys.push({
    userId: "lee",
    id: "pk-lee",
    name: "Key",
    createdAt: NOW,
    deviceType: "singleDevice",
    backedUp: false,
    aaguid: null,
  });
  s.twoFactor.push({ userId: "sam", verified: true, recoveryCodesLeft: 2 });
  s.trustedDevices.push({ userId: "sam", id: "t1" }, { userId: "lee", id: "t2" });
  // Both confirmed it's them a moment ago in these console sessions (step-up, ADR-0028).
  const fresh = new Date(NOW.getTime() + 5 * 60_000);
  s.stepUps.push(
    { userId: "sam", sessionId: "s-step", expiresAt: fresh },
    { userId: "lee", sessionId: "s-step", expiresAt: fresh },
    { userId: "sam", sessionId: "s-here", expiresAt: fresh },
  );
  const as = (id: string): UserActor => {
    const u = user({
      id,
      account: s.memberships
        .filter((m) => m.userId === id)
        .map((m) => [m.accountId, m.role] as [string, typeof m.role]),
    });
    // Signed in with the password and a passkey unless a test says otherwise.
    return { ...u, email: `${id}@example.test`, signInMethod: "password+passkey" };
  };
  return { d, s, as };
}

describe("rules", () => {
  it("the strictest policy wins across accounts", () => {
    expect(strictestPolicy([])).toBe("none");
    expect(
      strictestPolicy([
        { accountId: "a", policy: "two_factor" },
        { accountId: "b", policy: "none" },
      ]),
    ).toBe("two_factor");
    expect(
      strictestPolicy([
        { accountId: "a", policy: "passkey" },
        { accountId: "b", policy: "two_factor" },
      ]),
    ).toBe("passkey");
  });

  it("a passkey meets two-factor; only a passkey meets passkey", () => {
    const none = { totp: false, passkeys: 0, recoveryCodesLeft: 0 };
    expect(missingFactor("none", none)).toBeNull();
    expect(missingFactor("two_factor", none)).toBe("two_factor");
    expect(missingFactor("two_factor", { ...none, totp: true })).toBeNull();
    expect(missingFactor("two_factor", { ...none, passkeys: 1 })).toBeNull();
    expect(missingFactor("passkey", { ...none, totp: true })).toBe("passkey");
    expect(missingFactor("passkey", { ...none, passkeys: 2 })).toBeNull();
  });

  it("knows what removing a factor would break", () => {
    const both = { totp: true, passkeys: 1, recoveryCodesLeft: 10 };
    expect(missingAfterRemoving("two_factor", both, "totp")).toBeNull();
    expect(missingAfterRemoving("two_factor", { ...both, passkeys: 0 }, "totp")).toBe("two_factor");
    expect(missingAfterRemoving("passkey", both, "passkey")).toBe("passkey");
    expect(missingAfterRemoving("passkey", { ...both, passkeys: 2 }, "passkey")).toBeNull();
    expect(missingAfterRemoving("none", { ...both, passkeys: 0 }, "passkey")).toBeNull();
  });

  it("cleans passkey names and refuses junk", () => {
    expect(passkeyName("  Work   laptop ")).toBe("Work laptop");
    for (const bad of [42, "", "   ", "x".repeat(61), "bad\u0007name"]) {
      expect(() => passkeyName(bad)).toThrow(ValidationError);
    }
  });

  it("summarises user agents without versions", () => {
    expect(describeDevice(CHROME_MAC)).toBe("Chrome on macOS");
    expect(describeDevice(FIREFOX_LINUX)).toBe("Firefox on Linux");
    expect(
      describeDevice(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari on iOS");
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0 Safari/537.36 Edg/141.0")).toBe(
      "Edge on Windows",
    );
    expect(describeDevice("curl/8.0")).toBe("Unknown device");
    expect(describeDevice("Mozilla/5.0 (Linux; Android 15)")).toBe("Android");
    expect(describeDevice(null)).toBe("Unknown device");
  });
});

describe("getSecurityOverview", () => {
  it("shows the person's own factors, live sessions (current first), activity and requirements", async () => {
    const { d, s, as } = world();
    s.accounts[0] = { ...s.accounts[0], id: ACCOUNT_A, name: "Family A", plan: "plus", signInPolicy: "two_factor" };
    await recordSecurityEvent(
      d,
      { action: "auth.sign_in", userId: "sam", email: "sam@example.test", by: "self", meta: { method: "passkey" } },
      { ...req, userAgent: FIREFOX_LINUX },
    );
    await recordSecurityEvent(d, { action: "auth.sign_in", userId: "lee", email: "lee@example.test", by: "self" }, req);
    const out = await getSecurityOverview(d, as("sam"), { currentSessionId: "s-phone" });
    expect(out.factors).toEqual({ totp: true, passkeys: 1, recoveryCodesLeft: 2 });
    expect(out.passkeys.map((p) => p.id)).toEqual(["pk-1"]);
    expect(out.sessions.map((x) => [x.id, x.current])).toEqual([
      ["s-phone", true],
      ["s-here", false],
    ]);
    expect(out.sessions[0]).toMatchObject({ device: "Firefox on Linux", network: "2001:db8:1::/48" });
    // Never the full address or user agent.
    for (const x of out.sessions) {
      expect(x).not.toHaveProperty("ip");
      expect(x).not.toHaveProperty("userAgent");
    }
    expect(out.passwordResetAt).toBeNull();
    expect(out.sessions[1]).toMatchObject({ device: "Chrome on macOS", network: "203.0.113.x" });
    expect(out.activity).toHaveLength(1);
    expect(out.activity[0]).toMatchObject({
      action: "auth.sign_in",
      label: "Signed in",
      method: "passkey",
      device: "Firefox on Linux",
      network: "203.0.113.x",
      byStaff: false,
    });
    expect(out.requirement).toEqual({
      policy: "two_factor",
      accounts: [{ id: ACCOUNT_A, name: "Family A", policy: "two_factor" }],
      missing: null,
    });
    expect(out.manageable).toEqual([{ id: ACCOUNT_A, name: "Family A", policy: "two_factor" }]);
    // A member sees the requirement but can't change it.
    const kim = await getSecurityOverview(d, as("kim"), { currentSessionId: null });
    expect(kim.requirement.missing).toBe("two_factor");
    expect(kim.manageable).toEqual([]);
  });

  it("needs a signed-in, unsuspended person", async () => {
    const { d } = world();
    await expect(getSecurityOverview(d, anonymous, { currentSessionId: null })).rejects.toThrow(UnauthenticatedError);
    await expect(getSecurityOverview(d, user({ suspended: true }), { currentSessionId: null })).rejects.toThrow(
      ForbiddenError,
    );
    await expect(getSecurityOverview(d, { kind: "system", name: "job" }, { currentSessionId: null })).rejects.toThrow(
      ValidationError,
    );
  });
});

describe("sessions", () => {
  it("signs out one of the person's other sessions, audited without the token", async () => {
    const { d, s, as } = world();
    await revokeSession(d, as("sam"), { sessionId: "s-phone", currentSessionId: "s-here" }, req);
    expect(s.sessions.map((x) => x.id)).toEqual(["s-here", "s-old", "s-lee"]);
    const [entry] = s.audit.filter((e) => e.action === "auth.session_revoked");
    expect(entry).toMatchObject({
      result: "success",
      scope: "platform",
      target: { type: "user", id: "sam" },
      meta: { device: "Firefox on Linux", network: "2001:db8:1::/48" },
    });
  });

  it("someone else's session is a 404 (and nothing is deleted); the current one says to use Sign out", async () => {
    const { d, s, as } = world();
    await expect(revokeSession(d, as("sam"), { sessionId: "s-lee", currentSessionId: "s-here" }, req)).rejects.toThrow(
      NotFoundError,
    );
    await expect(revokeSession(d, as("sam"), { sessionId: "s-here", currentSessionId: "s-here" }, req)).rejects.toThrow(
      ValidationError,
    );
    expect(s.sessions).toHaveLength(4);
    expect(s.audit.filter((e) => e.action === "auth.session_revoked").map((e) => e.result)).toEqual([
      "failed",
      "failed",
    ]);
  });

  it("signs out everywhere else and forgets trusted devices (only the person's)", async () => {
    const { d, s, as } = world();
    const out = await revokeOtherSessions(d, as("sam"), { currentSessionId: "s-here" }, req);
    expect(out).toEqual({ sessions: 2, trustedDevices: 1, passkeysRemoved: 0 });
    expect(s.sessions.map((x) => x.id)).toEqual(["s-here", "s-lee"]);
    expect(s.trustedDevices).toEqual([{ userId: "lee", id: "t2" }]);
    expect(s.audit.at(-1)).toMatchObject({ action: "auth.sessions_revoked_all", meta: { sessions: 2 } });
  });

  it("refuses signed-out and suspended callers, audited as denied", async () => {
    const { d, s } = world();
    await expect(revokeOtherSessions(d, anonymous, { currentSessionId: "x" }, req)).rejects.toThrow(
      UnauthenticatedError,
    );
    await expect(
      revokeSession(d, user({ id: "sam", suspended: true }), { sessionId: "s-phone", currentSessionId: null }, req),
    ).rejects.toThrow(ForbiddenError);
    expect(s.sessions).toHaveLength(4);
    expect(s.audit.map((e) => e.result)).toEqual(["denied", "denied"]);
  });
});

describe("passkeys", () => {
  it("renames one of the person's passkeys", async () => {
    const { d, s, as } = world();
    const p = await renamePasskey(d, as("sam"), { passkeyId: "pk-1", name: " Phone " }, req);
    expect(p.name).toBe("Phone");
    expect(s.audit.at(-1)).toMatchObject({
      action: "auth.passkey_renamed",
      meta: { previousName: "Laptop", newName: "Phone" },
    });
  });

  it("someone else's passkey is a 404; a bad name is a 400", async () => {
    const { d, s, as } = world();
    await expect(renamePasskey(d, as("sam"), { passkeyId: "pk-lee", name: "Mine" }, req)).rejects.toThrow(
      NotFoundError,
    );
    await expect(removePasskey(d, as("sam"), { passkeyId: "pk-lee", sessionId: "s-step" }, req)).rejects.toThrow(
      NotFoundError,
    );
    await expect(renamePasskey(d, as("sam"), { passkeyId: "pk-1", name: "" }, req)).rejects.toThrow(ValidationError);
    expect(s.passkeys.find((p) => p.id === "pk-lee")?.name).toBe("Key");
  });

  it("removes a passkey unless an account requirement depends on it", async () => {
    const { d, s, as } = world();
    s.accounts[0] = { id: ACCOUNT_A, name: "Family A", plan: "plus", signInPolicy: "passkey" };
    await expect(removePasskey(d, as("sam"), { passkeyId: "pk-1", sessionId: "s-step" }, req)).rejects.toThrow(
      ConflictError,
    );
    expect(s.passkeys.some((p) => p.id === "pk-1")).toBe(true);
    // Two-factor is still met by the authenticator app.
    s.accounts[0] = { id: ACCOUNT_A, name: "Family A", plan: "plus", signInPolicy: "two_factor" };
    expect(await removePasskey(d, as("sam"), { passkeyId: "pk-1", sessionId: "s-step" }, req)).toEqual({
      passkeysLeft: 0,
    });
    expect(s.passkeys.some((p) => p.id === "pk-1")).toBe(false);
    expect(s.audit.at(-1)).toMatchObject({ action: "auth.passkey_removed", meta: { passkeyName: "Laptop" } });
    // Sam keeps the authenticator app: trusted browsers stay.
    expect(s.trustedDevices.some((t) => t.userId === "sam")).toBe(true);
  });

  it("removing a passkey needs a fresh step-up of this session; a stolen session without one is refused", async () => {
    const { d, s, as } = world();
    for (const sessionId of [null, "s-stolen"]) {
      await expect(removePasskey(d, as("sam"), { passkeyId: "pk-1", sessionId }, req)).rejects.toThrow(
        StepUpRequiredError,
      );
    }
    expect(s.passkeys.some((p) => p.id === "pk-1")).toBe(true);
    expect(s.audit.at(-1)).toMatchObject({ action: "auth.passkey_removed", result: "denied" });
    s.stepUps = [];
    await expect(
      revokeOtherSessions(d, as("sam"), { currentSessionId: "s-here", removePasskeys: true }, req),
    ).rejects.toThrow(StepUpRequiredError);
    expect(s.passkeys.some((p) => p.userId === "sam")).toBe(true);
    // Signing the others out alone needs none.
    expect((await revokeOtherSessions(d, as("sam"), { currentSessionId: "s-here" }, req)).passkeysRemoved).toBe(0);
  });

  it("removing the last second factor forgets every trusted browser (ADR-0028)", async () => {
    const { d, s, as } = world();
    // Lee's only passkey: none left, so the route announces it (`notePasskeysRemoved` via "single").
    expect(await removePasskey(d, as("lee"), { passkeyId: "pk-lee", sessionId: "s-step" }, req)).toEqual({
      passkeysLeft: 0,
    });
    expect(s.trustedDevices.some((t) => t.userId === "lee")).toBe(false);
    expect(s.trustedDevices.some((t) => t.userId === "sam")).toBe(true);
    expect(s.audit.at(-1)).toMatchObject({
      action: "auth.passkey_removed",
      meta: { passkeyId: "pk-lee", trustedDevicesForgotten: 1 },
    });
  });
});

describe("account sign-in requirement", () => {
  it("an Owner who meets it sets it; audited in the account with before and after", async () => {
    const { d, s, as } = world();
    expect(await setSignInPolicy(d, as("sam"), { accountId: ACCOUNT_A, policy: "passkey" }, req)).toEqual({
      policy: "passkey",
    });
    expect(s.accounts[0]?.signInPolicy).toBe("passkey");
    expect(s.audit.at(-1)).toMatchObject({
      scope: `account:${ACCOUNT_A}`,
      action: "account.sign_in_policy_changed",
      target: { type: "account", id: ACCOUNT_A, label: "Family A" },
      meta: { previousPolicy: "none", newPolicy: "passkey" },
    });
  });

  it("an Owner must meet the requirement first (409)", async () => {
    const { d, s, as } = world();
    // Without Lee's security key, neither requirement is met.
    s.passkeys = s.passkeys.filter((p) => p.userId !== "lee");
    await expect(setSignInPolicy(d, as("lee"), { accountId: ACCOUNT_B, policy: "two_factor" }, req)).rejects.toThrow(
      /for yourself first/,
    );
    await expect(setSignInPolicy(d, as("lee"), { accountId: ACCOUNT_B, policy: "passkey" }, req)).rejects.toThrow(
      ConflictError,
    );
    expect(s.accounts[1]?.signInPolicy).toBeUndefined();
    // Sam has two-factor on but no passkey once it's gone: two-factor is fine, a passkey requirement isn't.
    s.passkeys = s.passkeys.filter((p) => p.userId !== "sam");
    await setSignInPolicy(d, as("sam"), { accountId: ACCOUNT_A, policy: "two_factor" }, req);
    await expect(setSignInPolicy(d, as("sam"), { accountId: ACCOUNT_A, policy: "passkey" }, req)).rejects.toThrow(
      /Add a passkey/,
    );
  });

  it("members get 403, other accounts 404, junk 400 — all audited", async () => {
    const { d, s, as } = world();
    await expect(setSignInPolicy(d, as("kim"), { accountId: ACCOUNT_A, policy: "none" }, req)).rejects.toThrow(
      ForbiddenError,
    );
    await expect(setSignInPolicy(d, as("sam"), { accountId: ACCOUNT_B, policy: "none" }, req)).rejects.toThrow(
      NotFoundError,
    );
    await expect(setSignInPolicy(d, as("sam"), { accountId: ACCOUNT_A, policy: "sms" }, req)).rejects.toThrow(
      ValidationError,
    );
    expect(s.audit.map((e) => [e.scope, e.result])).toEqual([
      [`account:${ACCOUNT_A}`, "denied"],
      ["platform", "denied"],
      [`account:${ACCOUNT_A}`, "failed"],
    ]);
  });

  it("drives the enrolment gate and factor removal checks", async () => {
    const { d, s } = world();
    s.accounts[0] = { id: ACCOUNT_A, name: "Family A", plan: "plus", signInPolicy: "passkey" };
    const check = (id: string) => d.uow.run((r) => requiredEnrolment(r, id));
    expect(await check("kim")).toBe("passkey");
    expect(await check("sam")).toBeNull();
    expect(await check("lee")).toBeNull();
    expect(await d.uow.run((r) => factorRemovalRefusal(r, "sam", "passkey"))).toMatch(/requires a passkey/);
    expect(await d.uow.run((r) => factorRemovalRefusal(r, "sam", "totp"))).toBeNull();
    s.accounts[0] = { id: ACCOUNT_A, name: "Family A", plan: "plus", signInPolicy: "two_factor" };
    s.passkeys = s.passkeys.filter((p) => p.userId !== "sam");
    expect(await d.uow.run((r) => factorRemovalRefusal(r, "sam", "totp"))).toMatch(/two-factor/);
  });
});

describe("recordSecurityEvent", () => {
  it("audits as the identity system with a masked label", async () => {
    const d = deps();
    await recordSecurityEvent(d, { action: "auth.password_reset", userId: "u1", email: "kim@example.com" }, req);
    const [entry] = d.uow.state.audit;
    expect(entry).toMatchObject({
      action: "auth.password_reset",
      result: "success",
      actor: { type: "system", email: "identity" },
      target: { type: "user", id: "u1", label: "k***@example.com" },
    });
  });

  it("records the person as the actor, refusals as denied, and never codes", async () => {
    const d = deps();
    await recordSecurityEvent(
      d,
      {
        action: "auth.sign_in_failed",
        userId: "u1",
        email: "kim@example.com",
        by: "self",
        denied: "invalid_code",
        meta: { method: "totp", backupCodes: ["x"], totpCode: "123456" },
      },
      req,
    );
    await recordSecurityEvent(d, { action: "auth.sign_in_failed", userId: null, email: null, denied: "x" }, req);
    const [first, second] = d.uow.state.audit;
    expect(first).toMatchObject({
      actor: { type: "user", userId: "u1" },
      result: "denied",
      errorCode: "invalid_code",
      meta: { method: "totp", backupCodes: "[redacted]", totpCode: "[redacted]" },
    });
    expect(second).toMatchObject({ actor: { type: "system" }, target: { id: null, label: null } });
  });
});

describe("afterPasswordChange", () => {
  it("a reset signs out every session and forgets trusted browsers, audited by the identity layer", async () => {
    const { d, s } = world();
    const out = await afterPasswordChange(
      d,
      { userId: "sam", email: "sam@example.test", via: "reset", keepSessionId: null },
      req,
    );
    expect(out).toEqual({ sessions: 3, trustedDevices: 1, passkeysRemoved: 0 });
    expect(s.sessions.map((x) => x.id)).toEqual(["s-lee"]);
    expect(s.trustedDevices).toEqual([{ userId: "lee", id: "t2" }]);
    expect(s.audit.at(-1)).toMatchObject({
      action: "auth.password_reset",
      actor: { type: "system", email: "identity" },
      target: { type: "user", id: "sam", label: "s***@example.test" },
      meta: { otherSessionsRevoked: true, sessions: 3, trustedDevices: 1 },
    });
  });

  it("a change keeps the session that made it, audited as the person", async () => {
    const { d, s } = world();
    await afterPasswordChange(
      d,
      { userId: "sam", email: "sam@example.test", via: "change", keepSessionId: "s-here" },
      req,
    );
    expect(s.sessions.map((x) => x.id)).toEqual(["s-here", "s-lee"]);
    expect(s.trustedDevices.filter((t) => t.userId === "sam")).toEqual([]);
    expect(s.audit.at(-1)).toMatchObject({ action: "auth.password_changed", actor: { type: "user", userId: "sam" } });
  });

  it("lifts the first-sign-in password change once the person has chosen their own", async () => {
    const { d, s } = world();
    s.mustChangePassword.push("sam", "lee");
    await afterPasswordChange(
      d,
      { userId: "sam", email: "sam@example.test", via: "change", keepSessionId: "s-here" },
      req,
    );
    expect(s.mustChangePassword).toEqual(["lee"]);
    expect(s.audit.at(-1)?.meta).toMatchObject({ firstPasswordReplaced: true });
  });
});

describe("sign-in method and requirements", () => {
  const f = (totp: boolean, passkeys: number) => ({ totp, passkeys, recoveryCodesLeft: 0 });
  it("two-factor accepts any second step or a passkey, never the password alone (once they have a factor)", () => {
    expect(sessionRefusal("none", f(false, 1), "password")).toBeNull();
    expect(sessionRefusal("two_factor", f(false, 1), "password")).toMatch(
      /requires a second step\. Sign in again and use your passkey or authenticator app/,
    );
    expect(sessionRefusal("two_factor", f(false, 1), null)).not.toBeNull();
    for (const m of [
      "password+totp",
      "password+recovery_code",
      "password+trusted_device",
      "password+passkey",
    ] as const) {
      expect(sessionRefusal("two_factor", f(true, 1), m)).toBeNull();
    }
    // Nothing set up yet: the password signs in, and the enrolment gate keeps them on their Security page.
    expect(sessionRefusal("two_factor", f(false, 0), "password")).toBeNull();
  });

  it("a passkey requirement needs a passkey second step once they have one (ADR-0028)", () => {
    expect(sessionRefusal("passkey", f(true, 1), "password+totp")).toMatch(/use your passkey on the second step/);
    expect(sessionRefusal("passkey", f(true, 1), "password+recovery_code")).not.toBeNull();
    expect(sessionRefusal("passkey", f(true, 1), "password+trusted_device")).not.toBeNull();
    expect(sessionRefusal("passkey", f(false, 1), "password")).not.toBeNull();
    expect(sessionRefusal("passkey", f(true, 1), "password+passkey")).toBeNull();
    // Passwordless sessions from before the change are refused under every policy: people sign in again.
    for (const policy of ["none", "two_factor", "passkey"] as const) {
      expect(sessionRefusal(policy, f(true, 1), "passkey")).toMatch(/Sign in again with your password/);
      expect(sessionRefusal(policy, f(false, 0), "passkey")).not.toBeNull();
    }
    expect(sessionRefusal("passkey", f(true, 0), "password+totp")).toBeNull();
  });

  it("checks against the strictest account, and ends a refused session with an audit entry", async () => {
    const { d, s } = world();
    s.accounts[0] = { id: ACCOUNT_A, name: "Family A", plan: "plus", signInPolicy: "two_factor" };
    s.passkeys.push({
      userId: "kim",
      id: "pk-kim",
      name: "Kim",
      createdAt: NOW,
      deviceType: "multiDevice",
      backedUp: true,
      aaguid: null,
    });
    expect(await d.uow.run((r) => sessionRefusalFor(r, "kim", "password"))).not.toBeNull();
    expect(await d.uow.run((r) => sessionRefusalFor(r, "kim", "password+passkey"))).toBeNull();
    expect(await d.uow.run((r) => sessionRefusalFor(r, "kim", "passkey"))).not.toBeNull();
    expect(await d.uow.run((r) => sessionRefusalFor(r, "lee", "password"))).toBeNull();
    s.sessions.push({
      userId: "kim",
      id: "s-kim",
      createdAt: NOW,
      lastActiveAt: NOW,
      expiresAt: later(1),
      ip: null,
      userAgent: null,
    });
    await endSessionForRequirement(
      d,
      { userId: "kim", email: "kim@example.test", sessionId: "s-kim", method: "password" },
      req,
    );
    expect(s.sessions.some((x) => x.id === "s-kim")).toBe(false);
    expect(s.audit.at(-1)).toMatchObject({
      action: "auth.session_revoked",
      actor: { type: "system" },
      meta: { reason: "sign_in_requirement", method: "password" },
    });
  });

  it("an Owner can't require what their own session doesn't meet", async () => {
    const { d, as } = world();
    const sam = as("sam");
    await expect(
      setSignInPolicy(d, { ...sam, signInMethod: "password+totp" }, { accountId: ACCOUNT_A, policy: "passkey" }, req),
    ).rejects.toThrow(/using your passkey on the second step/);
    await expect(
      setSignInPolicy(d, { ...sam, signInMethod: "password" }, { accountId: ACCOUNT_A, policy: "two_factor" }, req),
    ).rejects.toThrow(/with a second step \(passkey or authenticator app\)/);
    await setSignInPolicy(
      d,
      { ...sam, signInMethod: "password+totp" },
      { accountId: ACCOUNT_A, policy: "two_factor" },
      req,
    );
    await setSignInPolicy(d, sam, { accountId: ACCOUNT_A, policy: "passkey" }, req);
  });
});

describe("removing every passkey", () => {
  it("with sign out everywhere else, audited; refused when a requirement depends on them", async () => {
    const { d, s, as } = world();
    s.accounts[0] = { id: ACCOUNT_A, name: "Family A", plan: "plus", signInPolicy: "passkey" };
    await expect(
      revokeOtherSessions(d, as("sam"), { currentSessionId: "s-here", removePasskeys: true }, req),
    ).rejects.toThrow(ConflictError);
    expect(s.passkeys.some((p) => p.userId === "sam")).toBe(true);
    s.accounts[0] = { id: ACCOUNT_A, name: "Family A", plan: "plus", signInPolicy: "none" };
    const out = await revokeOtherSessions(d, as("sam"), { currentSessionId: "s-here", removePasskeys: true }, req);
    expect(out.passkeysRemoved).toBe(1);
    expect(s.passkeys.some((p) => p.userId === "sam")).toBe(false);
    expect(s.passkeys.some((p) => p.userId === "lee")).toBe(true);
    expect(s.audit.at(-1)).toMatchObject({ action: "auth.sessions_revoked_all", meta: { passkeysRemoved: 1 } });
  });

  it("with a password reset when asked; the Security page then points at passkeys", async () => {
    const { d, s, as } = world();
    await afterPasswordChange(d, { userId: "sam", email: "sam@example.test", via: "reset", keepSessionId: null }, req);
    expect(s.passkeys.some((p) => p.userId === "sam")).toBe(true);
    const overview = await getSecurityOverview(d, as("sam"), { currentSessionId: null });
    expect(overview.passwordResetAt).toEqual(NOW);
    const out = await afterPasswordChange(
      d,
      { userId: "sam", email: "sam@example.test", via: "reset", keepSessionId: null, removePasskeys: true },
      req,
    );
    expect(out.passkeysRemoved).toBe(1);
    expect(s.audit.at(-1)).toMatchObject({ action: "auth.password_reset", meta: { passkeysRemoved: 1 } });
  });
});

describe("password reset can't strip a required factor; first factors are announced", () => {
  it("refuses removing every passkey on reset when a requirement depends on them", async () => {
    const { d, s } = world();
    s.accounts[0] = { id: ACCOUNT_A, name: "Family A", plan: "plus", signInPolicy: "passkey" };
    expect(await d.uow.run((r) => factorRemovalRefusal(r, "sam", "all_passkeys"))).toMatch(/Ask an Owner/);
    // The password has already changed when this runs (a race past the identity layer's check): it never throws,
    // keeps the passkeys, and still signs out and forgets trusted browsers, saying so in the audit entry.
    const out = await afterPasswordChange(
      d,
      { userId: "sam", email: "sam@example.test", via: "reset", keepSessionId: null, removePasskeys: true },
      req,
    );
    expect(out).toEqual({ sessions: 3, trustedDevices: 1, passkeysRemoved: 0 });
    expect(s.passkeys.some((p) => p.userId === "sam")).toBe(true);
    expect(s.sessions.filter((x) => x.userId === "sam")).toEqual([]);
    expect(s.audit.at(-1)).toMatchObject({
      action: "auth.password_reset",
      result: "success",
      meta: { passkeysRemoved: 0, passkeysRemovalRefused: true },
    });
    // Two-factor is still met by the authenticator app, so then it's fine.
    s.accounts[0] = { id: ACCOUNT_A, name: "Family A", plan: "plus", signInPolicy: "two_factor" };
    expect(await d.uow.run((r) => factorRemovalRefusal(r, "sam", "all_passkeys"))).toBeNull();
    expect(await d.uow.run((r) => factorRemovalRefusal(r, "kim", "all_passkeys"))).toBeNull();
  });

  it("tells the person and the Owners, and audits it in the account, only for a first factor under a requirement", async () => {
    const { d, s } = world();
    s.userEmails.sam = "sam@example.test";
    s.userEmails.kim = "kim@example.test";
    // No requirement: nobody is told.
    s.passkeys.push({
      userId: "kim",
      id: "pk-k",
      name: "K",
      createdAt: NOW,
      deviceType: "multiDevice",
      backedUp: true,
      aaguid: null,
    });
    const kim = { userId: "kim", email: "kim@example.test", factor: "passkey" as const, firstFactor: true };
    expect((await noteFactorAdded(d, kim, req)).notify).toEqual([]);
    s.accounts[0] = { id: ACCOUNT_A, name: "Family A", plan: "plus", signInPolicy: "two_factor" };
    // Two additions racing: both saw "no factor" before writing, so both still notify (decided by the caller's
    // before-write flag, not by counting afterwards when the other one is already in).
    s.passkeys.push({ ...s.passkeys.at(-1)!, id: "pk-k2" });
    const [out, again] = await Promise.all([noteFactorAdded(d, kim, req), noteFactorAdded(d, kim, req)]);
    expect(again.notify).toHaveLength(2);
    expect(out.notify).toEqual([
      { email: "kim@example.test", accountName: "Family A", owner: false },
      { email: "sam@example.test", accountName: "Family A", owner: true },
    ]);
    expect(s.audit.at(-1)).toMatchObject({
      scope: `account:${ACCOUNT_A}`,
      action: "account.sign_in_factor_added",
      target: { type: "user", id: "kim" },
      meta: { factor: "passkey", firstFactor: true },
    });
    // Not the first factor (Sam has an app and a passkey): nothing.
    expect(
      (
        await noteFactorAdded(
          d,
          { userId: "sam", email: "sam@example.test", factor: "passkey", firstFactor: false },
          req,
        )
      ).notify,
    ).toEqual([]);
  });
});

describe("all passkeys removed (ADR-0028)", () => {
  it("records it in each of the person's accounts and tells them and those accounts' Owners", async () => {
    const { d, s } = world();
    const kim = { userId: "kim", email: "kim@example.test", via: "password_reset" as const };
    expect((await notePasskeysRemoved(d, { ...kim, passkeysRemoved: 0 }, req)).notify).toEqual([]);
    const { notify } = await notePasskeysRemoved(d, { ...kim, passkeysRemoved: 2 }, req);
    // The person, then the Owners of their accounts (Sam owns Family A), never twice.
    expect(notify[0]).toEqual({ email: "kim@example.test", accountName: null, owner: false });
    expect(notify.slice(1).map((n) => [n.accountName, n.owner])).toEqual([["Family A", true]]);
    expect(s.audit.at(-1)).toMatchObject({
      scope: `account:${ACCOUNT_A}`,
      action: "account.sign_in_factor_removed",
      target: { type: "user", id: "kim" },
      meta: { factor: "passkey", passkeysRemoved: 2, via: "password_reset" },
    });
    // Removing the last one on its own is announced the same way.
    const single = await notePasskeysRemoved(d, { ...kim, passkeysRemoved: 1, via: "single" }, req);
    expect(single.notify.map((n) => n.owner)).toEqual([false, true]);
    expect(s.audit.at(-1)).toMatchObject({
      action: "account.sign_in_factor_removed",
      meta: { passkeysRemoved: 1, via: "single" },
    });
  });
});

describe("a reset that removes every passkey (ADR-0028)", () => {
  it("signs everything out, forgets trusted browsers, and leaves recovery codes worth nothing", async () => {
    const { d, s } = world();
    // Lee's second factor is a passkey, with recovery codes and a trusted browser.
    s.twoFactor.push({ userId: "lee", verified: false, recoveryCodesLeft: 10 });
    s.sessions.push({
      userId: "lee",
      id: "s-lee",
      createdAt: NOW,
      lastActiveAt: NOW,
      expiresAt: later(7),
      ip: null,
      userAgent: null,
    });
    expect(await d.uow.run((r) => r.security.factors("lee"))).toEqual({
      totp: false,
      passkeys: 1,
      recoveryCodesLeft: 10,
    });
    const out = await afterPasswordChange(
      d,
      { userId: "lee", email: "lee@example.test", via: "reset", keepSessionId: null, removePasskeys: true },
      req,
    );
    expect(out).toMatchObject({ passkeysRemoved: 1, trustedDevices: 1 });
    expect(s.trustedDevices.some((t) => t.userId === "lee")).toBe(false);
    expect(s.sessions.some((x) => x.userId === "lee")).toBe(false);
    expect(await d.uow.run((r) => r.security.factors("lee"))).toEqual({
      totp: false,
      passkeys: 0,
      recoveryCodesLeft: 0,
    });
  });
});
