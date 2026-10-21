// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { deps as makeDeps, fixedClock } from "../__tests__/helpers";
import type { MailServer } from "./ports";
import { enqueueProvisioning, reconcile, runNextJob } from "./service";
import { backoffMs, MAX_ATTEMPTS } from "./types";

type Box = { address: string; quotaBytes: number; aliases: string[] };

function fakeMailServer(opts: { failTimes?: number } = {}): MailServer & { domains: string[]; boxes: Box[] } {
  let failures = opts.failTimes ?? 0;
  const state = { domains: [] as string[], boxes: [] as Box[] };
  return {
    ...state,
    ensureDomain: async (name) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("mail server unavailable");
      }
      if (!state.domains.includes(name)) state.domains.push(name);
      return { externalId: `dom:${name}` };
    },
    ensureMailbox: async ({ address, quotaBytes, aliases }) => {
      const existing = state.boxes.find((b) => b.address === address);
      const box = { address, quotaBytes, aliases: aliases.map((a) => a.address) };
      if (existing) Object.assign(existing, box);
      else state.boxes.push(box);
      return { externalId: `acc:${address}` };
    },
    removeDomain: async (name) => {
      if (state.boxes.some((b) => b.address.endsWith(`@${name}`))) throw new Error("domain still has mailboxes");
      state.domains = state.domains.filter((x) => x !== name);
    },
    listDomains: async () => [...state.domains],
    listMailboxes: async () => state.boxes.map((b) => ({ address: b.address, quotaBytes: b.quotaBytes })),
    get domains() {
      return state.domains;
    },
    get boxes() {
      return state.boxes;
    },
  };
}

function setup(clock = fixedClock("2026-10-21T12:00:00Z")) {
  const d = makeDeps(clock);
  d.uow.state.domains.push({
    id: "d1",
    accountId: "a1",
    name: "example.test",
    status: "active",
    verifyToken: "t",
    stalwartId: null,
    lastError: null,
    createdAt: clock.now(),
  });
  d.uow.state.mailboxes.push({
    id: "m1",
    accountId: "a1",
    userId: null,
    createdAt: new Date(0),
    address: "owner@example.test",
    quotaBytes: 1000,
    status: "provisioning",
    stalwartId: null,
    lastError: null,
    aliases: [{ address: "hello@example.test", kind: "alias", enabled: true, description: null }],
  });
  return { d, clock };
}

