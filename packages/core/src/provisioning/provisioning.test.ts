// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { deps as makeDeps, fixedClock } from "../__tests__/helpers";
import type { MailServer } from "./ports";
import { enqueueProvisioning, reconcile, requeueActiveMailboxes, runClaimedJob, runNextJob } from "./service";
import { backoffMs, MAX_ATTEMPTS, STALE_RUNNING_MS } from "./types";

type Box = {
  address: string;
  quotaBytes: number;
  aliases: string[];
  description: string | null;
  suspended: boolean;
  /** The argon2id hash the account was created with or last given (null: a random one). */
  passwordHash: string | null;
  passwordCredentialId: string;
  /** The grant the last replacement carried. */
  grant?: string | null;
};

type Revoked = { externalId: string; credentialId: string; createdAt: Date };

/** The keys the fake mail server gives a domain: Ed25519 at once, RSA unless `rsaLate` (as Stalwart, a moment later). */
const fakeKeys = (name: string, rsa = true) => [
  { selector: "v1-ed25519-20261028", value: `v=DKIM1; k=ed25519; h=sha256; p=ed-${name}` },
  ...(rsa ? [{ selector: "v1-rsa-20261028", value: `v=DKIM1; k=rsa; h=sha256; p=rsa-${name}` }] : []),
];

function fakeMailServer(opts: { failTimes?: number; rsaLate?: number } = {}): MailServer & {
  domains: string[];
  boxes: Box[];
  catchAll: Map<string, string | null>;
  revoked: Revoked[];
} {
  let failures = opts.failTimes ?? 0;
  let rsaLate = opts.rsaLate ?? 0;
  const state = {
    domains: [] as string[],
    boxes: [] as Box[],
    catchAll: new Map<string, string | null>(),
    revoked: [] as Revoked[],
  };
  return {
    ...state,
    ensureDomain: async (name, catchAllAddress) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("mail server unavailable");
      }
      if (!state.domains.includes(name)) state.domains.push(name);
      state.catchAll.set(name, catchAllAddress ?? null);
      return { externalId: `dom:${name}` };
    },
    domainDkimKeys: async (externalId) => {
      const name = externalId.replace(/^dom:/, "");
      if (!state.domains.includes(name)) return [];
      const rsa = rsaLate <= 0;
      rsaLate -= 1;
      return fakeKeys(name, rsa);
    },
    revokeAppPassword: async (input) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("mail server unavailable");
      }
      state.revoked.push(input);
    },
    ensureMailbox: async ({ address, quotaBytes, suspended, aliases, initialPasswordHash, description }) => {
      const existing = state.boxes.find((b) => b.address === address);
      const box = {
        address,
        quotaBytes,
        suspended,
        aliases: aliases.map((a) => a.address),
        description: description ?? null,
      };
      if (existing) Object.assign(existing, box);
      else state.boxes.push({ ...box, passwordHash: initialPasswordHash, passwordCredentialId: "a" });
      const now = state.boxes.find((b) => b.address === address);
      return {
        externalId: `acc:${address}`,
        created: !existing,
        passwordCredentialId: now?.passwordCredentialId ?? null,
      };
    },
    setMailboxPassword: async ({ externalId, passwordHash, grant }) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("mail server unavailable");
      }
      const box = state.boxes.find((b) => `acc:${b.address}` === externalId);
      if (!box) throw new Error("no such account");
      box.passwordHash = passwordHash;
      box.grant = grant;
      box.passwordCredentialId = String.fromCharCode(box.passwordCredentialId.charCodeAt(0) + 1);
      return { credentialId: box.passwordCredentialId };
    },
    destroyMailbox: async ({ externalId, address }) => {
      if (externalId === null) return;
      state.boxes = state.boxes.filter((b) => b.address !== address);
    },
    removeDomain: async (name) => {
      if (state.boxes.some((b) => b.address.endsWith(`@${name}`))) throw new Error("domain still has mailboxes");
      state.domains = state.domains.filter((x) => x !== name);
    },
    listDomains: async () => [...state.domains],
    listMailboxes: async () =>
      state.boxes.map((b) => ({ address: b.address, quotaBytes: b.quotaBytes, suspended: b.suspended })),
    get domains() {
      return state.domains;
    },
    get boxes() {
      return state.boxes;
    },
  };
}

