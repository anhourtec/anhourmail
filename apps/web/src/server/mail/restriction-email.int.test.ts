// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The restriction notice (ADR-0034 build slice 19) through the real send path: Trust & Safety restricts an account
 * with the trust service, the route's sender emails who it names, and the notice to its Owner lands in Mailpit (dev
 * and CI only: the transport is Mailpit's SMTP, so nothing leaves the machine) with the reason category and the appeal
 * address, never the staff note. A second restriction the same day sends nothing more. With the mail server down, the
 * sender retries, gives up, records `trust.restriction_notice_failed`, and the next restriction that day is emailed.
 */
import { randomBytes } from "node:crypto";
import net from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createMailer } from "@anhourmail/adapters/mail";
import { memoryBreachedPasswords, MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import { type Actor, systemClock } from "@anhourmail/core";
import { setAccountTier } from "@anhourmail/core/trust";
import { memoryCounter } from "@anhourmail/server/rate-limit";
import { PUBLIC_PLATFORM, SUPPORT_EMAIL } from "@anhourmail/shared/platform";

import { container, setContainerForTests } from "../container";
import { resetEnvForTests } from "../env";

import { sendRestrictionNotices, setRestrictionNoticeRetryForTests } from "./restriction-email";

const MAILPIT = `http://localhost:${process.env.MAILPIT_UI_PORT ?? "43026"}`;
const TRANSPORT = process.env.MAIL_TRANSPORT_URL ?? `smtp://127.0.0.1:${process.env.MAILPIT_SMTP_PORT ?? "43125"}`;
const APP = "http://localhost:43200";
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const run = randomBytes(4).toString("hex");
const OWNER = `owner-${run}@restriction-notice.test`;
/** A second account for the outage case, with its own Owner. */
const ACCOUNT_2 = "22222222-2222-4222-8222-222222222222";
const OWNER_2 = `owner2-${run}@restriction-notice.test`;
const NOTE = `Internal note ${run}: never in the email.`;

const staff: Actor = {
  kind: "user",
  userId: "staff-ts",
  email: "staff-ts@anhourtec.test",
  platformRoles: ["trust_safety_admin"],
  memberships: [],
  suspended: false,
};

type Found = { ID: string; Subject: string; To: { Address: string }[] };

/** Mailpit messages to `to`, polled for up to `ms`. */
async function caught(to: string, ms = 10_000): Promise<Found[]> {
  const until = Date.now() + ms;
  for (;;) {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const found = ((await r.json()) as { messages?: Found[] }).messages ?? [];
    if (found.length > 0 || Date.now() > until) return found;
    await new Promise((res) => setTimeout(res, 500));
  }
}

const req = { requestId: `int-notice-${run}`, ip: null, userAgent: "vitest" };

/** What the route does: the service, then the notice to whoever it names. */
async function restrict(tier: string, reason: string, accountId = ACCOUNT): Promise<number> {
  const out = await setAccountTier(
    container().deps,
    staff,
    accountId,
    { tier, reason, note: NOTE },
    { sessionId: "session-1" },
    req,
  );
  if (out.reason !== null) {
    await sendRestrictionNotices(
      out.notice,
      out.notify.map((n) => n.email),
      { reason: out.reason },
      req,
    );
  }
  return out.notify.length;
}

/** A local port nothing listens on (bound, then closed): the mail server is down. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((res) => {
    server.close(() => {
      res();
    });
  });
  return port;
}

describe("the restriction notice lands in Mailpit", () => {
  const mailer = createMailer({
    url: TRANSPORT,
    from: process.env.MAIL_FROM ?? "AnhourMail <no-reply@anhourmail.test>",
  });
  let uow: MemoryUnitOfWork;
  const use = (m: typeof mailer) => {
    setContainerForTests({
      deps: { uow, clock: systemClock, platform: PUBLIC_PLATFORM },
      counter: memoryCounter(),
      mailer: m,
      dns: { lookup: async () => [] },
      passwords: { hash: async () => "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA" },
      breaches: memoryBreachedPasswords(),
    });
  };
  beforeAll(() => {
    setRestrictionNoticeRetryForTests([50, 50]);
    vi.stubEnv("APP_URL", APP);
    resetEnvForTests();
    uow = new MemoryUnitOfWork();
    const at = new Date("2026-11-01T00:00:00Z");
    uow.state.accounts.push({ id: ACCOUNT, name: "Notice test", plan: "free", createdAt: at });
    uow.state.accounts.push({ id: ACCOUNT_2, name: "Outage test", plan: "free", createdAt: at });
    uow.state.memberships.push(
      { userId: "owner-1", accountId: ACCOUNT, role: "owner" },
      { userId: "owner-2", accountId: ACCOUNT_2, role: "owner" },
    );
    uow.state.userEmails["owner-1"] = OWNER;
    uow.state.userEmails["owner-2"] = OWNER_2;
    uow.state.stepUps.push({ userId: "staff-ts", sessionId: "session-1", expiresAt: new Date("2099-01-01") });
    use(mailer);
  });
  afterAll(() => {
    setRestrictionNoticeRetryForTests(null);
    setContainerForTests(null);
    vi.unstubAllEnvs();
    resetEnvForTests();
  });

  it("restricting the account emails the Owner the reason and the appeal address, once a day", async () => {
    expect(await restrict("restricted", "spam")).toBe(1);
    const found = await caught(OWNER);
    expect(found.map((m) => m.Subject)).toEqual(["Sending from your AnhourMail account is paused"]);
    const id = found[0]?.ID ?? "";
    // Decoded by Mailpit (text and HTML parts), so an encoded line break can't hide the note.
    const msg = (await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as { Text: string; HTML: string };
    for (const part of [msg.Text, msg.HTML]) {
      expect(part).toContain("Sending spam");
      expect(part).toContain(SUPPORT_EMAIL);
      expect(part).not.toContain("Internal note");
    }

    // Lifted and restricted again the same day: nothing more is sent.
    expect(await restrict("standard", "other")).toBe(0);
    expect(await restrict("restricted", "spam")).toBe(0);
    await new Promise((res) => setTimeout(res, 2_000));
    expect(await caught(OWNER, 0)).toHaveLength(1);
  });

  it("with the mail server down: retried, given up, recorded, and the next restriction that day is emailed", async () => {
    use(
      createMailer({
        url: `smtp://127.0.0.1:${String(await closedPort())}`,
        from: "AnhourMail <no-reply@anhourmail.test>",
      }),
    );
    expect(await restrict("restricted", "abuse", ACCOUNT_2)).toBe(1);
    const failed = uow.state.audit.filter((e) => e.action === "trust.restriction_notice_failed");
    expect(failed.map((e) => [e.scope, e.meta])).toEqual([
      [`account:${ACCOUNT_2}`, expect.objectContaining({ restricted: "account", notified: 1, delivered: 0 })],
    ]);
    expect(JSON.stringify(failed)).not.toContain(OWNER_2);
    expect(await caught(OWNER_2, 0)).toEqual([]);

    // The mail server is back: lifted and restricted again the same day, the Owner is told this time.
    use(mailer);
    await restrict("standard", "other", ACCOUNT_2);
    expect(await restrict("restricted", "abuse", ACCOUNT_2)).toBe(1);
    expect((await caught(OWNER_2)).map((m) => m.Subject)).toEqual(["Sending from your AnhourMail account is paused"]);
  });
});