describe("provisioning jobs", () => {
  it("applies a domain and a mailbox (with aliases) and records the external ids", async () => {
    const { d } = setup();
    const mail = fakeMailServer();
    await enqueueProvisioning(d, { kind: "domain.ensure", subjectId: "d1" });
    await enqueueProvisioning(d, { kind: "mailbox.ensure", subjectId: "m1" });
    expect((await runNextJob(d, mail))?.kind).toBe("domain.ensure");
    expect((await runNextJob(d, mail))?.kind).toBe("mailbox.ensure");
    expect(await runNextJob(d, mail)).toBeNull();
    expect(mail.domains).toEqual(["example.test"]);
    expect(mail.boxes).toEqual([{ address: "owner@example.test", quotaBytes: 1000, aliases: ["hello@example.test"] }]);
    expect(d.uow.state.domains[0]?.stalwartId).toBe("dom:example.test");
    expect(d.uow.state.mailboxes[0]).toMatchObject({ status: "active", stalwartId: "acc:owner@example.test" });
    expect(d.uow.state.jobs.every((j) => j.status === "succeeded")).toBe(true);
    expect(d.uow.state.audit).toHaveLength(0);
  });

  it("retries with backoff, then succeeds", async () => {
    const { d, clock } = setup();
    const mail = fakeMailServer({ failTimes: 1 });
    await enqueueProvisioning(d, { kind: "domain.ensure", subjectId: "d1" });
    await runNextJob(d, mail);
    const job = d.uow.state.jobs[0];
    expect(job).toMatchObject({ status: "queued", attempts: 1, lastError: "Error: mail server unavailable" });
    expect(await runNextJob(d, mail)).toBeNull(); // not due yet
    clock.set(new Date(clock.now().getTime() + backoffMs(1)));
    await runNextJob(d, mail);
    expect(d.uow.state.jobs[0]?.status).toBe("succeeded");
  });

  it("gives up after the last attempt, marks the subject failed and audits it", async () => {
    const { d, clock } = setup();
    const mail = fakeMailServer({ failTimes: 99 });
    await enqueueProvisioning(d, { kind: "domain.ensure", subjectId: "d1" });
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await runNextJob(d, mail);
      clock.set(new Date(clock.now().getTime() + backoffMs(i + 1)));
    }
    expect(d.uow.state.jobs[0]).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
    expect(d.uow.state.domains[0]?.lastError).toContain("mail server unavailable");
    expect(d.uow.state.audit.map((e) => e.action)).toEqual(["platform.provisioning_failed"]);
  });

  it("refuses to provision an unverified domain", async () => {
    const { d } = setup();
    d.uow.state.domains[0]!.status = "pending_dns";
    const mail = fakeMailServer();
    await enqueueProvisioning(d, { kind: "domain.ensure", subjectId: "d1" });
    await runNextJob(d, mail);
    expect(mail.domains).toEqual([]);
    expect(d.uow.state.jobs[0]?.lastError).toContain("domain not verified");
  });

  it("keeps a suspended mailbox suspended", async () => {
    const { d } = setup();
    d.uow.state.mailboxes[0]!.status = "suspended";
    await enqueueProvisioning(d, { kind: "mailbox.ensure", subjectId: "m1" });
    await runNextJob(d, fakeMailServer());
    expect(d.uow.state.mailboxes[0]?.status).toBe("suspended");
  });

  it("fails a job whose subject no longer exists", async () => {
    const { d } = setup();
    await enqueueProvisioning(d, { kind: "mailbox.ensure", subjectId: "missing" });
    await runNextJob(d, fakeMailServer());
    expect(d.uow.state.jobs[0]?.lastError).toContain("mailbox not found");
  });

  it("marks a mailbox failed after giving up", async () => {
    const { d, clock } = setup();
    const mail: MailServer = { ...fakeMailServer(), ensureMailbox: () => Promise.reject(new Error("quota refused")) };
    await enqueueProvisioning(d, { kind: "mailbox.ensure", subjectId: "m1" });
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await runNextJob(d, mail);
      clock.set(new Date(clock.now().getTime() + backoffMs(i + 1)));
    }
    expect(d.uow.state.mailboxes[0]).toMatchObject({ status: "failed" });
  });
});

describe("reconcile", () => {
  it("is clean when the mail server matches, and writes no audit", async () => {
    const { d } = setup();
    d.uow.state.mailboxes[0]!.status = "active";
    const mail = fakeMailServer();
    await mail.ensureDomain("example.test");
    await mail.ensureMailbox({ externalId: null, address: "owner@example.test", quotaBytes: 1000, aliases: [] });
    const report = await reconcile(d, mail);
    expect(report.clean).toBe(true);
    expect(d.uow.state.audit).toHaveLength(0);
  });

  it("reports missing, unknown and quota drift, audits counts only, and deletes nothing", async () => {
    const { d } = setup();
    d.uow.state.mailboxes[0]!.status = "active";
    const mail = fakeMailServer();
    await mail.ensureDomain("stray.test");
    await mail.ensureDomain("dev.test");
    await mail.ensureMailbox({ externalId: null, address: "ghost@stray.test", quotaBytes: 5, aliases: [] });
    await mail.ensureMailbox({ externalId: null, address: "alice@dev.test", quotaBytes: 5, aliases: [] });
    await mail.ensureDomain("example.test");
    await mail.ensureMailbox({ externalId: null, address: "owner@example.test", quotaBytes: 999, aliases: [] });
    const report = await reconcile(d, mail, { ignoreDomains: ["dev.test"] });
    expect(report).toMatchObject({
      clean: false,
      missingOnMailServer: { domains: [], mailboxes: [] },
      unknownOnMailServer: { domains: ["stray.test"], mailboxes: ["ghost@stray.test"] },
      quotaMismatch: [{ address: "owner@example.test", desired: 1000, actual: 999 }],
    });
    expect(mail.boxes).toHaveLength(3); // nothing deleted
    const [entry] = d.uow.state.audit;
    expect(entry?.action).toBe("platform.reconciler_drift");
    expect(JSON.stringify(entry?.meta)).not.toContain("ghost@");
  });

  it("treats domains of desired mailboxes as desired (platform domains)", async () => {
    const { d } = setup();
    d.uow.state.mailboxes.push({
      id: "m2",
      accountId: "a1",
      userId: null,
      createdAt: new Date(0),
      address: "free@platform.test",
      quotaBytes: 10,
      status: "active",
      stalwartId: null,
      lastError: null,
      aliases: [],
    });
    const mail = fakeMailServer();
    await mail.ensureDomain("platform.test");
    const report = await reconcile(d, mail);
    expect(report.unknownOnMailServer.domains).not.toContain("platform.test");
  });

  it("reports desired objects missing on the mail server", async () => {
    const { d } = setup();
    d.uow.state.mailboxes[0]!.status = "active";
    const report = await reconcile(d, fakeMailServer());
    expect(report.missingOnMailServer).toEqual({ domains: ["example.test"], mailboxes: ["owner@example.test"] });
  });
});