const ensureArgs = (address: string, quotaBytes: number) => ({
  externalId: null,
  initialPasswordHash: null,
  address,
  quotaBytes,
  suspended: false,
  aliases: [],
});

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
    purgeAfter: null,
  });
  d.uow.state.aliases.push({
    id: "al1",
    accountId: "a1",
    mailboxId: "m1",
    address: "hello@example.test",
    kind: "alias",
    enabled: true,
    adminLocked: false,
    description: null,
    createdAt: new Date(0),
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
    expect(mail.boxes).toEqual([
      {
        address: "owner@example.test",
        quotaBytes: 1000,
        aliases: ["hello@example.test"],
        suspended: false,
        description: null,
        passwordHash: null,
        passwordCredentialId: "a",
      },
    ]);
    // The display name becomes the account's description (the sender name Stalwart seeds identities with).
    const m1 = d.uow.state.mailboxes.find((m) => m.id === "m1");
    if (m1) m1.displayName = "Owner Example";
    await enqueueProvisioning(d, { kind: "mailbox.ensure", subjectId: "m1" });
    await runNextJob(d, mail);
    expect(mail.boxes[0]?.description).toBe("Owner Example");
    // The new account's Password credential is recorded for the reconciler.
    expect(d.uow.state.mailboxPasswords).toEqual([{ mailboxId: "m1", pendingHash: null, credentialId: "a" }]);
    expect(d.uow.state.domains[0]?.stalwartId).toBe("dom:example.test");
    expect(d.uow.state.domains[0]?.dkimKeys).toEqual(fakeKeys("example.test"));
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

  it("adds a pending domain for its DKIM keys (no catch-all) and caches the keys once the RSA key exists", async () => {
    const { d, clock } = setup();
    d.uow.state.domains[0]!.status = "pending_dns";
    d.uow.state.catchAll.push({ domainId: "d1", mailboxId: "m1" });
    const mail = fakeMailServer({ rsaLate: 1 });
    await enqueueProvisioning(d, { kind: "domain.ensure", subjectId: "d1" });
    await runNextJob(d, mail);
    expect(mail.domains).toEqual(["example.test"]);
    expect(mail.catchAll.get("example.test")).toBeNull();
    // On the mail server (so a removal goes through the worker), but only the Ed25519 key so far: retried.
    expect(d.uow.state.domains[0]).toMatchObject({ stalwartId: "dom:example.test", status: "pending_dns" });
    expect(d.uow.state.domains[0]?.dkimKeys ?? null).toBeNull();
    expect(d.uow.state.jobs[0]).toMatchObject({ status: "queued", lastError: "Error: DKIM keys not ready yet" });

    clock.set(new Date(clock.now().getTime() + backoffMs(1)));
    await runNextJob(d, mail);
    expect(d.uow.state.domains[0]?.dkimKeys).toEqual(fakeKeys("example.test"));
    expect(d.uow.state.domains[0]?.lastError).toBeNull();
    expect(d.uow.state.audit).toHaveLength(0);
  });

  it("never adds a pending domain another account holds or has already put on the mail server", async () => {
    const { d } = setup();
    d.uow.state.domains[0]!.status = "pending_dns";
    d.uow.state.domains.push({ ...d.uow.state.domains[0]!, id: "d2", accountId: "a2", stalwartId: "dom:example.test" });
    const mail = fakeMailServer();
    await enqueueProvisioning(d, { kind: "domain.ensure", subjectId: "d1" });
    await runNextJob(d, mail);
    expect(mail.domains).toEqual([]);
    expect(d.uow.state.jobs[0]?.lastError).toContain("domain is being set up by another account");

    d.uow.state.domains[1]!.status = "active";
    d.uow.state.jobs = [];
    await enqueueProvisioning(d, { kind: "domain.ensure", subjectId: "d1" });
    await runNextJob(d, mail);
    expect(mail.domains).toEqual([]);
    expect(d.uow.state.jobs[0]?.lastError).toContain("domain belongs to another account");
  });

  it("does nothing for a domain that is already gone", async () => {
    const { d } = setup();
    d.uow.state.domains = [];
    const mail = fakeMailServer();
    await enqueueProvisioning(d, { kind: "domain.ensure", subjectId: "d1" });
    await runNextJob(d, mail);
    expect(mail.domains).toEqual([]);
    expect(d.uow.state.jobs[0]?.status).toBe("succeeded");
  });

  it("keeps a suspended mailbox suspended, and suspends it on the mail server with its aliases kept", async () => {
    const { d } = setup();
    d.uow.state.mailboxes[0]!.status = "suspended";
    const mail = fakeMailServer();
    await enqueueProvisioning(d, { kind: "mailbox.ensure", subjectId: "m1" });
    await runNextJob(d, mail);
    expect(d.uow.state.mailboxes[0]?.status).toBe("suspended");
    expect(mail.boxes[0]).toMatchObject({ suspended: true, aliases: ["hello@example.test"] });
  });

  it("suspends a deleting mailbox and takes its aliases off the mail server", async () => {
    const { d, clock } = setup();
    const mail = fakeMailServer();
    await enqueueProvisioning(d, { kind: "mailbox.ensure", subjectId: "m1" });
    await runNextJob(d, mail);
    Object.assign(d.uow.state.mailboxes[0]!, {
      status: "deleting",
      purgeAfter: new Date(clock.now().getTime() + 1000),
    });
    await enqueueProvisioning(d, { kind: "mailbox.ensure", subjectId: "m1" });
    await runNextJob(d, mail);
    expect(mail.boxes[0]).toMatchObject({ suspended: true, aliases: [] });
    expect(d.uow.state.mailboxes[0]).toMatchObject({ status: "deleting", lastError: null });
    expect(d.uow.state.aliases).toHaveLength(1); // still reserved in the control plane
  });

  it("never creates a deleting mailbox that was never on the mail server, nor touches one due for purge", async () => {
    const { d, clock } = setup();
    const mail = fakeMailServer();
    Object.assign(d.uow.state.mailboxes[0]!, { status: "deleting", purgeAfter: new Date(clock.now().getTime() + 1) });
    await enqueueProvisioning(d, { kind: "mailbox.ensure", subjectId: "m1" });
    await runNextJob(d, mail);
    expect(mail.boxes).toEqual([]);
    Object.assign(d.uow.state.mailboxes[0]!, { stalwartId: "acc:owner@example.test", purgeAfter: clock.now() });
    await enqueueProvisioning(d, { kind: "mailbox.ensure", subjectId: "m1" });
    await runNextJob(d, mail);
    expect(mail.boxes).toEqual([]);
    expect(d.uow.state.jobs.every((j) => j.status === "succeeded")).toBe(true);
  });

  it("leaves the status alone when it changed while the job ran (that change queued its own job)", async () => {
    const { d } = setup();
    const mail = fakeMailServer();
    const ensure = mail.ensureMailbox.bind(mail);
    mail.ensureMailbox = async (input) => {
      const out = await ensure(input);
      d.uow.state.mailboxes[0]!.status = "suspended"; // suspended from the console meanwhile
      return out;
    };
    await enqueueProvisioning(d, { kind: "mailbox.ensure", subjectId: "m1" });
    await runNextJob(d, mail);
    expect(d.uow.state.mailboxes[0]).toMatchObject({ status: "suspended", stalwartId: "acc:owner@example.test" });
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

  it("turns off a catch-all whose mailbox ends up failed, and queues the domain", async () => {
    const { d, clock } = setup();
    d.uow.state.catchAll.push({ domainId: "d1", mailboxId: "m1" });
    const mail: MailServer = { ...fakeMailServer(), ensureMailbox: () => Promise.reject(new Error("quota refused")) };
    await enqueueProvisioning(d, { kind: "mailbox.ensure", subjectId: "m1" });
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await runNextJob(d, mail);
      clock.set(new Date(clock.now().getTime() + backoffMs(i + 1)));
    }
    expect(d.uow.state.catchAll).toEqual([]);
    expect(d.uow.state.jobs.some((j) => j.kind === "domain.ensure" && j.subjectId === "d1")).toBe(true);
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "platform.provisioning_failed",
      meta: { catchAllOff: ["example.test"] },
    });
  });
});

