// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ACCOUNT_A, ACCOUNT_B, actAs, actingStaff, deps, req, user } from "../__tests__/helpers";
import { defaultBilling } from "../billing/lifecycle";
import type { Mailbox, MailboxStatus } from "../mailboxes/entity";
import type { Repositories } from "../ports";

import type { AccountTrust } from "./entity";
import {
  accountSending,
  parseTrustNote,
  promoteEstablished,
  promoteForPayment,
  revokeBillingPromotion,
  setAccountTier,
  setMailboxRestriction,
  staffAccountTrust,
  TRUST_NOTE_MAX,
  tierChangeAction,
} from "./service";

const GA = user({ id: "ga", platform: ["global_admin"] });
const TS = user({ id: "ts", platform: ["trust_safety_admin"] });
const SESSION = { sessionId: "s-ga" };
const TS_SESSION = { sessionId: "s-ts" };
const MISSING = "33333333-3333-4333-8333-333333333333";
const NOTE = "ticket 42: bounce spike";

const M_ACTIVE = "aaaaaaaa-0000-4000-8000-000000000001";
const M_SUSP = "aaaaaaaa-0000-4000-8000-000000000002";
const M_FAILED = "aaaaaaaa-0000-4000-8000-000000000003";
const M_DELETING = "aaaaaaaa-0000-4000-8000-000000000004";
const M_OTHER = "bbbbbbbb-0000-4000-8000-000000000001";

const mb = (id: string, accountId: string, status: MailboxStatus): Mailbox => ({
  id,
  accountId,
  userId: null,
  address: `${id.slice(0, 8)}-${id.slice(-1)}@a.test`,
  status,
  quotaBytes: 1,
  stalwartId: `st-${id}`,
  lastError: null,
  purgeAfter: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
});

function world() {
  const d = deps();
  const s = d.uow.state;
  const created = new Date("2026-09-01T00:00:00Z");
  s.accounts.push(
    { id: ACCOUNT_A, name: "Acme", plan: "free", createdAt: created },
    { id: ACCOUNT_B, name: "Other", plan: "free", createdAt: created },
  );
  s.memberships.push(
    { userId: "owner-a", accountId: ACCOUNT_A, role: "owner" },
    { userId: "admin-a", accountId: ACCOUNT_A, role: "user_admin" },
    { userId: "member-a", accountId: ACCOUNT_A, role: "member" },
    { userId: "owner-b", accountId: ACCOUNT_B, role: "owner" },
  );
  for (const u of ["owner-a", "admin-a", "member-a", "owner-b"]) s.userEmails[u] = `${u}@example.test`;
  s.mailboxes.push(
    mb(M_ACTIVE, ACCOUNT_A, "active"),
    mb(M_SUSP, ACCOUNT_A, "suspended"),
    mb(M_FAILED, ACCOUNT_A, "failed"),
    mb(M_DELETING, ACCOUNT_A, "deleting"),
    mb(M_OTHER, ACCOUNT_B, "active"),
  );
  const until = new Date("2026-10-21T12:05:00Z");
  s.stepUps.push(
    { userId: "ga", sessionId: "s-ga", expiresAt: until },
    { userId: "ts", sessionId: "s-ts", expiresAt: until },
  );
  return d;
}

type World = ReturnType<typeof world>;
const trustOf = (d: World, id: string) => d.uow.run((r) => r.trust.get(id));
const ensures = (d: World) => d.uow.state.jobs.filter((j) => j.kind === "mailbox.ensure").map((j) => j.subjectId);
const entries = (d: World, action?: string) => d.uow.state.audit.filter((e) => !action || e.action === action);
const setRow = (d: World, row: Partial<AccountTrust> & { accountId: string }) => {
  const s = d.uow.state;
  s.trust = [
    ...s.trust.filter((t) => t.accountId !== row.accountId),
    {
      tier: "new",
      since: new Date("2026-09-01T00:00:00Z"),
      source: "default",
      reason: null,
      note: null,
      setBy: null,
      lastRestrictedAt: null,
      ...row,
    },
  ];
};