describe("domain removal job", () => {
  it("takes a removing domain off the mail server, then deletes its row; skips ensure for it", async () => {
    const { d } = setup();
    d.uow.state.mailboxes = [];
    const mail = fakeMailServer();
    await enqueueProvisioning(d, { kind: "domain.ensure", subjectId: "d1" });
    await runNextJob(d, mail);
    expect(mail.domains).toEqual(["example.test"]);

    d.uow.state.domains[0]!.status = "removing";
    await enqueueProvisioning(d, { kind: "domain.ensure", subjectId: "d1" });
    await runNextJob(d, mail); // ensure is a no-op for a removing domain
    expect(mail.domains).toEqual(["example.test"]);
    await enqueueProvisioning(d, { kind: "domain.remove", subjectId: "d1" });
    await runNextJob(d, mail);
    expect(mail.domains).toEqual([]);
    expect(d.uow.state.domains).toEqual([]);
  });

  it("retries while the mail server still has mailboxes on the domain, and never removes an active domain", async () => {
    const { d } = setup();
    const mail = fakeMailServer();
    await enqueueProvisioning(d, { kind: "mailbox.ensure", subjectId: "m1" });
    await runNextJob(d, mail);
    d.uow.state.domains[0]!.status = "removing";
    await enqueueProvisioning(d, { kind: "domain.remove", subjectId: "d1" });
    const job = await runNextJob(d, mail);
    expect(d.uow.state.jobs.find((j) => j.id === job?.id)?.status).toBe("queued");
    expect(d.uow.state.domains).toHaveLength(1);

    d.uow.state.domains[0]!.status = "active";
    d.uow.state.jobs = [];
    await enqueueProvisioning(d, { kind: "domain.remove", subjectId: "d1" });
    await runNextJob(d, mail);
    expect(d.uow.state.domains).toHaveLength(1);
  });
});

describe("domain removed while being added", () => {
  it("takes it off the mail server again instead of leaving an orphan", async () => {
    const { d } = setup();
    d.uow.state.mailboxes = [];
    const mail = fakeMailServer();
    const ensure = mail.ensureDomain.bind(mail);
    mail.ensureDomain = async (name) => {
      const out = await ensure(name);
      d.uow.state.domains[0]!.status = "removing"; // the customer removed it meanwhile
      return out;
    };
    await enqueueProvisioning(d, { kind: "domain.ensure", subjectId: "d1" });
    await runNextJob(d, mail);
    expect(mail.domains).toEqual([]);
    expect(d.uow.state.domains[0]?.stalwartId).toBeNull();
  });
});

describe("mailbox ownership and suspension guards", () => {
  it("refuses to create a mailbox on a domain another account has verified", async () => {
    const { d } = setup();
    d.uow.state.domains[0]!.accountId = "someone-else"; // example.test is now claimed by another account
    const mail = fakeMailServer();
    await enqueueProvisioning(d, { kind: "mailbox.ensure", subjectId: "m1" });
    await runNextJob(d, mail);
    expect(mail.boxes).toEqual([]);
    expect(d.uow.state.jobs[0]?.lastError).toContain("domain belongs to another account");
  });

  it("keeps a suspended mailbox suspended when its job gives up", async () => {
    const { d } = setup();
    d.uow.state.mailboxes[0]!.status = "suspended";
    d.uow.state.domains[0]!.accountId = "someone-else";
    const mail = fakeMailServer();
    await enqueueProvisioning(d, { kind: "mailbox.ensure", subjectId: "m1" });
    d.uow.state.jobs[0]!.attempts = MAX_ATTEMPTS - 1;
    await runNextJob(d, mail);
    expect(d.uow.state.jobs[0]?.status).toBe("failed");
    expect(d.uow.state.mailboxes[0]?.status).toBe("suspended");
  });
});