describe("catch-all and app password jobs", () => {
  it("applies the domain's catch-all only while its mailbox is active", async () => {
    const { d } = setup();
    const mail = fakeMailServer();
    d.uow.state.catchAll.push({ domainId: "d1", mailboxId: "m1" });
    await enqueueProvisioning(d, { kind: "domain.ensure", subjectId: "d1" });
    await runNextJob(d, mail);
    expect(mail.catchAll.get("example.test")).toBeNull(); // m1 is still provisioning
    d.uow.state.mailboxes[0]!.status = "active";
    await enqueueProvisioning(d, { kind: "domain.ensure", subjectId: "d1" });
    await runNextJob(d, mail);
    expect(mail.catchAll.get("example.test")).toBe("owner@example.test");
    d.uow.state.catchAll = [];
    await enqueueProvisioning(d, { kind: "domain.ensure", subjectId: "d1" });
    await runNextJob(d, mail);
    expect(mail.catchAll.get("example.test")).toBeNull();
  });

  it("revokes a mailbox's revoking app passwords on the mail server, then deletes their rows", async () => {
    const { d, clock } = setup();
    const mail = fakeMailServer();
    d.uow.state.mailboxes[0]!.stalwartId = "acc-1";
    const row = (id: string, status: "active" | "revoking") => ({
      id,
      accountId: "a1",
      mailboxId: "m1",
      name: id,
      protocols: ["imap" as const],
      credentialId: `c-${id}`,
      credentialCreatedAt: new Date(1000),
      createdAt: clock.now(),
      createdBy: "u",
      status,
    });
    d.uow.state.appPasswords.push(row("p1", "revoking"), row("p2", "active"), row("p3", "revoking"));
    await enqueueProvisioning(d, { kind: "app_password.revoke", subjectId: "m1" });
    await runNextJob(d, mail);
    expect(mail.revoked).toEqual([
      { externalId: "acc-1", credentialId: "c-p1", createdAt: new Date(1000) },
      { externalId: "acc-1", credentialId: "c-p3", createdAt: new Date(1000) },
    ]);
    expect(d.uow.state.appPasswords.map((p) => p.id)).toEqual(["p2"]);
    expect(d.uow.state.jobs[0]?.status).toBe("succeeded");
  });

  it("deletes revoking rows of a mailbox that never reached the mail server, and gives up without touching domains", async () => {
    const { d, clock } = setup();
    d.uow.state.appPasswords.push({
      id: "p1",
      accountId: "a1",
      mailboxId: "m1",
      name: "Phone",
      protocols: ["imap"],
      credentialId: "c1",
      credentialCreatedAt: new Date(0),
      createdAt: clock.now(),
      createdBy: null,
      status: "revoking",
    });
    const mail = fakeMailServer();
    await enqueueProvisioning(d, { kind: "app_password.revoke", subjectId: "m1" });
    await runNextJob(d, mail);
    expect(mail.revoked).toEqual([]);
    expect(d.uow.state.appPasswords).toEqual([]);

    // A mail server that keeps failing: the job gives up and is audited; no domain is marked.
    d.uow.state.mailboxes[0]!.stalwartId = "acc-1";
    d.uow.state.appPasswords.push({
      id: "p2",
      accountId: "a1",
      mailboxId: "m1",
      name: "Phone",
      protocols: ["imap"],
      credentialId: "c2",
      credentialCreatedAt: new Date(0),
      createdAt: clock.now(),
      createdBy: null,
      status: "revoking",
    });
    const failing = fakeMailServer({ failTimes: 99 });
    await enqueueProvisioning(d, { kind: "app_password.revoke", subjectId: "m1" });
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await runNextJob(d, failing);
      clock.set(new Date(clock.now().getTime() + backoffMs(i + 1)));
    }
    expect(d.uow.state.jobs.at(-1)).toMatchObject({ kind: "app_password.revoke", status: "failed" });
    expect(d.uow.state.domains[0]?.lastError).toBeNull();
    expect(d.uow.state.audit.map((e) => e.action)).toEqual(["platform.provisioning_failed"]);
  });
});

describe("reconcile", () => {
  it("is clean when the mail server matches, and writes no audit", async () => {
    const { d } = setup();
    d.uow.state.mailboxes[0]!.status = "active";
    const mail = fakeMailServer();
    await mail.ensureDomain("example.test");
    await mail.ensureMailbox(ensureArgs("owner@example.test", 1000));
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
    await mail.ensureMailbox(ensureArgs("ghost@stray.test", 5));
    await mail.ensureMailbox(ensureArgs("alice@dev.test", 5));
    await mail.ensureDomain("example.test");
    await mail.ensureMailbox(ensureArgs("owner@example.test", 999));
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
      purgeAfter: null,
    });
    const mail = fakeMailServer();
    await mail.ensureDomain("platform.test");
    const report = await reconcile(d, mail);
    expect(report.unknownOnMailServer.domains).not.toContain("platform.test");
  });

  it("the platform domain is always desired; on it only system accounts are expected, even when it is ignored", async () => {
    const { d } = setup();
    d.uow.state.mailboxes[0]!.status = "active";
    const platform = d.platform.domain;
    d.uow.state.mailboxes.push({
      id: "free1",
      accountId: "a1",
      userId: null,
      createdAt: new Date(0),
      address: `jane@${platform}`,
      quotaBytes: 10,
      status: "active",
      stalwartId: "s-free1",
      lastError: null,
      purgeAfter: null,
    });
    const mail = fakeMailServer();
    await mail.ensureDomain("example.test");
    await mail.ensureMailbox(ensureArgs("owner@example.test", 1000));
    await mail.ensureDomain(platform);
    await mail.ensureDomain("dev.test");
    await mail.ensureMailbox(ensureArgs("alice@dev.test", 5)); // dev mailboxes: the whole domain is ignored
    // A customer's free address (known) and the system accounts: not drift.
    await mail.ensureMailbox(ensureArgs(`jane@${platform}`, 10));
    for (const local of ["svc-provision", "svc-ops", "svc-audit", "no-reply", "postmaster", "dmarc-reports"]) {
      await mail.ensureMailbox(ensureArgs(`${local}@${platform}`, 5));
    }
    const clean = await reconcile(d, mail, { ignoreDomains: ["dev.test", platform] });
    expect(clean.unknownOnMailServer).toEqual({ domains: [], mailboxes: [] });
    expect(clean.clean).toBe(true);
    // Anyone else on the platform domain is reported, ignored or not (never deleted).
    await mail.ensureMailbox(ensureArgs(`squatter@${platform}`, 5));
    const drift = await reconcile(d, mail, { ignoreDomains: ["dev.test", platform] });
    expect(drift.unknownOnMailServer.mailboxes).toEqual([`squatter@${platform}`]);
    expect(drift.clean).toBe(false);
    expect(mail.boxes.some((b) => b.address === `squatter@${platform}`)).toBe(true);
  });

  it("doesn't report deleting mailboxes as missing or unknown, nor stray quota on them", async () => {
    const { d } = setup();
    const base = { accountId: "a1", userId: null, createdAt: new Date(0), lastError: null };
    d.uow.state.mailboxes = [
      {
        ...base,
        id: "x1",
        address: "gone@example.test",
        quotaBytes: 1,
        status: "deleting",
        stalwartId: "s1",
        purgeAfter: new Date(),
      },
      {
        ...base,
        id: "x2",
        address: "never@example.test",
        quotaBytes: 1,
        status: "deleting",
        stalwartId: null,
        purgeAfter: new Date(),
      },
      {
        ...base,
        id: "x3",
        address: "paused@example.test",
        quotaBytes: 7,
        status: "suspended",
        stalwartId: "s3",
        purgeAfter: null,
      },
      {
        ...base,
        id: "x4",
        address: "back@example.test",
        quotaBytes: 1,
        status: "provisioning",
        stalwartId: "s4",
        purgeAfter: null,
      },
    ];
    const mail = fakeMailServer();
    await mail.ensureDomain("example.test");
    await mail.ensureMailbox(ensureArgs("gone@example.test", 999));
    await mail.ensureMailbox(ensureArgs("back@example.test", 1));
    const report = await reconcile(d, mail);
    expect(report.unknownOnMailServer.mailboxes).toEqual([]);
    expect(report.missingOnMailServer.mailboxes).toEqual(["paused@example.test"]);
    expect(report.quotaMismatch).toEqual([]);
  });

  it("reports desired objects missing on the mail server", async () => {
    const { d } = setup();
    d.uow.state.mailboxes[0]!.status = "active";
    const report = await reconcile(d, fakeMailServer());
    expect(report.missingOnMailServer).toEqual({ domains: ["example.test"], mailboxes: ["owner@example.test"] });
  });
});

