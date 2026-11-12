// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Trust tier routes (ADR-0034 slice 14) in memory: the staff read and tier change, the mailbox sending restriction and
 * the customer read, each answering per the matrix — 401 signed out, 403 without the permission (or acting as, or
 * without a fresh step-up), 404 for another account's mailbox or an unknown account, 422 `tier_unavailable`, 409 when
 * nothing changes, 429 past the fail-closed `staffTrust` tier — and the managed-script pause scheduled after a change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryMailer } from "@anhourmail/adapters/mail";
import { memoryBreachedPasswords, MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import { type Actor, systemClock } from "@anhourmail/core";
import { setLogSinkForTests } from "@anhourmail/server/log";
import { callerKey, checkRateLimit, type Counter, LIMITS, memoryCounter } from "@anhourmail/server/rate-limit";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

import { GET as customerSendingRoute } from "@/app/api/accounts/[accountId]/sending/route";
import { PUT as restrictRoute } from "@/app/api/platform/accounts/[accountId]/mailboxes/[mailboxId]/sending/route";
import { GET as staffTrustRoute, PUT as setTierRoute } from "@/app/api/platform/accounts/[accountId]/trust/route";

import { setContainerForTests } from "./container";
import { resetEnvForTests } from "./env";
import { setRestrictionNoticeRetryForTests } from "./mail/restriction-email";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const MAILBOX = "33333333-3333-4333-8333-333333333333";
const OTHER_MAILBOX = "44444444-4444-4444-8444-444444444444";
const APP = "http://localhost:43200";
const SESSION = "session-1";

const staff = (id: string, role: "global_admin" | "trust_safety_admin" | "support_admin" | "billing_admin"): Actor => ({
  kind: "user",
  userId: id,
  email: `${id}@anhourtec.test`,
  platformRoles: [role],
  memberships: [],
  suspended: false,
});
const person = (id: string, accountId: string, role: "owner" | "member"): Actor => ({
  kind: "user",
  userId: id,
  email: `${id}@example.test`,
  platformRoles: [],
  memberships: [{ accountId, role }],
  suspended: false,
});
const trustSafety = staff("staff-ts", "trust_safety_admin");
const global = staff("staff-ga", "global_admin");
const support = staff("staff-support", "support_admin");
const billing = staff("staff-billing", "billing_admin");
const owner = person("owner-1", ACCOUNT, "owner");
const member = person("member-1", ACCOUNT, "member");
const outsider = person("outsider-1", OTHER, "owner");
const actingAs: Actor = {
  kind: "user",
  userId: "staff-ga",
  email: "staff-ga@anhourtec.test",
  platformRoles: ["global_admin"],
  suspended: false,
  memberships: [{ accountId: ACCOUNT, role: "owner" }],
  actingAs: {
    sessionId: "act-1",
    accountId: ACCOUNT,
    staffUserId: "staff-ga",
    staffEmail: "staff-ga@anhourtec.test",
    staffRole: "global_admin",
    reason: "ticket",
    expiresAt: new Date(Date.now() + 600_000),
  },
};
let actor: Actor = trustSafety;

vi.mock("@/server/auth/actor", () => ({
  getActor: async () => actor,
  getActorAndSession: async () => ({ actor, sessionId: actor.kind === "user" ? SESSION : null }),
}));

const scheduled: string[] = [];
vi.mock("@/server/webmail/sending-pause-apply", () => ({
  scheduleSendingPause: (accountId: string) => {
    scheduled.push(accountId);
  },
}));

let uow: MemoryUnitOfWork;
let counter: Counter;
let mailer: ReturnType<typeof memoryMailer>;

beforeEach(() => {
  vi.stubEnv("APP_URL", APP);
  vi.stubEnv("WEBMAIL_URL", "http://localhost:43300");
  vi.stubEnv("SITE_URL", "http://localhost:43100");
  vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(40));
  vi.stubEnv("DATABASE_URL", "postgres://unused");
  vi.stubEnv("REDIS_URL", "redis://unused");
  vi.stubEnv("MAIL_TRANSPORT_URL", "smtp://unused");
  vi.stubEnv("MAIL_FROM", "AnhourMail <no-reply@example.test>");
  vi.stubEnv("RATE_LIMIT_MULTIPLIER", "1");
  resetEnvForTests();
  uow = new MemoryUnitOfWork();
  const at = new Date("2026-11-01T00:00:00Z");
  uow.state.accounts.push({ id: ACCOUNT, name: "Acme", plan: "free", createdAt: at });
  uow.state.accounts.push({ id: OTHER, name: "Other", plan: "free", createdAt: at });
  const box = (id: string, accountId: string, address: string) => ({
    id,
    accountId,
    userId: null,
    address,
    status: "active" as const,
    quotaBytes: 1,
    stalwartId: `s-${id}`,
    lastError: null,
    purgeAfter: null,
    createdAt: at,
  });
  uow.state.mailboxes.push(box(MAILBOX, ACCOUNT, "me@acme.test"), box(OTHER_MAILBOX, OTHER, "you@other.test"));
  for (const a of [trustSafety, global, support, billing, owner]) {
    if (a.kind !== "user") continue;
    uow.state.userEmails[a.userId] = a.email;
    uow.state.stepUps.push({ userId: a.userId, sessionId: SESSION, expiresAt: new Date("2099-01-01") });
  }
  counter = memoryCounter();
  mailer = memoryMailer();
  setContainerForTests({
    deps: { uow, clock: systemClock, platform: PUBLIC_PLATFORM },
    counter,
    mailer,
    dns: { lookup: async () => [] },
    passwords: { hash: async () => "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA" },
    breaches: memoryBreachedPasswords(),
  });
  actor = trustSafety;
  scheduled.length = 0;
  setLogSinkForTests(() => undefined);
});
afterEach(() => {
  setContainerForTests(null);
  setLogSinkForTests(null);
  vi.unstubAllEnvs();
  resetEnvForTests();
});

