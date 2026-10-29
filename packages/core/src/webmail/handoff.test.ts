// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  ACCOUNT_A,
  ACCOUNT_B,
  actingStaff,
  anonymous,
  deps as makeDeps,
  fixedClock,
  req,
  user,
} from "../__tests__/helpers";
import {
  AccountSuspendedError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
  WebmailHandoffError,
} from "../errors";
import type { Mailbox } from "../mailboxes/entity";
import type { WebmailAccess } from "./access";
import {
  type HandoffCodeStore,
  type HandoffGrant,
  type HandoffTarget,
  handoffChallenge,
  handoffMailboxes,
  isHandoffToken,
  newHandoffVerifier,
  redeemWebmailHandoff,
  startWebmailHandoff,
} from "./handoff";

const MBX_OWN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const MBX_OTHER = "abababab-abab-4bab-8bab-abababababab";
const MBX_SHARED = "efefefef-efef-4fef-8fef-efefefefefef";
const MBX_PAUSED = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
const MBX_MUST = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const MBX_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SESSION = "console-session-1";

const member = user({ id: "member", account: [[ACCOUNT_A, "member"]] });
const owner = user({ id: "owner", account: [[ACCOUNT_A, "owner"]] });
const auditor = user({ id: "auditor", account: [[ACCOUNT_A, "auditor"]] });

/** Redis stand-in: `take` is GETDEL; TTL against the test clock. */
function memoryCodes(now: () => number) {
  const m = new Map<string, { grant: HandoffGrant; until: number }>();
  const store: HandoffCodeStore & { size(): number; keys(): string[] } = {
    put: async (k, grant, ttl) => {
      m.set(k, { grant: structuredClone(grant), until: now() + ttl * 1000 });
    },
    take: async (k) => {
      const e = m.get(k);
      m.delete(k);
      return e && e.until > now() ? e.grant : null;
    },
    size: () => m.size,
    keys: () => [...m.keys()],
  };
  return store;
}

function setup() {
  const clock = fixedClock("2026-10-29T12:00:00Z");
  const d = makeDeps(clock);
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "A", plan: "plus" }, { id: ACCOUNT_B, name: "B", plan: "plus" });
  for (const [userId, accountId, role] of [
    ["member", ACCOUNT_A, "member"],
    ["owner", ACCOUNT_A, "owner"],
    ["auditor", ACCOUNT_A, "auditor"],
    ["member", ACCOUNT_B, "member"],
  ] as const) {
    s.memberships.push({ userId, accountId, role });
    s.userEmails[userId] = `${userId}@example.test`;
  }
  for (const userId of ["member", "owner", "auditor", "staff-1"]) {
    s.sessions.push({
      id: SESSION,
      userId,
      createdAt: new Date(0),
      lastActiveAt: new Date(0),
      expiresAt: new Date("2026-11-01T00:00:00Z"),
      ip: null,
      userAgent: null,
    });
  }
  const mailbox = (id: string, accountId: string, address: string, userId: string | null): Mailbox => ({
    id,
    accountId,
    userId,
    address,
    status: "active",
    quotaBytes: 1024,
    stalwartId: `s-${id.slice(0, 4)}`,
    lastError: null,
    purgeAfter: null,
    createdAt: new Date(0),
  });
  s.mailboxes.push(
    mailbox(MBX_OWN, ACCOUNT_A, "kid@family.test", "member"),
    mailbox(MBX_OTHER, ACCOUNT_A, "mum@family.test", "owner"),
    mailbox(MBX_SHARED, ACCOUNT_A, "shared@family.test", null),
    { ...mailbox(MBX_PAUSED, ACCOUNT_A, "paused@family.test", "member"), status: "suspended" },
    { ...mailbox(MBX_MUST, ACCOUNT_A, "new@family.test", "member"), mustChangePassword: true },
    mailbox(MBX_B, ACCOUNT_B, "kid@other.test", "member"),
  );
  // A fresh step-up on this console session (a sign-in counts), as the identity layer records it.
  for (const userId of ["member", "owner", "auditor", "staff-1"]) {
    s.stepUps.push({ userId, sessionId: SESSION, expiresAt: new Date("2026-10-29T12:05:00Z") });
  }
  const codes = memoryCodes(() => clock.now().getTime());
  const states = new Map<string, WebmailAccess>();
  const access = { state: async (address: string) => states.get(address) ?? ("ok" as const) };
  return { d, s, clock, codes, states, access };
}