describe("suspension drift", () => {
  it("reports suspended or deleting mailboxes that are open on the mail server (and the reverse) and re-queues them", async () => {
    const { d } = setup();
    const base = { accountId: "a1", userId: null, createdAt: new Date(0), quotaBytes: 1, purgeAfter: null };
    d.uow.state.mailboxes = [
      {
        ...base,
        id: "s1",
        address: "paused@example.test",
        status: "suspended",
        stalwartId: "x1",
        lastError: "gave up",
      },
      { ...base, id: "s2", address: "open@example.test", status: "active", stalwartId: "x2", lastError: null },
      { ...base, id: "s3", address: "ok@example.test", status: "suspended", stalwartId: "x3", lastError: null },
      { ...base, id: "s4", address: "new@example.test", status: "provisioning", stalwartId: "x4", lastError: null },
    ];
    const mail = fakeMailServer();
    await mail.ensureDomain("example.test");
    await mail.ensureMailbox(ensureArgs("paused@example.test", 1)); // suspension never applied
    await mail.ensureMailbox({ ...ensureArgs("open@example.test", 1), suspended: true }); // suspended by hand
    await mail.ensureMailbox({ ...ensureArgs("ok@example.test", 1), suspended: true });
    await mail.ensureMailbox(ensureArgs("new@example.test", 1)); // has its own job; not compared
    const report = await reconcile(d, mail);
    expect(report.suspensionMismatch).toEqual([
      { address: "paused@example.test", desired: true, actual: false },
      { address: "open@example.test", desired: false, actual: true },
    ]);
    expect(report.clean).toBe(false);
    expect(d.uow.state.jobs.map((j) => [j.kind, j.subjectId])).toEqual([
      ["mailbox.ensure", "s1"],
      ["mailbox.ensure", "s2"],
    ]);
    expect(d.uow.state.audit.at(-1)?.meta).toMatchObject({ suspensionMismatches: 2, requeued: 2 });
    expect(mail.boxes).toHaveLength(4); // nothing deleted

    // The re-queued job brings the server back in line, and the next run is clean for these.
    while (await runNextJob(d, mail)) {
      /* drain */
    }
    expect(mail.boxes.find((b) => b.address === "paused@example.test")?.suspended).toBe(true);
    expect(mail.boxes.find((b) => b.address === "open@example.test")?.suspended).toBe(false);
    expect((await reconcile(d, mail)).suspensionMismatch).toEqual([]);
  });
});

describe("customer Sieve lock drift and backfill", () => {
  /** The fake mail server, plus which accounts lack the customer lock (ensure puts it back, like the real one). */
  function lockingServer() {
    const mail = fakeMailServer();
    const open = new Set<string>();
    const ensure = mail.ensureMailbox.bind(mail);
    mail.ensureMailbox = async (input) => {
      open.delete(input.address);
      return ensure(input);
    };
    const list = mail.listMailboxes.bind(mail);
    mail.listMailboxes = async () => (await list()).map((m) => ({ ...m, sieveLocked: !open.has(m.address) }));
    return { mail, open };
  }

  it("re-queues active mailboxes whose lock is missing, and the job re-applies it", async () => {
    const { d } = setup();
    const base = {
      accountId: "a1",
      userId: null,
      createdAt: new Date(0),
      quotaBytes: 1,
      purgeAfter: null,
      lastError: null,
    };
    d.uow.state.mailboxes = [
      { ...base, id: "m1", address: "open@example.test", status: "active", stalwartId: "x1" },
      { ...base, id: "m2", address: "fine@example.test", status: "active", stalwartId: "x2" },
      { ...base, id: "m3", address: "paused@example.test", status: "suspended", stalwartId: "x3" },
    ];
    const { mail, open } = lockingServer();
    await mail.ensureDomain("example.test");
    await mail.ensureMailbox(ensureArgs("open@example.test", 1));
    await mail.ensureMailbox(ensureArgs("fine@example.test", 1));
    await mail.ensureMailbox({ ...ensureArgs("paused@example.test", 1), suspended: true });
    open.add("open@example.test"); // e.g. created before the lock existed, or changed by hand
    open.add("paused@example.test"); // suspended: its own permissions lock it; not reported here

    const report = await reconcile(d, mail);
    expect(report.sieveLockMismatch).toEqual(["open@example.test"]);
    expect(report.clean).toBe(false);
    expect(d.uow.state.jobs.map((j) => [j.kind, j.subjectId])).toEqual([["mailbox.ensure", "m1"]]);
    expect(d.uow.state.audit.at(-1)?.meta).toMatchObject({ sieveLockMismatches: 1, requeued: 1 });
    while (await runNextJob(d, mail)) {
      /* drain */
    }
    expect((await reconcile(d, mail)).sieveLockMismatch).toEqual([]);
  });

  it("backfills: queues an ensure for every active mailbox, audited", async () => {
    const { d } = setup();
    const base = {
      accountId: "a1",
      userId: null,
      createdAt: new Date(0),
      quotaBytes: 1,
      purgeAfter: null,
      lastError: null,
    };
    d.uow.state.mailboxes = [
      { ...base, id: "m1", address: "one@example.test", status: "active", stalwartId: "x1" },
      { ...base, id: "m2", address: "two@example.test", status: "active", stalwartId: "x2" },
      { ...base, id: "m3", address: "paused@example.test", status: "suspended", stalwartId: "x3" },
      { ...base, id: "m4", address: "gone@example.test", status: "deleting", stalwartId: "x4" },
    ];
    expect(await requeueActiveMailboxes(d)).toBe(2);
    expect(d.uow.state.jobs.map((j) => j.subjectId).sort()).toEqual(["m1", "m2"]);
    expect(d.uow.state.audit.at(-1)).toMatchObject({ action: "platform.mailboxes_requeued", meta: { requeued: 2 } });
  });
});