const accountParams = (accountId = ACCOUNT) => ({ params: Promise.resolve({ accountId }) });
const mailboxParams = (accountId = ACCOUNT, mailboxId = MAILBOX) => ({
  params: Promise.resolve({ accountId, mailboxId }),
});
const put = (path: string, body: unknown) =>
  new Request(`${APP}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: APP, host: "localhost:43200" },
    body: JSON.stringify(body),
  });
const get = (path: string) => new Request(`${APP}${path}`, { headers: { host: "localhost:43200" } });
const json = async (res: Response) =>
  (await res.json()) as { data?: Record<string, unknown>; error?: { code: string; message: string } };

const NOTE = "Complaints from three recipients; see the abuse ticket.";
const setTier = (body: unknown, accountId = ACCOUNT) =>
  setTierRoute(put(`/api/platform/accounts/${accountId}/trust`, body), accountParams(accountId));
const restrict = (body: unknown, accountId = ACCOUNT, mailboxId = MAILBOX) =>
  restrictRoute(
    put(`/api/platform/accounts/${accountId}/mailboxes/${mailboxId}/sending`, body),
    mailboxParams(accountId, mailboxId),
  );

describe("PUT /api/platform/accounts/:accountId/trust", () => {
  it("Trust & Safety restricts an account: 200, mailboxes queued, the script pause scheduled, the note never answered", async () => {
    const res = await setTier({ tier: "restricted", reason: "spam", note: NOTE });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data).toEqual({ tier: "restricted", from: "new", source: "staff", reason: "spam", mailboxesQueued: 1 });
    expect(JSON.stringify(body)).not.toContain("abuse ticket");
    expect(scheduled).toEqual([ACCOUNT]);
    expect(uow.state.jobs.map((j) => [j.kind, j.subjectId])).toEqual([["mailbox.ensure", MAILBOX]]);
    expect(uow.state.audit.filter((e) => e.action === "trust.restricted").map((e) => e.scope)).toEqual([
      `account:${ACCOUNT}`,
      "platform",
    ]);
    expect(JSON.stringify(uow.state.audit)).not.toContain("abuse ticket");
    // A Global Administrator lifts it back to standard (a reason is needed to leave restricted).
    actor = global;
    expect((await setTier({ tier: "standard", note: NOTE })).status).toBe(400);
    expect((await setTier({ tier: "standard", reason: "other", note: NOTE })).status).toBe(200);
    expect(scheduled).toEqual([ACCOUNT, ACCOUNT]);
  });

  it("answers 401 signed out and 403 for staff without the permission and for customers; nothing changes", async () => {
    for (const [who, status] of [
      [{ kind: "anonymous" } as Actor, 401],
      [support, 403],
      [billing, 403],
      [owner, 403],
      [member, 403],
      [outsider, 403],
    ] as const) {
      actor = who;
      const res = await setTier({ tier: "standard", note: NOTE });
      expect({ who, status: res.status }).toEqual({ who, status });
    }
    expect(uow.state.trust).toEqual([]);
    expect(scheduled).toEqual([]);
  });

  it("refuses acting as someone and a missing step-up (403), trusted (422), unknown accounts (404), the same tier (409)", async () => {
    actor = actingAs;
    expect((await setTier({ tier: "standard", note: NOTE })).status).toBe(403);
    actor = trustSafety;
    uow.state.stepUps = [];
    const stale = await setTier({ tier: "standard", note: NOTE });
    expect(stale.status).toBe(403);
    expect((await json(stale)).error?.code).toBe("step_up_required");
    uow.state.stepUps.push({ userId: "staff-ts", sessionId: SESSION, expiresAt: new Date("2099-01-01") });
    const trusted = await setTier({ tier: "trusted", note: NOTE });
    expect(trusted.status).toBe(422);
    expect((await json(trusted)).error?.code).toBe("tier_unavailable");
    expect((await setTier({ tier: "standard", note: NOTE }, "99999999-9999-4999-8999-999999999999")).status).toBe(404);
    expect((await setTier({ tier: "standard", note: NOTE }, "not-an-id")).status).toBe(404);
    expect((await setTier({ tier: "standard", note: NOTE })).status).toBe(200);
    expect((await setTier({ tier: "standard", note: NOTE })).status).toBe(409);
    expect(scheduled).toEqual([ACCOUNT]);
  });

  it("answers 400 for a body it can't use, after the permission check", async () => {
    expect((await setTier({ tier: "standard" })).status).toBe(400);
    expect((await setTier({ tier: "gold", note: NOTE })).status).toBe(400);
    expect((await setTier({ tier: 7, note: NOTE })).status).toBe(400);
    expect((await setTier({ tier: "restricted", automatic: true, reason: "spam", note: NOTE })).status).toBe(400);
    actor = support;
    expect((await setTier({ tier: 7 })).status).toBe(403);
  });

  it("is limited per staff member by the fail-closed staffTrust tier (429)", async () => {
    for (let i = 0; i < LIMITS.staffTrust.limit; i++) {
      await checkRateLimit(
        counter,
        "staffTrust:PUT /api/platform/accounts/:accountId/trust",
        LIMITS.staffTrust,
        callerKey(null, null),
      );
    }
    const res = await setTier({ tier: "standard", note: NOTE });
    expect(res.status).toBe(429);
    expect(LIMITS.staffTrust.failMode).toBe("closed");
    expect(scheduled).toEqual([]);
  });
});

describe("the restriction notice (ADR-0034 build slice 19)", () => {
  beforeEach(() => {
    uow.state.memberships.push(
      { userId: "owner-1", accountId: ACCOUNT, role: "owner" },
      { userId: "member-1", accountId: ACCOUNT, role: "member" },
    );
    uow.state.userEmails["member-1"] = "member-1@example.test";
    setRestrictionNoticeRetryForTests([1, 1]);
  });
  afterEach(() => {
    setRestrictionNoticeRetryForTests(null);
  });

  /** The notice goes out after the answer: give the background send a moment. */
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const failures = () => uow.state.audit.filter((e) => e.action === "trust.restriction_notice_failed");

  it("restricting the account emails its Owner the reason and the appeal address, never the note; once a day", async () => {
    expect((await setTier({ tier: "restricted", reason: "spam", note: NOTE })).status).toBe(200);
    await vi.waitFor(() => {
      expect(mailer.sent.map((m) => m.to)).toEqual(["owner-1@example.test"]);
    });
    const mail = mailer.sent[0];
    expect(mail?.subject).toBe("Sending from your AnhourMail account is paused");
    expect(mail?.text).toContain('Reason: "Sending spam"');
    expect(mail?.text).toContain("support@");
    expect(`${mail?.text ?? ""}${mail?.html ?? ""}`).not.toContain("abuse ticket");
    expect(uow.state.audit.filter((e) => e.action === "trust.restriction_notice_sent")).toHaveLength(1);
    // Lifted and restricted again the same day: nobody is emailed again.
    expect((await setTier({ tier: "standard", reason: "other", note: NOTE })).status).toBe(200);
    expect((await setTier({ tier: "restricted", reason: "spam", note: NOTE })).status).toBe(200);
    await settle();
    expect(mailer.sent).toHaveLength(1);
    expect(failures()).toEqual([]);
  });

  it("a mailbox restriction after the account's is still emailed (each kind has its own daily cap)", async () => {
    expect((await setTier({ tier: "restricted", reason: "spam", note: NOTE })).status).toBe(200);
    expect((await restrict({ restricted: true, reason: "abuse", note: NOTE })).status).toBe(200);
    await vi.waitFor(() => {
      expect(mailer.sent.map((m) => m.subject)).toEqual([
        "Sending from your AnhourMail account is paused",
        "Sending from one of your mailboxes is paused",
      ]);
    });
  });

  it("restricting one mailbox emails the Owner which mailbox and why; lifting it emails nobody", async () => {
    expect((await restrict({ restricted: true, reason: "abuse", note: NOTE })).status).toBe(200);
    await vi.waitFor(() => {
      expect(mailer.sent.map((m) => [m.to, m.subject])).toEqual([
        ["owner-1@example.test", "Sending from one of your mailboxes is paused"],
      ]);
    });
    expect(mailer.sent[0]?.text).toContain('Mailbox: "me@acme.test"');
    expect((await restrict({ restricted: false, reason: "other", note: NOTE })).status).toBe(200);
    await settle();
    expect(mailer.sent).toHaveLength(1);
  });

  it("a refused change emails nobody", async () => {
    actor = support;
    expect((await setTier({ tier: "restricted", reason: "spam", note: NOTE })).status).toBe(403);
    await settle();
    expect(mailer.sent).toEqual([]);
  });

  it("a mail server that refuses for a moment: retried, delivered, nothing recorded as failed", async () => {
    const logged: string[] = [];
    setLogSinkForTests((line) => logged.push(line));
    const send = mailer.send.bind(mailer);
    let refusals = 1;
    mailer.send = (m) => (refusals-- > 0 ? Promise.reject(new TypeError("smtp down")) : send(m));
    expect((await setTier({ tier: "restricted", reason: "spam", note: NOTE })).status).toBe(200);
    await vi.waitFor(() => {
      expect(mailer.sent.map((m) => m.to)).toEqual(["owner-1@example.test"]);
    });
    await settle();
    expect(failures()).toEqual([]);
    expect(logged.join("\n")).toContain("restriction notice retrying");
    expect(logged.join("\n")).not.toContain("owner-1@");
  });

  it("a mailer outage: 200 at once, three tries, the give-up audited, and the next restriction that day emails again", async () => {
    const logged: string[] = [];
    setLogSinkForTests((line) => logged.push(line));
    const send = mailer.send.bind(mailer);
    let tries = 0;
    mailer.send = () => {
      tries += 1;
      return Promise.reject(new TypeError("smtp down"));
    };
    expect((await setTier({ tier: "restricted", reason: "spam", note: NOTE })).status).toBe(200);
    await vi.waitFor(() => {
      expect(failures()).toHaveLength(1);
    });
    expect(tries).toBe(3);
    const sent = uow.state.audit.find((e) => e.action === "trust.restriction_notice_sent");
    expect(failures()[0]).toMatchObject({
      scope: `account:${ACCOUNT}`,
      actor: { type: "system" },
      target: { type: "account", id: ACCOUNT },
      requestId: sent?.requestId,
      ip: null,
      userAgent: null,
      meta: { noticeId: sent?.meta.noticeId, restricted: "account", notified: 1, delivered: 0 },
    });
    expect(JSON.stringify(failures())).not.toContain("owner-1@");
    expect(logged.join("\n")).toContain("restriction notice failed");
    expect(logged.join("\n")).not.toContain("owner-1@");

    // The mailer is back; lifted and restricted again the same day: the undelivered notice didn't count.
    mailer.send = send;
    expect((await setTier({ tier: "standard", reason: "other", note: NOTE })).status).toBe(200);
    expect((await setTier({ tier: "restricted", reason: "spam", note: NOTE })).status).toBe(200);
    await vi.waitFor(() => {
      expect(mailer.sent.map((m) => m.to)).toEqual(["owner-1@example.test"]);
    });
    await settle();
    expect(failures()).toHaveLength(1);
  });
});

describe("PUT /api/platform/accounts/:accountId/mailboxes/:mailboxId/sending", () => {
  it("restricts and lifts one mailbox (each with a reason and a note) and schedules the pause", async () => {
    const res = await restrict({ restricted: true, reason: "abuse", note: NOTE });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ address: "me@acme.test", restricted: true, reason: "abuse" });
    expect(scheduled).toEqual([ACCOUNT]);
    expect((await restrict({ restricted: true, reason: "abuse", note: NOTE })).status).toBe(409);
    expect((await restrict({ restricted: false, reason: "other", note: NOTE })).status).toBe(200);
    expect(scheduled).toEqual([ACCOUNT, ACCOUNT]);
  });

  it("404 for another account's mailbox or an unknown one; 403 without the permission or acting as; 401 signed out", async () => {
    const body = { restricted: true, reason: "spam", note: NOTE };
    expect((await restrict(body, ACCOUNT, OTHER_MAILBOX)).status).toBe(404);
    expect((await restrict(body, OTHER, MAILBOX)).status).toBe(404);
    expect((await restrict(body, ACCOUNT, "nope")).status).toBe(404);
    for (const [who, status] of [
      [support, 403],
      [owner, 403],
      [actingAs, 403],
      [{ kind: "anonymous" } as Actor, 401],
    ] as const) {
      actor = who;
      expect((await restrict(body)).status).toBe(status);
    }
    expect(uow.state.mailboxRestrictions).toEqual([]);
    expect(scheduled).toEqual([]);
  });

  it("400 without a reason or a note", async () => {
    expect((await restrict({ restricted: true, note: NOTE })).status).toBe(400);
    expect((await restrict({ restricted: true, reason: "spam" })).status).toBe(400);
    expect((await restrict({ reason: "spam", note: NOTE })).status).toBe(400);
  });
});

describe("GET /api/platform/accounts/:accountId/trust", () => {
  it("shows the tier and each mailbox to staff who read accounts; notes only to those who read suspension notes", async () => {
    await setTier({ tier: "restricted", reason: "spam", note: NOTE });
    actor = trustSafety;
    const withNotes = await json(
      await staffTrustRoute(get(`/api/platform/accounts/${ACCOUNT}/trust`), accountParams()),
    );
    expect(withNotes.data).toMatchObject({ tier: "restricted", source: "staff", reason: "spam", note: NOTE });
    expect(withNotes.data?.mailboxes).toEqual([{ mailboxId: MAILBOX, address: "me@acme.test", restriction: null }]);
    // Billing Administrators read accounts but not suspension notes.
    actor = billing;
    const plain = await staffTrustRoute(get(`/api/platform/accounts/${ACCOUNT}/trust`), accountParams());
    expect(plain.status).toBe(200);
    const data = (await json(plain)).data ?? {};
    expect(data).not.toHaveProperty("note");
    expect(JSON.stringify(data)).not.toContain("abuse ticket");
  });

  it("401 signed out, 403 for customers, 404 for an unknown account", async () => {
    for (const [who, status] of [
      [{ kind: "anonymous" } as Actor, 401],
      [owner, 403],
    ] as const) {
      actor = who;
      expect((await staffTrustRoute(get(`/api/platform/accounts/${ACCOUNT}/trust`), accountParams())).status).toBe(
        status,
      );
    }
    actor = trustSafety;
    const unknown = "99999999-9999-4999-8999-999999999999";
    expect((await staffTrustRoute(get(`/api/platform/accounts/${unknown}/trust`), accountParams(unknown))).status).toBe(
      404,
    );
  });
});

describe("GET /api/accounts/:accountId/sending", () => {
  it("shows the account's people the tier's published facts, never the staff note", async () => {
    actor = owner;
    const res = await customerSendingRoute(get(`/api/accounts/${ACCOUNT}/sending`), accountParams());
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ tier: "new", externalHeld: true, mailAppsCanSend: false });
    actor = trustSafety;
    await setTier({ tier: "restricted", reason: "spam", note: NOTE });
    actor = owner;
    const restricted = await json(await customerSendingRoute(get(`/api/accounts/${ACCOUNT}/sending`), accountParams()));
    expect(restricted.data).toMatchObject({ tier: "restricted", reason: { category: "spam" } });
    expect(JSON.stringify(restricted)).not.toContain("abuse ticket");
  });

  it("404 for another account, 403 for a Member (no account.read), 401 signed out", async () => {
    actor = outsider;
    expect((await customerSendingRoute(get(`/api/accounts/${ACCOUNT}/sending`), accountParams())).status).toBe(404);
    actor = member;
    expect((await customerSendingRoute(get(`/api/accounts/${ACCOUNT}/sending`), accountParams())).status).toBe(403);
    actor = { kind: "anonymous" };
    expect((await customerSendingRoute(get(`/api/accounts/${ACCOUNT}/sending`), accountParams())).status).toBe(401);
  });
});