describe("parseTrustNote", () => {
  it("is required, trimmed and capped", () => {
    expect(() => parseTrustNote(undefined)).toThrow(/note/);
    expect(() => parseTrustNote("   ")).toThrow(/note/);
    expect(() => parseTrustNote(5)).toThrow(/note/);
    expect(parseTrustNote("  x ")).toBe("x");
    expect(parseTrustNote("x".repeat(TRUST_NOTE_MAX))).toHaveLength(TRUST_NOTE_MAX);
    expect(() => parseTrustNote("x".repeat(TRUST_NOTE_MAX + 1))).toThrow(/under/);
  });
});

describe("tierChangeAction", () => {
  it("names entering and leaving restricted, and every other move a tier change", () => {
    expect(tierChangeAction("new", "restricted")).toBe("trust.restricted");
    expect(tierChangeAction("standard", "restricted")).toBe("trust.restricted");
    expect(tierChangeAction("restricted", "new")).toBe("trust.unrestricted");
    expect(tierChangeAction("restricted", "restricted")).toBe("trust.tier_changed");
    expect(tierChangeAction("new", "standard")).toBe("trust.tier_changed");
    expect(tierChangeAction("standard", "new")).toBe("trust.tier_changed");
  });
});

describe("setAccountTier", () => {
  it("staff set standard: frozen by the staff source, usable mailboxes queued, both logs without the note", async () => {
    const d = world();
    const out = await setAccountTier(d, GA, ACCOUNT_A, { tier: "standard", note: NOTE }, SESSION, req);
    expect(out).toMatchObject({ from: "new", to: "standard", source: "staff", reason: null, mailboxesQueued: 2 });
    expect(out.notify).toEqual([]);
    expect(await trustOf(d, ACCOUNT_A)).toMatchObject({
      tier: "standard",
      source: "staff",
      note: NOTE,
      setBy: "ga",
      since: d.clock.now(),
      lastRestrictedAt: null,
    });
    expect(ensures(d).sort()).toEqual([M_ACTIVE, M_FAILED].sort());
    expect((await trustOf(d, ACCOUNT_B))?.tier).toBe("new");
    const account = entries(d, "trust.tier_changed").find((e) => e.scope === `account:${ACCOUNT_A}`);
    expect(account).toMatchObject({
      result: "success",
      actor: { type: "staff", role: "global_admin" },
      target: { type: "account", id: ACCOUNT_A, label: "Acme" },
      meta: { fromTier: "new", toTier: "standard", source: "staff", mailboxesQueued: 2 },
    });
    const platform = entries(d, "trust.tier_changed").find((e) => e.scope === "platform");
    expect(platform?.meta).toMatchObject({ accountId: ACCOUNT_A, toTier: "standard" });
    expect(JSON.stringify(d.uow.state.audit)).not.toContain("ticket 42");
  });

  it("a Trust & Safety Administrator may; automatic leaves the tier to the job and billing", async () => {
    const d = world();
    await setAccountTier(d, TS, ACCOUNT_A, { tier: "standard", note: NOTE, automatic: true }, TS_SESSION, req);
    expect(await trustOf(d, ACCOUNT_A)).toMatchObject({ tier: "standard", source: "automatic" });
    // Back to new, automatic again: billing may promote it.
    await setAccountTier(d, TS, ACCOUNT_A, { tier: "new", note: NOTE, automatic: true }, TS_SESSION, req);
    expect(await d.uow.run((r) => promoteForPayment(d, r, ACCOUNT_A))).toHaveLength(1);
  });

  it("restricting needs a reason, records last_restricted_at, audits trust.restricted and lists who to tell", async () => {
    const d = world();
    await expect(
      setAccountTier(d, GA, ACCOUNT_A, { tier: "restricted", note: NOTE }, SESSION, req),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      setAccountTier(d, GA, ACCOUNT_A, { tier: "restricted", note: NOTE, reason: "toString" }, SESSION, req),
    ).rejects.toMatchObject({ code: "bad_request" });
    const out = await setAccountTier(
      d,
      GA,
      ACCOUNT_A,
      { tier: "restricted", reason: "spam", note: NOTE },
      SESSION,
      req,
    );
    expect(out.notify.map((n) => n.email).sort()).toEqual(["admin-a@example.test", "owner-a@example.test"]);
    expect(await trustOf(d, ACCOUNT_A)).toMatchObject({
      tier: "restricted",
      reason: "spam",
      lastRestrictedAt: d.clock.now(),
    });
    const e = entries(d, "trust.restricted").find((x) => x.scope === `account:${ACCOUNT_A}` && x.result === "success");
    expect(e?.meta).toMatchObject({
      fromTier: "new",
      source: "staff",
      reasonCategory: "spam",
      reason: expect.any(String) as string,
    });
    expect(
      entries(d)
        .filter((x) => x.result === "failed")
        .map((x) => x.errorCode),
    ).toEqual(["bad_request", "bad_request"]);
  });

  it("leaving restricted needs a reason and is audited trust.unrestricted; last_restricted_at stays", async () => {
    const d = world();
    await setAccountTier(d, GA, ACCOUNT_A, { tier: "restricted", reason: "spam", note: NOTE }, SESSION, req);
    const at = (await trustOf(d, ACCOUNT_A))?.lastRestrictedAt;
    await expect(
      setAccountTier(d, GA, ACCOUNT_A, { tier: "standard", note: NOTE }, SESSION, req),
    ).rejects.toMatchObject({ code: "bad_request" });
    const out = await setAccountTier(d, GA, ACCOUNT_A, { tier: "standard", reason: "other", note: NOTE }, SESSION, req);
    expect(out).toMatchObject({ from: "restricted", to: "standard", notify: [] });
    expect((await trustOf(d, ACCOUNT_A))?.lastRestrictedAt).toEqual(at);
    expect(
      entries(d, "trust.unrestricted").find((x) => x.scope === `account:${ACCOUNT_A}` && x.result === "success")?.meta,
    ).toMatchObject({
      toTier: "standard",
      reasonCategory: "other",
    });
  });

  it("trusted is reserved: 422 tier_unavailable, audited as denied, nothing written", async () => {
    const d = world();
    await expect(setAccountTier(d, GA, ACCOUNT_A, { tier: "trusted", note: NOTE }, SESSION, req)).rejects.toMatchObject(
      { code: "tier_unavailable" },
    );
    expect(entries(d).map((e) => [e.scope, e.result, e.errorCode])).toEqual([
      [`account:${ACCOUNT_A}`, "denied", "tier_unavailable"],
    ]);
    expect((await trustOf(d, ACCOUNT_A))?.tier).toBe("new");
    expect(ensures(d)).toEqual([]);
  });

  it("refuses an unknown tier, a missing note, automatic restricted and a non-boolean automatic (400)", async () => {
    const d = world();
    for (const input of [
      { tier: "gold", note: NOTE },
      { note: NOTE },
      { tier: "standard" },
      { tier: "standard", note: "x".repeat(TRUST_NOTE_MAX + 1) },
      { tier: "restricted", reason: "spam", note: NOTE, automatic: true },
      { tier: "standard", note: NOTE, automatic: "yes" },
    ]) {
      await expect(setAccountTier(d, GA, ACCOUNT_A, input, SESSION, req)).rejects.toMatchObject({
        code: "bad_request",
      });
    }
    expect((await trustOf(d, ACCOUNT_A))?.tier).toBe("new");
  });

  it("is 403 without the permission and 404 for unknown or malformed accounts (platform log only)", async () => {
    const d = world();
    const support = user({ id: "sup", platform: ["support_admin"] });
    const billing = user({ id: "bil", platform: ["billing_admin"] });
    const owner = user({ id: "owner-a", account: [[ACCOUNT_A, "owner"]] });
    for (const actor of [support, billing, owner]) {
      await expect(
        setAccountTier(d, actor, ACCOUNT_A, { tier: "standard", note: NOTE }, SESSION, req),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    for (const id of [MISSING, "nope"]) {
      await expect(setAccountTier(d, GA, id, { tier: "standard", note: NOTE }, SESSION, req)).rejects.toMatchObject({
        code: "not_found",
      });
    }
    const denied = entries(d).filter((e) => e.result === "denied");
    expect(denied.map((e) => e.errorCode)).toEqual(["forbidden", "forbidden", "forbidden", "not_found", "not_found"]);
    expect(denied.every((e) => e.scope === "platform")).toBe(true);
    expect((await trustOf(d, ACCOUNT_A))?.tier).toBe("new");
  });

  it("needs a fresh step-up and is refused while acting as someone (both audited as denied)", async () => {
    const d = world();
    const input = { tier: "standard", note: NOTE };
    await expect(setAccountTier(d, GA, ACCOUNT_A, input, { sessionId: "other" }, req)).rejects.toMatchObject({
      code: "step_up_required",
    });
    await expect(setAccountTier(d, GA, ACCOUNT_A, input, { sessionId: null }, req)).rejects.toMatchObject({
      code: "step_up_required",
    });
    const acting = { ...GA, actingAs: actAs(ACCOUNT_A, "global_admin", "ga") };
    await expect(setAccountTier(d, acting, ACCOUNT_A, input, SESSION, req)).rejects.toMatchObject({
      code: "forbidden",
    });
    // As the server builds an acting actor (platform roles set aside), the permission itself is missing.
    await expect(
      setAccountTier(d, actingStaff(ACCOUNT_A, "global_admin", "ga"), ACCOUNT_A, input, SESSION, req),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      entries(d)
        .filter((e) => e.result === "denied")
        .map((e) => e.errorCode),
    ).toEqual(["step_up_required", "step_up_required", "act_as", "forbidden"]);
    expect((await trustOf(d, ACCOUNT_A))?.tier).toBe("new");
  });

  it("409 for the same tier from the same source, and when the tier changed kind while the request ran", async () => {
    const d = world();
    await setAccountTier(d, GA, ACCOUNT_A, { tier: "standard", note: NOTE }, SESSION, req);
    await expect(
      setAccountTier(d, GA, ACCOUNT_A, { tier: "standard", note: NOTE }, SESSION, req),
    ).rejects.toMatchObject({ code: "conflict" });
    // Restricted by someone else between the first read and the lock: a plain tier change would now leave restricted.
    const run = d.uow.run.bind(d.uow);
    d.uow.run = <T>(fn: (r: Repositories) => Promise<T>) =>
      run((r) =>
        fn({
          ...r,
          accounts: {
            ...r.accounts,
            lock: async (id: string) => {
              setRow(d, { accountId: id, tier: "restricted", source: "staff" });
              await r.accounts.lock(id);
            },
          },
        }),
      );
    await expect(setAccountTier(d, GA, ACCOUNT_A, { tier: "new", note: NOTE }, SESSION, req)).rejects.toMatchObject({
      code: "conflict",
    });
  });
});

describe("setMailboxRestriction", () => {
  const restrict = { restricted: true, reason: "abuse", note: NOTE };
  const lift = { restricted: false, reason: "other", note: NOTE };

  it("restricts one mailbox: stored with the note, account last_restricted_at set, only it queued, audited", async () => {
    const d = world();
    const out = await setMailboxRestriction(d, TS, ACCOUNT_A, M_ACTIVE, restrict, TS_SESSION, req);
    expect(out).toMatchObject({ restricted: true, reason: "abuse", accountName: "Acme" });
    expect(out.notify.map((n) => n.email).sort()).toEqual(["admin-a@example.test", "owner-a@example.test"]);
    const box = await d.uow.run((r) => r.trust.mailbox(ACCOUNT_A, M_ACTIVE));
    expect(box?.restriction).toMatchObject({ reason: "abuse", note: NOTE, byUserId: "ts" });
    expect((await trustOf(d, ACCOUNT_A))?.lastRestrictedAt).toEqual(d.clock.now());
    expect((await trustOf(d, ACCOUNT_A))?.tier).toBe("new");
    expect(ensures(d)).toEqual([M_ACTIVE]);
    const e = entries(d, "trust.mailbox_restricted").find((x) => x.scope === `account:${ACCOUNT_A}`);
    expect(e).toMatchObject({
      result: "success",
      target: { type: "mailbox", id: M_ACTIVE },
      meta: { reasonCategory: "abuse" },
    });
    expect(entries(d, "trust.mailbox_restricted").map((x) => x.scope)).toEqual([`account:${ACCOUNT_A}`, "platform"]);
    expect(JSON.stringify(d.uow.state.audit)).not.toContain("ticket 42");

    await setMailboxRestriction(d, TS, ACCOUNT_A, M_ACTIVE, lift, TS_SESSION, req);
    expect((await d.uow.run((r) => r.trust.mailbox(ACCOUNT_A, M_ACTIVE)))?.restriction).toBeNull();
    expect((await trustOf(d, ACCOUNT_A))?.lastRestrictedAt).not.toBeNull();
    expect(entries(d, "trust.mailbox_unrestricted")).toHaveLength(2);
  });

  it("a mailbox of another account, or an unknown one, is 404 in the platform log and nothing changes", async () => {
    const d = world();
    for (const [acc, box] of [
      [ACCOUNT_A, M_OTHER],
      [ACCOUNT_B, M_ACTIVE],
      [ACCOUNT_A, MISSING],
      [MISSING, M_ACTIVE],
      [ACCOUNT_A, "nope"],
    ] as const) {
      await expect(setMailboxRestriction(d, GA, acc, box, restrict, SESSION, req)).rejects.toMatchObject({
        code: "not_found",
      });
    }
    expect(entries(d).every((e) => e.scope === "platform" && e.errorCode === "not_found")).toBe(true);
    expect(d.uow.state.mailboxRestrictions).toEqual([]);
    expect((await trustOf(d, ACCOUNT_B))?.lastRestrictedAt).toBeNull();
  });

  it("refuses without permission, step-up, while acting as, and with bad input; 409 when already so", async () => {
    const d = world();
    const support = user({ id: "sup", platform: ["support_admin"] });
    await expect(setMailboxRestriction(d, support, ACCOUNT_A, M_ACTIVE, restrict, SESSION, req)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      setMailboxRestriction(d, GA, ACCOUNT_A, M_ACTIVE, restrict, { sessionId: "x" }, req),
    ).rejects.toMatchObject({ code: "step_up_required" });
    const acting = { ...GA, actingAs: actAs(ACCOUNT_A, "global_admin", "ga") };
    await expect(setMailboxRestriction(d, acting, ACCOUNT_A, M_ACTIVE, restrict, SESSION, req)).rejects.toMatchObject({
      code: "forbidden",
    });
    for (const bad of [
      { restricted: "yes", reason: "spam", note: NOTE },
      { restricted: true, note: NOTE },
      { restricted: false, note: NOTE },
      { restricted: true, reason: "spam" },
    ]) {
      await expect(setMailboxRestriction(d, GA, ACCOUNT_A, M_ACTIVE, bad, SESSION, req)).rejects.toMatchObject({
        code: "bad_request",
      });
    }
    await expect(setMailboxRestriction(d, GA, ACCOUNT_A, M_ACTIVE, lift, SESSION, req)).rejects.toMatchObject({
      code: "conflict",
    });
    await setMailboxRestriction(d, GA, ACCOUNT_A, M_ACTIVE, restrict, SESSION, req);
    await expect(setMailboxRestriction(d, GA, ACCOUNT_A, M_ACTIVE, restrict, SESSION, req)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(
      entries(d)
        .filter((e) => e.result === "denied")
        .map((e) => [e.scope, e.errorCode]),
    ).toEqual([
      ["platform", "forbidden"],
      [`account:${ACCOUNT_A}`, "step_up_required"],
      [`account:${ACCOUNT_A}`, "act_as"],
    ]);
  });
});

describe("promoteForPayment (billing, ADR-0034 §2)", () => {
  it("promotes a new account to standard with source billing and queues its usable mailboxes", async () => {
    const d = world();
    const changes = await d.uow.run((r) => promoteForPayment(d, r, ACCOUNT_A));
    expect(changes).toEqual([
      {
        action: "trust.tier_changed",
        accountId: ACCOUNT_A,
        target: { type: "account", id: ACCOUNT_A },
        meta: { fromTier: "new", toTier: "standard", source: "billing", mailboxesQueued: 2 },
      },
    ]);
    expect(await trustOf(d, ACCOUNT_A)).toMatchObject({ tier: "standard", source: "billing", setBy: null, note: null });
    expect((await trustOf(d, ACCOUNT_B))?.tier).toBe("new");
  });

  it("never touches a staff-set tier, a restricted or once-restricted account, or a higher tier", async () => {
    const cases: Partial<AccountTrust>[] = [
      { tier: "new", source: "staff" },
      { tier: "restricted", source: "staff" },
      { tier: "new", source: "automatic", lastRestrictedAt: new Date("2026-10-01T00:00:00Z") },
      { tier: "standard", source: "automatic" },
      { tier: "trusted", source: "staff" },
    ];
    for (const row of cases) {
      const d = world();
      setRow(d, { accountId: ACCOUNT_A, ...row });
      expect(await d.uow.run((r) => promoteForPayment(d, r, ACCOUNT_A))).toEqual([]);
      expect((await trustOf(d, ACCOUNT_A))?.tier).toBe(row.tier);
      expect(ensures(d)).toEqual([]);
    }
  });

  it("an unknown account changes nothing", async () => {
    const d = world();
    expect(await d.uow.run((r) => promoteForPayment(d, r, MISSING))).toEqual([]);
  });

  it("a suspended account isn't promoted by paying (finding 6 of the slices 1–11 review)", async () => {
    const d = world();
    const a = d.uow.state.accounts.find((x) => x.id === ACCOUNT_A);
    if (a) a.status = "suspended";
    expect(await d.uow.run((r) => promoteForPayment(d, r, ACCOUNT_A))).toEqual([]);
    expect((await trustOf(d, ACCOUNT_A))?.tier).toBe("new");
    expect(ensures(d)).toEqual([]);
  });
});

describe("revokeBillingPromotion (finding 2 of the slices 1–11 review)", () => {
  it("takes billing's standard back to new / default, queues the usable mailboxes and returns a system entry", async () => {
    const d = world();
    setRow(d, { accountId: ACCOUNT_A, tier: "standard", source: "billing", since: d.clock.now() });
    const changes = await d.uow.run((r) => revokeBillingPromotion(d, r, ACCOUNT_A, "refund"));
    expect(changes).toEqual([
      {
        action: "trust.tier_changed",
        accountId: ACCOUNT_A,
        target: { type: "account", id: ACCOUNT_A },
        meta: { fromTier: "standard", toTier: "new", source: "default", cause: "refund", mailboxesQueued: 2 },
      },
    ]);
    expect(await trustOf(d, ACCOUNT_A)).toMatchObject({ tier: "new", source: "default", since: d.clock.now() });
    expect(ensures(d).sort()).toEqual([M_ACTIVE, M_FAILED].sort());
    // Again: nothing more (idempotent).
    expect(await d.uow.run((r) => revokeBillingPromotion(d, r, ACCOUNT_A, "refund"))).toEqual([]);
  });

  it("never touches a tier billing didn't give: staff, automatic, default, restricted", async () => {
    const cases: Partial<AccountTrust>[] = [
      { tier: "standard", source: "staff" },
      { tier: "standard", source: "automatic" },
      { tier: "new", source: "default" },
      { tier: "new", source: "staff" },
      { tier: "restricted", source: "staff" },
    ];
    for (const row of cases) {
      const d = world();
      setRow(d, { accountId: ACCOUNT_A, ...row });
      expect(await d.uow.run((r) => revokeBillingPromotion(d, r, ACCOUNT_A, "dispute"))).toEqual([]);
      expect(await trustOf(d, ACCOUNT_A)).toMatchObject(row);
      expect(ensures(d)).toEqual([]);
    }
    const d = world();
    expect(await d.uow.run((r) => revokeBillingPromotion(d, r, MISSING, "dispute"))).toEqual([]);
  });

  it("withinMs: only a promotion at most that old", async () => {
    const d = world();
    const day = 86_400_000;
    setRow(d, {
      accountId: ACCOUNT_A,
      tier: "standard",
      source: "billing",
      since: new Date(d.clock.now().getTime() - 15 * day),
    });
    expect(
      await d.uow.run((r) => revokeBillingPromotion(d, r, ACCOUNT_A, "plan_ended", { withinMs: 14 * day })),
    ).toEqual([]);
    expect((await trustOf(d, ACCOUNT_A))?.tier).toBe("standard");
    setRow(d, {
      accountId: ACCOUNT_A,
      tier: "standard",
      source: "billing",
      since: new Date(d.clock.now().getTime() - 14 * day),
    });
    expect(
      await d.uow.run((r) => revokeBillingPromotion(d, r, ACCOUNT_A, "plan_ended", { withinMs: 14 * day })),
    ).toHaveLength(1);
    expect((await trustOf(d, ACCOUNT_A))?.tier).toBe("new");
  });
});

/** The job's criteria (`runTrustPromotion`): accounts created before now, fewer than 3 held sends in the last day. */
const CRITERIA = {
  createdBefore: new Date("2026-10-21T12:00:00Z"),
  heldSince: new Date("2026-10-20T12:00:00Z"),
  maxHeld: 3,
};

describe("promoteEstablished (the promotion job's step)", () => {
  it("promotes a candidate with source automatic", async () => {
    const d = world();
    const changes = await d.uow.run((r) => promoteEstablished(d, r, ACCOUNT_A, CRITERIA));
    expect(changes[0]?.meta).toMatchObject({ fromTier: "new", toTier: "standard", source: "automatic" });
    expect((await trustOf(d, ACCOUNT_A))?.source).toBe("automatic");
  });

  it("skips an account that stopped qualifying: suspended, billing restricted or lapsed, restricted, staff-set", async () => {
    const setups: ((d: World) => void | Promise<void>)[] = [
      (d) => {
        const a = d.uow.state.accounts.find((x) => x.id === ACCOUNT_A);
        if (a) a.status = "suspended";
      },
      (d) => d.uow.state.billing.push({ ...defaultBilling(ACCOUNT_A, "plus", d.clock.now()), state: "restricted" }),
      (d) => d.uow.state.billing.push({ ...defaultBilling(ACCOUNT_A, "plus", d.clock.now()), state: "lapsed" }),
      (d) => {
        setRow(d, { accountId: ACCOUNT_A, lastRestrictedAt: d.clock.now() });
      },
      (d) => {
        setRow(d, { accountId: ACCOUNT_A, source: "staff" });
      },
      // Checked again under the lock too (finding 5): a member suspended, an owner's email unconfirmed, held sends.
      (d) => {
        d.uow.state.personSuspensions["member-a"] = { reason: "spam", note: null, at: d.clock.now(), byUserId: "ga" };
      },
      (d) => d.uow.state.unverifiedEmails.push("owner-a"),
      async (d) => {
        for (let i = 0; i < 3; i++) {
          await d.uow.run((r) =>
            r.audit.append(
              {
                scope: `account:${ACCOUNT_A}`,
                action: "trust.send_held",
                actor: { type: "user", userId: "member-a", email: null, role: "member", accountId: ACCOUNT_A },
                onBehalfOf: null,
                target: { type: "mailbox", id: M_ACTIVE, label: null },
                result: "denied",
                errorCode: "sending_held",
                requestId: `held-${String(i)}`,
                ip: null,
                userAgent: null,
                meta: { externalRecipients: 1 },
              },
              d.clock.now(),
            ),
          );
        }
      },
      (d) => {
        d.uow.state.memberships = d.uow.state.memberships.filter(
          (m) => m.role !== "owner" || m.accountId !== ACCOUNT_A,
        );
      },
    ];
    for (const setup of setups) {
      const d = world();
      await setup(d);
      expect(await d.uow.run((r) => promoteEstablished(d, r, ACCOUNT_A, CRITERIA))).toEqual([]);
      expect((await trustOf(d, ACCOUNT_A))?.tier).toBe("new");
    }
    const d = world();
    expect(await d.uow.run((r) => promoteEstablished(d, r, MISSING, CRITERIA))).toEqual([]);
  });
});

describe("accountSending (what the account's people see)", () => {
  it("every role with account.read and staff acting as read the published facts; never the note or who set it", async () => {
    const d = world();
    setRow(d, {
      accountId: ACCOUNT_A,
      tier: "restricted",
      source: "staff",
      reason: "phishing",
      note: NOTE,
      setBy: "ga",
    });
    for (const actor of [
      user({ id: "owner-a", account: [[ACCOUNT_A, "owner"]] }),
      user({ id: "admin-a", account: [[ACCOUNT_A, "user_admin"]] }),
      user({ id: "aud-a", account: [[ACCOUNT_A, "auditor"]] }),
      actingStaff(ACCOUNT_A),
    ]) {
      const out = await accountSending(d, actor, ACCOUNT_A);
      expect(out).toMatchObject({
        tier: "restricted",
        label: "Restricted",
        externalHeld: false,
        mailAppsCanSend: false,
        limits: { messagesPerDay: 0 },
        reason: { category: "phishing", label: expect.any(String) as string },
      });
      const text = JSON.stringify(out);
      for (const hidden of ["ticket 42", '"ga"', "lastRestrictedAt", "source", "setBy", "note"])
        expect(text).not.toContain(hidden);
    }
    expect(d.uow.state.audit).toEqual([]);
  });

  it("new is held from outside addresses and mail apps; standard isn't; no reason outside restricted", async () => {
    const d = world();
    const owner = user({ id: "owner-a", account: [[ACCOUNT_A, "owner"]] });
    expect(await accountSending(d, owner, ACCOUNT_A)).toEqual({
      tier: "new",
      label: "New",
      description: expect.any(String) as string,
      limits: { messagesPerDay: 25, messagesPerHour: 10, recipientsPerMessage: 10 },
      externalHeld: true,
      mailAppsCanSend: false,
    });
    setRow(d, { accountId: ACCOUNT_A, tier: "standard", source: "staff", reason: "other" });
    expect(await accountSending(d, owner, ACCOUNT_A)).toMatchObject({ externalHeld: false, mailAppsCanSend: true });
    expect("reason" in (await accountSending(d, owner, ACCOUNT_A))).toBe(false);
  });

  it("a Member (no account.read; they see their mailbox's tier in the webmail) is 403", async () => {
    const d = world();
    const member = user({ id: "member-a", account: [[ACCOUNT_A, "member"]] });
    await expect(accountSending(d, member, ACCOUNT_A)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("another account's id is 404, signed out 401", async () => {
    const d = world();
    const ownerB = user({ id: "owner-b", account: [[ACCOUNT_B, "owner"]] });
    await expect(accountSending(d, ownerB, ACCOUNT_A)).rejects.toMatchObject({ code: "not_found" });
    await expect(accountSending(d, { kind: "anonymous" }, ACCOUNT_A)).rejects.toMatchObject({ code: "unauthorized" });
  });
});

describe("staffAccountTrust (the staff Trust card)", () => {
  it("shows notes only with platform.suspensionNotes.read", async () => {
    const d = world();
    setRow(d, { accountId: ACCOUNT_A, tier: "restricted", source: "staff", reason: "spam", note: NOTE, setBy: "ga" });
    d.uow.state.mailboxRestrictions.push({
      mailboxId: M_ACTIVE,
      at: d.clock.now(),
      reason: "abuse",
      note: "box note",
      byUserId: "ts",
    });
    const withNotes = await staffAccountTrust(d, TS, ACCOUNT_A);
    expect(withNotes).toMatchObject({ tier: "restricted", source: "staff", note: NOTE, setBy: "ga" });
    expect(withNotes.mailboxes.find((m) => m.mailboxId === M_ACTIVE)?.restriction).toMatchObject({ note: "box note" });
    const billing = user({ id: "bil", platform: ["billing_admin"] });
    const without = await staffAccountTrust(d, billing, ACCOUNT_A);
    expect("note" in without).toBe(false);
    expect(JSON.stringify(without)).not.toContain("note");
    expect(without.mailboxes.find((m) => m.mailboxId === M_ACTIVE)?.restriction?.reason).toBe("abuse");
  });

  it("403 for customers and staff without account access, 404 for unknown accounts", async () => {
    const d = world();
    await expect(
      staffAccountTrust(d, user({ id: "owner-a", account: [[ACCOUNT_A, "owner"]] }), ACCOUNT_A),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      staffAccountTrust(d, user({ id: "rr", platform: ["reports_reader"] }), ACCOUNT_A),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(staffAccountTrust(d, GA, MISSING)).rejects.toMatchObject({ code: "not_found" });
    await expect(staffAccountTrust(d, GA, "nope")).rejects.toMatchObject({ code: "not_found" });
  });
});