describe("a stale claim taken over by another worker (lock token)", () => {
  /**
   * The first worker's call to the mail server stalls past the stale limit; meanwhile a second worker takes the job
   * over and finishes it. Then the first call returns (or fails) and the first worker records its outcome.
   */
  function stalling(
    d: ReturnType<typeof setup>["d"],
    clock: ReturnType<typeof fixedClock>,
    outcome: "ok" | "fail",
  ): { mail: MailServer; second: { lockLost: boolean; attempts: number } | null } {
    const base = fakeMailServer();
    const state: { second: { lockLost: boolean; attempts: number } | null } = { second: null };
    let stalled = false;
    const mail: MailServer = {
      ...base,
      ensureDomain: async (name, catchAll) => {
        if (!stalled) {
          stalled = true;
          clock.set(new Date(clock.now().getTime() + STALE_RUNNING_MS + 1));
          const job = await runNextJob(d, base);
          state.second = job && { lockLost: job.lockLost, attempts: job.attempts };
          if (outcome === "fail") throw new Error("mail server unavailable");
        }
        return base.ensureDomain(name, catchAll);
      },
    };
    return {
      mail,
      get second() {
        return state.second;
      },
    };
  }

  it("a late success changes nothing: the newer claim already finished the job", async () => {
    const { d, clock } = setup();
    await enqueueProvisioning(d, { kind: "domain.ensure", subjectId: "d1" });
    const run = stalling(d, clock, "ok");
    const first = await runNextJob(d, run.mail);
    expect(run.second).toEqual({ lockLost: false, attempts: 2 });
    expect(first).toMatchObject({ attempts: 1, lockLost: true });
    expect(d.uow.state.jobs[0]).toMatchObject({ status: "succeeded", attempts: 2, lockToken: null });
  });

  it("a late failure doesn't put a finished job back in the queue", async () => {
    const { d, clock } = setup();
    await enqueueProvisioning(d, { kind: "domain.ensure", subjectId: "d1" });
    const run = stalling(d, clock, "fail");
    const first = await runNextJob(d, run.mail);
    expect(first?.lockLost).toBe(true);
    expect(d.uow.state.jobs[0]).toMatchObject({ status: "succeeded", lastError: null });
    expect(await runNextJob(d, fakeMailServer())).toBeNull(); // nothing re-queued
  });

  it("a late last failure doesn't give up the job or mark the subject: audited as denied", async () => {
    const { d, clock } = setup();
    await enqueueProvisioning(d, { kind: "domain.ensure", subjectId: "d1" });
    d.uow.state.jobs[0]!.attempts = MAX_ATTEMPTS - 1; // the next claim is the last attempt
    const run = stalling(d, clock, "fail");
    const first = await runNextJob(d, run.mail);
    expect(first).toMatchObject({ attempts: MAX_ATTEMPTS, lockLost: true });
    expect(d.uow.state.jobs[0]).toMatchObject({ status: "succeeded", attempts: MAX_ATTEMPTS + 1 });
    expect(d.uow.state.domains[0]).toMatchObject({ lastError: null, stalwartId: "dom:example.test" });
    expect(d.uow.state.audit).toEqual([
      expect.objectContaining({
        action: "platform.provisioning_failed",
        result: "denied",
        errorCode: "lock_lost",
        meta: { jobId: d.uow.state.jobs[0]!.id, attempts: MAX_ATTEMPTS },
      }),
    ]);
  });

  it("a fresh claim is never taken over", async () => {
    const { d, clock } = setup();
    await enqueueProvisioning(d, { kind: "domain.ensure", subjectId: "d1" });
    const held = await d.uow.run((r) => r.provisioning.claimNext(clock.now()));
    clock.set(new Date(clock.now().getTime() + STALE_RUNNING_MS - 1));
    expect(await runNextJob(d, fakeMailServer())).toBeNull();
    expect(held && (await d.uow.run((r) => r.provisioning.complete(held, clock.now())))).toBe(true);
  });
});