const verifier = newHandoffVerifier();
const challenge = handoffChallenge(verifier);

describe("console → webmail handoff (ADR-0024)", () => {
  it("lists only the person's own mailboxes, says which can't be opened, and nothing while acting or for Auditors", async () => {
    const { d } = setup();
    const mine = await handoffMailboxes(d, member);
    expect(mine.map((m) => [m.address, m.unavailable])).toEqual([
      ["kid@family.test", null],
      ["new@family.test", "password_change_required"],
      ["paused@family.test", "mailbox_unavailable"],
    ]);
    // Account B isn't in this actor's memberships (the actor decides, not the rows).
    expect(
      await handoffMailboxes(
        d,
        user({
          id: "member",
          account: [
            [ACCOUNT_A, "member"],
            [ACCOUNT_B, "member"],
          ],
        }),
      ),
    ).toHaveLength(4);
    expect(await handoffMailboxes(d, auditor)).toEqual([]);
    expect(await handoffMailboxes(d, actingStaff(ACCOUNT_A))).toEqual([]);
    expect(await handoffMailboxes(d, anonymous)).toEqual([]);
  });

  it("mints a one-time code bound to the person, session, mailbox and challenge, and audits it without secrets", async () => {
    const { d, s, codes, access } = setup();
    const out = await startWebmailHandoff(
      d,
      codes,
      access,
      member,
      ACCOUNT_A,
      MBX_OWN,
      { challenge },
      { sessionId: SESSION },
      req,
    );
    expect(isHandoffToken(out.code)).toBe(true);
    expect(out.expiresAt).toEqual(new Date("2026-10-29T12:01:00Z"));
    expect(codes.size()).toBe(1);
    // Stored under a hash of the code, never the code itself.
    expect(codes.keys()).not.toContain(out.code);
    const entry = s.audit.at(-1);
    expect(entry).toMatchObject({
      action: "webmail.handoff_started",
      result: "success",
      scope: `account:${ACCOUNT_A}`,
      target: { type: "mailbox", id: MBX_OWN, label: "kid@family.test" },
    });
    expect(JSON.stringify(s.audit)).not.toContain(out.code);
    expect(JSON.stringify(s.audit)).not.toContain(challenge);
  });

  it("answers 404 for someone else's, shared, unknown or other-account mailboxes; 401 signed out; 403 acting", async () => {
    const { d, s, codes, access } = setup();
    const start = (actor: Parameters<typeof startWebmailHandoff>[3], accountId: string, mailboxId: string) =>
      startWebmailHandoff(d, codes, access, actor, accountId, mailboxId, { challenge }, { sessionId: SESSION }, req);
    await expect(start(member, ACCOUNT_A, MBX_OTHER)).rejects.toBeInstanceOf(NotFoundError);
    await expect(start(member, ACCOUNT_A, MBX_SHARED)).rejects.toBeInstanceOf(NotFoundError);
    await expect(start(member, ACCOUNT_A, "not-a-uuid")).rejects.toBeInstanceOf(NotFoundError);
    await expect(start(owner, ACCOUNT_A, MBX_OWN)).rejects.toBeInstanceOf(NotFoundError);
    // Account B: member of A only → 404 from the matrix (never confirm the account).
    await expect(start(member, ACCOUNT_B, MBX_B)).rejects.toBeInstanceOf(NotFoundError);
    await expect(start(anonymous, ACCOUNT_A, MBX_OWN)).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(start(actingStaff(ACCOUNT_A), ACCOUNT_A, MBX_OWN)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(start(auditor, ACCOUNT_A, MBX_OWN)).rejects.toBeInstanceOf(ForbiddenError);
    expect(codes.size()).toBe(0);
    // Every refusal was audited as denied; the acting one names the staff member on whose behalf.
    const denied = s.audit.filter((e) => e.action === "webmail.handoff_started");
    expect(denied.every((e) => e.result === "denied")).toBe(true);
    // Four inside account A, one from the matrix for account B (in the platform log: never confirm the account).
    expect(denied.filter((e) => e.errorCode === "not_found")).toHaveLength(5);
    expect(denied.filter((e) => e.scope === "platform")).toHaveLength(2);
    expect(denied.some((e) => e.onBehalfOf !== null)).toBe(true);
  });

  it("refuses an unusable mailbox, a pending password change, a blocked mailbox, a bad challenge and a missing session", async () => {
    const { d, s, codes, access, states } = setup();
    const start = (
      mailboxId: string,
      input: { challenge?: unknown } = { challenge },
      sessionId: string | null = SESSION,
    ) => startWebmailHandoff(d, codes, access, member, ACCOUNT_A, mailboxId, input, { sessionId }, req);
    await expect(start(MBX_PAUSED)).rejects.toMatchObject({ code: "handoff_refused", reason: "mailbox_unavailable" });
    await expect(start(MBX_MUST)).rejects.toMatchObject({ reason: "password_change_required" });
    states.set("kid@family.test", "person_suspended");
    await expect(start(MBX_OWN)).rejects.toMatchObject({ reason: "mailbox_unavailable" });
    expect(s.audit.at(-1)).toMatchObject({
      result: "denied",
      errorCode: "mailbox_unavailable",
      meta: { state: "person_suspended" },
    });
    states.clear();
    await expect(start(MBX_OWN, { challenge: "short" })).rejects.toBeInstanceOf(ValidationError);
    await expect(start(MBX_OWN, {})).rejects.toBeInstanceOf(ValidationError);
    await expect(start(MBX_OWN, { challenge }, null)).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(codes.size()).toBe(0);
  });

  it("refuses while the account is suspended by staff (the matrix's own 403)", async () => {
    const { d, codes, access } = setup();
    const suspendedIn = { ...member, suspendedAccountIds: [ACCOUNT_A] };
    await expect(
      startWebmailHandoff(
        d,
        codes,
        access,
        suspendedIn,
        ACCOUNT_A,
        MBX_OWN,
        { challenge },
        { sessionId: SESSION },
        req,
      ),
    ).rejects.toBeInstanceOf(AccountSuspendedError);
  });

  it("takes back a stored code when the audit entry can't be written", async () => {
    const { d, codes, access } = setup();
    const failing = {
      ...d,
      uow: {
        run: async <T>(fn: Parameters<typeof d.uow.run<T>>[0]): Promise<T> =>
          d.uow.run(async (r) => {
            const out = await fn(r);
            if (codes.size() > 0) throw new Error("audit write failed");
            return out;
          }),
      },
    };
    await expect(
      startWebmailHandoff(
        failing,
        codes,
        access,
        member,
        ACCOUNT_A,
        MBX_OWN,
        { challenge },
        { sessionId: SESSION },
        req,
      ),
    ).rejects.toThrow("audit write failed");
    expect(codes.size()).toBe(0);
  });

  describe("redeem", () => {
    async function minted(ctx = setup()) {
      const { code } = await startWebmailHandoff(
        ctx.d,
        ctx.codes,
        ctx.access,
        { ...member, signInMethod: "password" },
        ACCOUNT_A,
        MBX_OWN,
        { challenge },
        { sessionId: SESSION },
        req,
      );
      const opened: HandoffTarget[] = [];
      const open = async (t: HandoffTarget) => {
        opened.push(t);
        return "webmail-session";
      };
      const redeem = (input: { code?: unknown; verifier?: unknown }) =>
        redeemWebmailHandoff(ctx.d, ctx.codes, ctx.access, input, open, req);
      return { ...ctx, code, opened, open, redeem };
    }

    it("opens the person's own mailbox once, with the verifier from the same browser, and audits success", async () => {
      const { s, code, opened, redeem } = await minted();
      expect(await redeem({ code, verifier })).toBe("webmail-session");
      expect(opened).toEqual([
        {
          accountId: ACCOUNT_A,
          mailboxId: MBX_OWN,
          address: "kid@family.test",
          externalId: "s-dddd",
          console: { userId: "member", sessionId: SESSION },
        },
      ]);
      expect(s.audit.at(-1)).toMatchObject({
        action: "webmail.handoff_redeemed",
        result: "success",
        actor: { type: "user", userId: "member" },
        target: { id: MBX_OWN, label: "kid@family.test" },
      });
      // The credential was made under the mailbox's credential lock.
      expect(s.credentialLocks).toEqual([MBX_OWN]);
      // Once only.
      await expect(redeem({ code, verifier })).rejects.toMatchObject({ code: "handoff_invalid" });
      expect(opened).toHaveLength(1);
      expect(JSON.stringify(s.audit)).not.toContain(code);
      expect(JSON.stringify(s.audit)).not.toContain(verifier);
    });

    it("is useless from another browser (no matching verifier) and burns the code", async () => {
      const { s, code, opened, redeem } = await minted();
      await expect(redeem({ code, verifier: newHandoffVerifier() })).rejects.toMatchObject({ reason: "wrong_browser" });
      expect(s.audit.at(-1)).toMatchObject({
        action: "webmail.handoff_redeemed",
        result: "denied",
        errorCode: "wrong_browser",
      });
      await expect(redeem({ code, verifier })).rejects.toMatchObject({ code: "handoff_invalid" });
      expect(opened).toEqual([]);
    });

    it("refuses malformed input and unknown codes without an audit row", async () => {
      const { s, redeem } = await minted();
      const before = s.audit.length;
      await expect(redeem({ code: "x", verifier })).rejects.toBeInstanceOf(WebmailHandoffError);
      await expect(redeem({ code: newHandoffVerifier(), verifier })).rejects.toMatchObject({ code: "handoff_invalid" });
      await expect(redeem({})).rejects.toMatchObject({ code: "handoff_invalid" });
      expect(s.audit.length).toBe(before);
    });

    it("without a verifier (another browser) refuses, audits it and uses the code up", async () => {
      const { s, code, opened, redeem } = await minted();
      await expect(redeem({ code })).rejects.toMatchObject({ code: "handoff_refused", reason: "wrong_browser" });
      expect(s.audit.at(-1)).toMatchObject({ result: "denied", errorCode: "wrong_browser" });
      await expect(redeem({ code, verifier })).rejects.toMatchObject({ code: "handoff_invalid" });
      expect(opened).toEqual([]);
    });

    it("needs a fresh step-up when minting and still when redeeming", async () => {
      const a = setup();
      a.s.stepUps = [];
      await expect(
        startWebmailHandoff(
          a.d,
          a.codes,
          a.access,
          member,
          ACCOUNT_A,
          MBX_OWN,
          { challenge },
          { sessionId: SESSION },
          req,
        ),
      ).rejects.toMatchObject({ code: "step_up_required" });
      expect(a.codes.size()).toBe(0);
      expect(a.s.audit.at(-1)).toMatchObject({ result: "denied", errorCode: "step_up_required" });
      // A step-up for another console session of the same person doesn't count.
      a.s.stepUps.push({ userId: "member", sessionId: "other-session", expiresAt: new Date("2026-10-29T12:05:00Z") });
      await expect(
        startWebmailHandoff(
          a.d,
          a.codes,
          a.access,
          member,
          ACCOUNT_A,
          MBX_OWN,
          { challenge },
          { sessionId: SESSION },
          req,
        ),
      ).rejects.toMatchObject({ code: "step_up_required" });

      const b = setup();
      const { code, opened, redeem } = await minted(b);
      b.s.stepUps = [];
      await expect(redeem({ code, verifier })).rejects.toMatchObject({ reason: "step_up_required" });
      expect(opened).toEqual([]);
    });

    it("refuses after 60 seconds", async () => {
      const ctx = setup();
      const { code, opened, redeem } = await minted(ctx);
      ctx.clock.set(new Date("2026-10-29T12:01:01Z"));
      await expect(redeem({ code, verifier })).rejects.toMatchObject({ code: "handoff_invalid" });
      expect(opened).toEqual([]);
    });

    it("refuses an expired grant the store still returned (clock skew), audited", async () => {
      const ctx = setup();
      const { code } = await minted(ctx);
      const late = {
        put: (k: string, g: HandoffGrant, ttl: number) => ctx.codes.put(k, g, ttl),
        take: async (k: string) => {
          const g = await ctx.codes.take(k);
          return g ? { ...g, expiresAt: ctx.clock.now().getTime() - 1 } : null;
        },
      };
      await expect(
        redeemWebmailHandoff(ctx.d, late, ctx.access, { code, verifier }, async () => "x", req),
      ).rejects.toMatchObject({ reason: "expired" });
      expect(ctx.s.audit.at(-1)).toMatchObject({ result: "denied", errorCode: "expired" });
    });

    it("refuses when the console session ended or now has support access open", async () => {
      const ctx = setup();
      const { code, redeem } = await minted(ctx);
      ctx.s.sessions = ctx.s.sessions.filter((x) => x.userId !== "member");
      await expect(redeem({ code, verifier })).rejects.toMatchObject({ reason: "session_ended" });
      expect(ctx.s.audit.at(-1)).toMatchObject({
        result: "denied",
        errorCode: "session_ended",
        actor: { type: "system" },
        scope: `account:${ACCOUNT_A}`,
        meta: { userId: "member" },
      });

      const ctx2 = setup();
      const second = await minted(ctx2);
      ctx2.s.actAsSessions.push({
        id: "act-1",
        staffUserId: "member",
        staffRole: "support_admin",
        authSessionId: SESSION,
        accountId: ACCOUNT_B,
        reason: "ticket",
        startedAt: new Date("2026-10-29T11:59:00Z"),
        expiresAt: new Date("2026-10-29T13:00:00Z"),
        endedAt: null,
        endReason: null,
      });
      await expect(second.redeem({ code: second.code, verifier })).rejects.toBeInstanceOf(ForbiddenError);
      expect(ctx2.s.audit.at(-1)).toMatchObject({ result: "denied", errorCode: "act_as" });
    });

    it("re-checks the person, the account and the mailbox at that moment", async () => {
      // Person suspended by staff since the code was minted: their console session no longer counts.
      const a = setup();
      const one = await minted(a);
      a.s.suspended.push("member");
      await expect(one.redeem({ code: one.code, verifier })).rejects.toMatchObject({ reason: "session_ended" });
      expect(one.opened).toEqual([]);

      // Removed from the account: it doesn't exist for them any more.
      const b = setup();
      const two = await minted(b);
      b.s.memberships = b.s.memberships.filter((m) => !(m.userId === "member" && m.accountId === ACCOUNT_A));
      await expect(two.redeem({ code: two.code, verifier })).rejects.toBeInstanceOf(NotFoundError);

      // Mailbox handed to someone else, suspended, waiting for a password change, or blocked by the gate.
      for (const change of [
        (m: Mailbox) => (m.userId = "owner"),
        (m: Mailbox) => (m.status = "suspended"),
        (m: Mailbox) => (m.mustChangePassword = true),
      ]) {
        const c = setup();
        const three = await minted(c);
        const m = c.s.mailboxes.find((x) => x.id === MBX_OWN);
        if (m) change(m);
        await expect(three.redeem({ code: three.code, verifier })).rejects.toBeInstanceOf(WebmailHandoffError);
        expect(three.opened).toEqual([]);
      }
      const e = setup();
      const four = await minted(e);
      e.states.set("kid@family.test", "deleting");
      await expect(four.redeem({ code: four.code, verifier })).rejects.toMatchObject({ reason: "mailbox_unavailable" });
      expect(e.s.audit.at(-1)).toMatchObject({ errorCode: "mailbox_unavailable", meta: { state: "deleting" } });

      // An account requirement since the code was minted (two-factor, which this person hasn't set up): the console's
      // enrolment gate refuses, as it would on their next console request.
      const f = setup();
      const five = await minted(f);
      const acct = f.s.accounts.find((x) => x.id === ACCOUNT_A);
      if (acct) acct.signInPolicy = "two_factor";
      await expect(five.redeem({ code: five.code, verifier })).rejects.toMatchObject({ code: "enrolment_required" });
      expect(five.opened).toEqual([]);
    });

    it("audits a mail-server failure as failed and passes the error on", async () => {
      const ctx = setup();
      const { code } = await minted(ctx);
      await expect(
        redeemWebmailHandoff(
          ctx.d,
          ctx.codes,
          ctx.access,
          { code, verifier },
          async () => {
            throw new Error("mail server unavailable");
          },
          req,
        ),
      ).rejects.toThrow("mail server unavailable");
      expect(ctx.s.audit.at(-1)).toMatchObject({ action: "webmail.handoff_redeemed", result: "failed" });
    });
  });
});