describe("one job per subject at a time", () => {
  it("never claims a second job for a subject that already has one running", async () => {
    const { d } = setup();
    const mail = fakeMailServer();
    await enqueueProvisioning(d, { kind: "mailbox.ensure", subjectId: "m1" });
    const running = await d.uow.run((r) => r.provisioning.claimNext(d.clock.now()));
    expect(running?.subjectId).toBe("m1");
    // A newer change for the same mailbox queues a new job while the first one is still running.
    await enqueueProvisioning(d, { kind: "mailbox.ensure", subjectId: "m1" });
    await enqueueProvisioning(d, { kind: "domain.ensure", subjectId: "d1" });
    expect((await runNextJob(d, mail))?.subjectId).toBe("d1"); // other subjects still run
    expect(await runNextJob(d, mail)).toBeNull(); // m1's second job waits
    if (!running) throw new Error("claim expected");
    await d.uow.run((r) => r.provisioning.complete(running, d.clock.now()));
    expect((await runNextJob(d, mail))?.subjectId).toBe("m1");
  });

  it("applies the latest status: it re-reads the mailbox right before calling the mail server", async () => {
    const { d } = setup();
    const mail = fakeMailServer();
    let reads = 0;
    const deps = {
      clock: d.clock,
      platform: d.platform,
      uow: {
        run: <T>(fn: (r: Parameters<Parameters<typeof d.uow.run>[0]>[0]) => Promise<T>) =>
          d.uow.run((r) =>
            fn({
              ...r,
              directory: {
                ...r.directory,
                getMailbox: async (id: string) => {
                  reads += 1;
                  const out = await r.directory.getMailbox(id);
                  // Suspended from the console just after the job's first read.
                  if (reads === 1) d.uow.state.mailboxes[0]!.status = "suspended";
                  return out;
                },
              },
            }),
          ),
      },
    };
    await enqueueProvisioning(d, { kind: "mailbox.ensure", subjectId: "m1" });
    await runNextJob(deps, mail);
    expect(mail.boxes[0]?.suspended).toBe(true);
    expect(d.uow.state.mailboxes[0]?.status).toBe("suspended");
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
  it("takes a pending domain deleted meanwhile off the mail server, unless another claim holds the name", async () => {
    const { d } = setup();
    d.uow.state.mailboxes = [];
    d.uow.state.domains[0]!.status = "pending_dns";
    const mail = fakeMailServer();
    const ensure = mail.ensureDomain.bind(mail);
    mail.ensureDomain = async (name) => {
      const out = await ensure(name);
      d.uow.state.domains = d.uow.state.domains.filter((x) => x.id !== "d1"); // the customer removed it meanwhile
      return out;
    };
    await enqueueProvisioning(d, { kind: "domain.ensure", subjectId: "d1" });
    await runNextJob(d, mail);
    expect(mail.domains).toEqual([]);
    expect(d.uow.state.jobs[0]?.status).toBe("succeeded");
  });

  it("records a pending domain only if no other claim was recorded on the mail server while it was being added", async () => {
    const { d } = setup();
    d.uow.state.mailboxes = [];
    d.uow.state.domains[0]!.status = "pending_dns";
    d.uow.state.domains.push({ ...d.uow.state.domains[0]!, id: "d2", accountId: "a2" });
    const mail = fakeMailServer();
    const ensure = mail.ensureDomain.bind(mail);
    const locked: string[] = [];
    const run = d.uow.run.bind(d.uow);
    d.uow.run = (fn) =>
      run((r) => fn({ ...r, directory: { ...r.directory, lockDomainName: async (n) => void locked.push(n) } }));
    mail.ensureDomain = async (name) => {
      const out = await ensure(name);
      // The other account's claim passed the same check and was recorded first.
      d.uow.state.domains.find((x) => x.id === "d2")!.stalwartId = out.externalId;
      return out;
    };
    await enqueueProvisioning(d, { kind: "domain.ensure", subjectId: "d1" });
    await runNextJob(d, mail);
    expect(locked).toContain("example.test");
    expect(d.uow.state.domains.find((x) => x.id === "d1")?.stalwartId).toBeNull();
    expect(d.uow.state.jobs[0]?.lastError).toContain("domain is being set up by another account");
    // The mail server's domain is the winner's now: left in place.
    expect(mail.domains).toEqual(["example.test"]);
  });

  it("removes a released row without taking the name off the mail server while another row holds it there", async () => {
    const { d } = setup();
    d.uow.state.mailboxes = [];
    const mail = fakeMailServer();
    await mail.ensureDomain("example.test");
    d.uow.state.domains[0]!.stalwartId = "dom:example.test";
    d.uow.state.domains.push({ ...d.uow.state.domains[0]!, id: "d2", accountId: "a2", status: "removing" });
    await enqueueProvisioning(d, { kind: "domain.remove", subjectId: "d2" });
    await runNextJob(d, mail);
    expect(mail.domains).toEqual(["example.test"]);
    expect(d.uow.state.domains.map((x) => x.id)).toEqual(["d1"]);
  });

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

const PHC = (n: number) => `$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaC${String(n)}`;

describe("mailbox passwords (worker)", () => {
  const provision = async (d: ReturnType<typeof setup>["d"], mail: ReturnType<typeof fakeMailServer>) => {
    await enqueueProvisioning(d, { kind: "domain.ensure", subjectId: "d1" });
    await enqueueProvisioning(d, { kind: "mailbox.ensure", subjectId: "m1" });
    while (await runNextJob(d, mail));
  };

  it("creates the account with the password chosen at creation, records its credential and drops the hash", async () => {
    const { d } = setup();
    const mail = fakeMailServer();
    d.uow.state.mailboxPasswords.push({ mailboxId: "m1", pendingHash: PHC(1), credentialId: null });
    await provision(d, mail);
    expect(mail.boxes[0]).toMatchObject({ passwordHash: PHC(1), passwordCredentialId: "a" });
    expect(d.uow.state.mailboxPasswords).toEqual([
      { mailboxId: "m1", pendingHash: null, credentialId: "a", grant: null },
    ]);
  });

  it("applies a reset through its own job: only the hash, recorded credential, nothing kept afterwards", async () => {
    const { d } = setup();
    const mail = fakeMailServer();
    await provision(d, mail);
    await d.uow.run((r) => r.mailboxPasswords.setPending("m1", PHC(2), "grant-2"));
    await enqueueProvisioning(d, { kind: "mailbox.password", subjectId: "m1" });
    expect((await runNextJob(d, mail))?.kind).toBe("mailbox.password");
    expect(mail.boxes[0]).toMatchObject({ passwordHash: PHC(2), passwordCredentialId: "b", grant: "grant-2" });
    expect(d.uow.state.mailboxPasswords).toEqual([
      { mailboxId: "m1", pendingHash: null, credentialId: "b", grant: null },
    ]);
    // Run again with nothing waiting: a no-op.
    await enqueueProvisioning(d, { kind: "mailbox.password", subjectId: "m1" });
    await runNextJob(d, mail);
    expect(mail.boxes[0]?.passwordCredentialId).toBe("b");
  });

  it("keeps a newer password set while the job ran for its own job", async () => {
    const { d } = setup();
    const mail = fakeMailServer();
    await provision(d, mail);
    await d.uow.run((r) => r.mailboxPasswords.setPending("m1", PHC(3), "grant-3"));
    const set = mail.setMailboxPassword.bind(mail);
    mail.setMailboxPassword = async (input) => {
      const out = await set(input);
      d.uow.state.mailboxPasswords[0]!.pendingHash = PHC(4); // a second change landed meanwhile
      return out;
    };
    await enqueueProvisioning(d, { kind: "mailbox.password", subjectId: "m1" });
    await runNextJob(d, mail);
    expect(d.uow.state.mailboxPasswords[0]).toMatchObject({ pendingHash: PHC(4), credentialId: "b" });
  });

  it("retries while the account isn't on the mail server, drops the hash for a deleting mailbox", async () => {
    const { d } = setup();
    const mail = fakeMailServer();
    d.uow.state.mailboxPasswords.push({ mailboxId: "m1", pendingHash: PHC(5), credentialId: null });
    await enqueueProvisioning(d, { kind: "mailbox.password", subjectId: "m1" });
    await runNextJob(d, mail);
    expect(d.uow.state.jobs[0]).toMatchObject({
      status: "queued",
      lastError: "Error: mailbox is not on the mail server yet",
    });
    d.uow.state.mailboxes[0]!.status = "deleting";
    d.uow.state.mailboxes[0]!.stalwartId = "acc:owner@example.test";
    d.uow.state.jobs = [];
    await enqueueProvisioning(d, { kind: "mailbox.password", subjectId: "m1" });
    await runNextJob(d, mail);
    expect(d.uow.state.mailboxPasswords[0]?.pendingHash).toBeNull();
  });

  it("gives up after the last attempt: an administrator's password is kept (marked failed), status untouched, audited", async () => {
    const { d, clock } = setup();
    const ok = fakeMailServer();
    await provision(d, ok);
    const failing = { ...ok, setMailboxPassword: () => Promise.reject(new Error("mail server unavailable")) };
    await d.uow.run((r) => r.mailboxPasswords.setPending("m1", PHC(6), "grant-6"));
    await enqueueProvisioning(d, { kind: "mailbox.password", subjectId: "m1" });
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await runNextJob(d, failing);
      clock.set(new Date(clock.now().getTime() + backoffMs(i + 1)));
    }
    // Kept, so the mailbox can't change its own password with the old one and the console asks for it again.
    expect(d.uow.state.mailboxPasswords[0]).toMatchObject({ pendingHash: PHC(6), credentialId: "a" });
    expect(d.uow.state.mailboxes[0]?.status).toBe("active");
    const entry = d.uow.state.audit.at(-1);
    expect(entry).toMatchObject({
      action: "platform.provisioning_failed",
      target: { type: "mailbox.password" },
      meta: { adminPasswordKept: true },
    });
    expect(JSON.stringify(entry)).not.toContain("argon2id");
    // Setting it again replaces it and applies.
    await d.uow.run((r) => r.mailboxPasswords.setPending("m1", PHC(12), "grant-12"));
    await enqueueProvisioning(d, { kind: "mailbox.password", subjectId: "m1" });
    await runNextJob(d, ok);
    expect(ok.boxes[0]).toMatchObject({ passwordHash: PHC(12) });
    expect(d.uow.state.mailboxPasswords[0]).toMatchObject({ pendingHash: null });
  });

  it("gives up on a deleting mailbox's password without keeping it", async () => {
    const { d, clock } = setup();
    const ok = fakeMailServer();
    await provision(d, ok);
    const failing = { ...ok, setMailboxPassword: () => Promise.reject(new Error("mail server unavailable")) };
    await d.uow.run((r) => r.mailboxPasswords.setPending("m1", PHC(13), "grant-13"));
    await enqueueProvisioning(d, { kind: "mailbox.password", subjectId: "m1" });
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      await runNextJob(d, failing);
      clock.set(new Date(clock.now().getTime() + backoffMs(i + 1)));
    }
    // Scheduled for deletion before the last attempt, which fails anyway (e.g. a stale read).
    const failingLast = {
      ...failing,
      setMailboxPassword: () => {
        d.uow.state.mailboxes[0]!.status = "deleting";
        return Promise.reject(new Error("mail server unavailable"));
      },
    };
    await runNextJob(d, failingLast);
    expect(d.uow.state.jobs.find((j) => j.kind === "mailbox.password")?.status).toBe("failed");
    expect(d.uow.state.mailboxPasswords[0]?.pendingHash).toBeNull();
  });

  describe("first-sign-in password change", () => {
    const flagged = (d: ReturnType<typeof setup>["d"]) => d.uow.state.mailboxes[0]?.mustChangePassword;

    it("ends only once the person's own password has reached the mail server", async () => {
      const { d } = setup();
      const mail = fakeMailServer();
      await provision(d, mail);
      d.uow.state.mailboxes[0]!.mustChangePassword = true;
      await d.uow.run((r) => r.mailboxPasswords.setPending("m1", PHC(7), "grant-7", { byOwner: true }));
      await enqueueProvisioning(d, { kind: "mailbox.password", subjectId: "m1" });
      expect(flagged(d)).toBe(true); // queued is not applied
      expect(await d.uow.run((r) => r.directory.getMailbox("m1"))).toMatchObject({ pendingPasswordByOwner: true });
      await runNextJob(d, mail);
      expect(mail.boxes[0]).toMatchObject({ passwordHash: PHC(7) });
      expect(flagged(d)).toBe(false);
      expect(await d.uow.run((r) => r.directory.getMailbox("m1"))).toMatchObject({
        pendingPasswordHash: null,
        pendingPasswordByOwner: false,
      });
    });

    it("stays required after an administrator's reset is applied", async () => {
      const { d } = setup();
      const mail = fakeMailServer();
      await provision(d, mail);
      d.uow.state.mailboxes[0]!.mustChangePassword = true;
      await d.uow.run((r) => r.mailboxPasswords.setPending("m1", PHC(8), "grant-8"));
      await enqueueProvisioning(d, { kind: "mailbox.password", subjectId: "m1" });
      await runNextJob(d, mail);
      expect(mail.boxes[0]).toMatchObject({ passwordHash: PHC(8) });
      expect(flagged(d)).toBe(true);
    });

    it("stays required when the person's password never reached the mail server", async () => {
      const { d, clock } = setup();
      const ok = fakeMailServer();
      await provision(d, ok);
      d.uow.state.mailboxes[0]!.mustChangePassword = true;
      const failing = { ...ok, setMailboxPassword: () => Promise.reject(new Error("mail server unavailable")) };
      await d.uow.run((r) => r.mailboxPasswords.setPending("m1", PHC(9), "grant-9", { byOwner: true }));
      await enqueueProvisioning(d, { kind: "mailbox.password", subjectId: "m1" });
      await runNextJob(d, failing);
      expect(flagged(d)).toBe(true); // retrying
      for (let i = 1; i < MAX_ATTEMPTS; i++) {
        clock.set(new Date(clock.now().getTime() + backoffMs(i)));
        await runNextJob(d, failing);
      }
      expect(d.uow.state.jobs.find((j) => j.kind === "mailbox.password")?.status).toBe("failed");
      expect(flagged(d)).toBe(true);
      expect(await d.uow.run((r) => r.directory.getMailbox("m1"))).toMatchObject({
        pendingPasswordHash: null,
        pendingPasswordByOwner: false,
      });
    });

    it("an administrator's newer password replaces the person's waiting one and doesn't end the change", async () => {
      const { d } = setup();
      const mail = fakeMailServer();
      await provision(d, mail);
      d.uow.state.mailboxes[0]!.mustChangePassword = true;
      await d.uow.run((r) => r.mailboxPasswords.setPending("m1", PHC(10), "g", { byOwner: true }));
      await d.uow.run((r) => r.mailboxPasswords.setPending("m1", PHC(11), "g"));
      await enqueueProvisioning(d, { kind: "mailbox.password", subjectId: "m1" });
      await runNextJob(d, mail);
      expect(mail.boxes[0]).toMatchObject({ passwordHash: PHC(11) });
      expect(flagged(d)).toBe(true);
    });
  });

  it("records the Password of a mailbox from before tracking once, and never overwrites a recorded one", async () => {
    const { d } = setup();
    const mail = fakeMailServer();
    await provision(d, mail);
    d.uow.state.mailboxPasswords[0]!.credentialId = null; // as if migrated from before
    await enqueueProvisioning(d, { kind: "mailbox.ensure", subjectId: "m1" });
    await runNextJob(d, mail);
    expect(d.uow.state.mailboxPasswords[0]?.credentialId).toBe("a");
    mail.boxes[0]!.passwordCredentialId = "z"; // replaced behind our back
    await enqueueProvisioning(d, { kind: "mailbox.ensure", subjectId: "m1" });
    await runNextJob(d, mail);
    expect(d.uow.state.mailboxPasswords[0]?.credentialId).toBe("a"); // the reconciler still sees the difference
  });

  it("drops the hash of a creation that gave up before the account existed", async () => {
    const { d, clock } = setup();
    const mail: MailServer = { ...fakeMailServer(), ensureMailbox: () => Promise.reject(new Error("quota refused")) };
    d.uow.state.mailboxPasswords.push({ mailboxId: "m1", pendingHash: PHC(7), credentialId: null });
    await enqueueProvisioning(d, { kind: "mailbox.ensure", subjectId: "m1" });
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await runNextJob(d, mail);
      clock.set(new Date(clock.now().getTime() + backoffMs(i + 1)));
    }
    expect(d.uow.state.mailboxes[0]?.status).toBe("failed");
    expect(d.uow.state.mailboxPasswords[0]?.pendingHash).toBeNull();
  });
});

describe("a worker that stalled past the stale limit never pushes what it read before", () => {
  /** Counts the mail server calls that change something. */
  function counted(mail: ReturnType<typeof fakeMailServer>) {
    const calls: string[] = [];
    const wrap = (k: "ensureDomain" | "ensureMailbox" | "setMailboxPassword" | "removeDomain") => {
      const m = mail as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const orig = m[k];
      if (!orig) throw new Error(`no ${k}`);
      m[k] = (...args: unknown[]) => {
        calls.push(k);
        return orig(...args);
      };
    };
    wrap("ensureDomain");
    wrap("ensureMailbox");
    wrap("setMailboxPassword");
    wrap("removeDomain");
    return calls;
  }

  const provisioned = async () => {
    const { d, clock } = setup();
    const mail = fakeMailServer();
    await enqueueProvisioning(d, { kind: "domain.ensure", subjectId: "d1" });
    await enqueueProvisioning(d, { kind: "mailbox.ensure", subjectId: "m1" });
    while (await runNextJob(d, mail));
    return { d, clock, mail, calls: counted(mail) };
  };

  /** Worker A claims; it stalls past the limit; `change` happens; worker B takes over and runs everything; A resumes. */
  async function stalledThenResumed(
    t: Awaited<ReturnType<typeof provisioned>>,
    kind: "mailbox.ensure" | "mailbox.password" | "domain.ensure",
    subjectId: string,
    change: () => Promise<void> | void,
  ) {
    await enqueueProvisioning(t.d, { kind, subjectId });
    const a = await t.d.uow.run((r) => r.provisioning.claimNext(t.clock.now()));
    if (!a) throw new Error("claim expected");
    t.clock.set(new Date(t.clock.now().getTime() + STALE_RUNNING_MS + 1));
    await change();
    await enqueueProvisioning(t.d, { kind, subjectId });
    while (await runNextJob(t.d, t.mail)); // worker B: takes over A's job, then the newer one
    const before = [...t.calls];
    const resumed = await runClaimedJob(t.d, t.mail, a);
    return { resumed, before, after: t.calls };
  }

  it("mailbox.password: the old hash never replaces the newer one", async () => {
    const t = await provisioned();
    await t.d.uow.run((r) => r.mailboxPasswords.setPending("m1", PHC(1), "grant-1"));
    const { resumed, before, after } = await stalledThenResumed(t, "mailbox.password", "m1", () =>
      t.d.uow.run((r) => r.mailboxPasswords.setPending("m1", PHC(2), "grant-2")),
    );
    expect(resumed.lockLost).toBe(true);
    expect(after).toEqual(before); // A called nothing
    expect(t.mail.boxes[0]).toMatchObject({ passwordHash: PHC(2), grant: "grant-2" });
    expect(t.d.uow.state.mailboxPasswords[0]).toMatchObject({ pendingHash: null });
    expect(t.d.uow.state.audit.some((e) => e.action === "platform.provisioning_failed")).toBe(false);
  });

  it("mailbox.ensure: a suspension made meanwhile isn't lifted, and the aliases stay as they are now", async () => {
    const t = await provisioned();
    const { resumed, after, before } = await stalledThenResumed(t, "mailbox.ensure", "m1", () => {
      t.d.uow.state.mailboxes[0]!.status = "suspended";
      t.d.uow.state.aliases = [];
    });
    expect(resumed.lockLost).toBe(true);
    expect(after).toEqual(before);
    expect(t.mail.boxes[0]).toMatchObject({ suspended: true, aliases: [] });
    expect(t.d.uow.state.mailboxes[0]).toMatchObject({ status: "suspended" });
  });

  it("domain.ensure: a catch-all turned off meanwhile isn't turned back on", async () => {
    const t = await provisioned();
    t.d.uow.state.catchAll.push({ domainId: "d1", mailboxId: "m1" });
    const { resumed, after, before } = await stalledThenResumed(t, "domain.ensure", "d1", () => {
      t.d.uow.state.catchAll = [];
    });
    expect(resumed.lockLost).toBe(true);
    expect(after).toEqual(before);
    expect(t.mail.catchAll.get("example.test")).toBeNull();
  });

  it("a stall inside a call: the writes after it are refused, nothing is recorded, the newer claim decides", async () => {
    const t = await provisioned();
    await enqueueProvisioning(t.d, { kind: "mailbox.ensure", subjectId: "m1" });
    const a = await t.d.uow.run((r) => r.provisioning.claimNext(t.clock.now()));
    if (!a) throw new Error("claim expected");
    const base = fakeMailServer();
    let stalled = false;
    let takeover: { lockLost: boolean } | null = null;
    const stalling: MailServer = {
      ...base,
      ensureMailbox: async (input) => {
        if (!stalled) {
          stalled = true;
          t.clock.set(new Date(t.clock.now().getTime() + STALE_RUNNING_MS + 1));
          takeover = await runNextJob(t.d, base); // worker B takes the job over and finishes it
          t.d.uow.state.mailboxes[0]!.lastError = "after B";
        }
        return base.ensureMailbox(input);
      },
    };
    const resumed = await runClaimedJob(t.d, stalling, a);
    expect(takeover).toMatchObject({ lockLost: false });
    expect(resumed.lockLost).toBe(true);
    // A's directory write after its call never landed (it would have cleared lastError).
    expect(t.d.uow.state.mailboxes[0]).toMatchObject({ lastError: "after B" });
    expect(t.d.uow.state.jobs.find((j) => j.id === a.id)).toMatchObject({ status: "succeeded", attempts: 2 });
  });

  it("a worker still working renews its lease before each call, so it isn't taken over", async () => {
    const t = await provisioned();
    await enqueueProvisioning(t.d, { kind: "mailbox.ensure", subjectId: "m1" });
    const a = await t.d.uow.run((r) => r.provisioning.claimNext(t.clock.now()));
    if (!a) throw new Error("claim expected");
    t.clock.set(new Date(t.clock.now().getTime() + STALE_RUNNING_MS - 1_000));
    expect((await runClaimedJob(t.d, t.mail, a)).lockLost).toBe(false);
    expect(t.d.uow.state.jobs.find((j) => j.id === a.id)).toMatchObject({ status: "succeeded", attempts: 1 });
  });
});
