// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ACCOUNT_A, req } from "../__tests__/helpers";
import { fakeSealer, importWorld, MBX_MEMBER, member, SESSION, SOURCE } from "../__tests__/imports";
import { reconcileAppPasswords } from "../app-passwords/service";
import type { AppPasswordInventory } from "../app-passwords/ports";
import type { MailServer } from "../provisioning/ports";
import { runNextJob } from "../provisioning/service";
import { expireImports, LAST_PASS_GRACE_MS } from "./expiry";
import type { ImportTrainingSamples } from "./ports";
import { cancelImport, pauseImport, startImport } from "./service";

type Cred = { credentialId: string; createdAt: Date };

function fakeMail(server: Map<string, Cred[]>) {
  const revoked: string[] = [];
  const mail = {
    importCredentials: async (externalId: string) => server.get(externalId) ?? [],
    revokeAppPassword: async (input: { externalId: string; credentialId: string; createdAt: Date }) => {
      revoked.push(input.credentialId);
      server.set(
        input.externalId,
        (server.get(input.externalId) ?? []).filter((c) => c.credentialId !== input.credentialId),
      );
    },
  } as unknown as MailServer;
  return { mail, revoked };
}

async function setup() {
  const w = importWorld();
  const ctx = { issuer: w.issuer, sealer: fakeSealer };
  const start = async (options: Record<string, unknown> = {}) =>
    (
      await startImport(
        w.d,
        ctx,
        member,
        ACCOUNT_A,
        { mailboxId: MBX_MEMBER, ...SOURCE, options },
        { sessionId: SESSION },
        req,
      )
    ).import;
  const server = new Map<string, Cred[]>();
  const onServer = () => server.get("s-dddd") ?? [];
  // What the fake issuer minted is what the mail server holds.
  const sync = () => {
    server.set(
      "s-dddd",
      w.issuer.minted
        .filter((m) => !w.issuer.destroyed.includes(m.id))
        .filter((m) => !revokedIds.has(m.id))
        .map((m) => ({ credentialId: m.id, createdAt: w.clock.now() })),
    );
  };
  const revokedIds = new Set<string>();
  return { ...w, ctx, start, server, onServer, sync, revokedIds };
}

describe("mail_import.credential_revoke", () => {
  it("takes an ended import's credential off and audits it in the account's log", async () => {
    const t = await setup();
    const v = await t.start();
    t.sync();
    await cancelImport(t.d, member, ACCOUNT_A, v.id, req);
    const { mail, revoked } = fakeMail(t.server);
    const job = await runNextJob(t.d, mail);
    expect(job?.kind).toBe("mail_import.credential_revoke");
    expect(revoked).toEqual(["cred-1"]);
    expect(t.onServer()).toEqual([]);
    const audit = t.s.audit.find((a) => a.action === "data.import_credentials_wiped");
    expect(audit?.meta).toMatchObject({ importId: v.id, credentialRevoked: 1, sealedCleared: true });
    expect(audit?.scope).toBe(`account:${ACCOUNT_A}`);
  });

  it("keeps the credential a live import of the mailbox holds", async () => {
    const t = await setup();
    const v = await t.start();
    t.sync();
    // An orphan from before, with the same description and permissions.
    t.server.set("s-dddd", [...t.onServer(), { credentialId: "orphan", createdAt: new Date(0) }]);
    await t.d.uow.run((r) =>
      r.provisioning.enqueue({ kind: "mail_import.credential_revoke", subjectId: v.id, runAfter: t.clock.now() }),
    );
    const { mail, revoked } = fakeMail(t.server);
    await runNextJob(t.d, mail);
    expect(revoked).toEqual(["orphan"]);
    expect(t.onServer().map((c) => c.credentialId)).toEqual(["cred-1"]);
  });

  it("gives up after its retries with an alert in the platform log and a failed entry for the account", async () => {
    const t = await setup();
    const v = await t.start();
    await cancelImport(t.d, member, ACCOUNT_A, v.id, req);
    const broken = {
      importCredentials: async () => {
        throw new Error("mail server down");
      },
    } as unknown as MailServer;
    for (let i = 0; i < 5; i++) {
      for (const j of t.s.jobs) j.runAfter = t.clock.now();
      await runNextJob(t.d, broken);
    }
    expect(t.s.audit.some((a) => a.action === "platform.provisioning_failed")).toBe(true);
    expect(t.s.audit.find((a) => a.action === "data.import_credentials_wiped")?.meta).toMatchObject({
      gaveUp: true,
    });
  });
});

describe("mail_import.training_cleanup", () => {
  it("removes the samples of the slice's window with the training key, and fails without one", async () => {
    const t = await setup();
    const v = await t.start();
    const calls: { account: string; from: number; to: number }[] = [];
    const training: ImportTrainingSamples = {
      async removeImported(account, window) {
        calls.push({ account, from: window.from.getTime(), to: window.to.getTime() });
        return { removed: 3 };
      },
      removeAccount: async () => ({ removed: 0 }),
    };
    await t.d.uow.run((r) =>
      r.provisioning.enqueue({
        kind: "mail_import.training_cleanup",
        subjectId: `${v.id}:1000:2000`,
        runAfter: t.clock.now(),
      }),
    );
    const { mail } = fakeMail(t.server);
    const failed = await runNextJob(t.d, mail);
    expect(failed?.kind).toBe("mail_import.training_cleanup");
    expect(t.s.jobs.find((j) => j.kind === "mail_import.training_cleanup")?.lastError).toMatch(/no spam-training/);
    for (const j of t.s.jobs) j.runAfter = t.clock.now();
    await runNextJob(t.d, mail, { trainingSamples: training });
    expect(calls).toEqual([{ account: "s-dddd", from: 1000, to: 2000 }]);
  });

  it("refuses a malformed subject and does nothing for an import that's gone", async () => {
    const t = await setup();
    await t.d.uow.run(async (r) => {
      await r.provisioning.enqueue({
        kind: "mail_import.training_cleanup",
        subjectId: "x:a:b",
        runAfter: t.clock.now(),
      });
    });
    const { mail } = fakeMail(t.server);
    await runNextJob(t.d, mail, {
      trainingSamples: { removeImported: async () => ({ removed: 0 }), removeAccount: async () => ({ removed: 0 }) },
    });
    expect(t.s.jobs[0]?.lastError).toMatch(/not <import>/);
    await t.d.uow.run((r) =>
      r.provisioning.enqueue({
        kind: "mail_import.training_cleanup",
        subjectId: "11111111-0000-4000-8000-000000000000:1:2",
        runAfter: t.clock.now(),
      }),
    );
    for (const j of t.s.jobs) j.status = j.subjectId.startsWith("x:") ? "failed" : j.status;
    const done = await runNextJob(t.d, mail);
    expect(done?.lockLost).toBe(false);
  });
});

describe("expireImports", () => {
  it("fails paused imports past their credential, ends finished syncs, and wipes leftovers", async () => {
    const t = await setup();
    const paused = await t.start();
    await pauseImport(t.d, member, ACCOUNT_A, paused.id, req);
    t.clock.set(new Date("2026-11-13T00:00:00Z"));
    const r1 = await expireImports(t.d);
    expect(r1).toEqual({ leftoversWiped: 0, expired: 1, syncEnded: 0 });
    expect(t.s.mailImports.find((i) => i.id === paused.id)).toMatchObject({
      status: "failed",
      errorCode: "expired",
      destinationSecret: null,
    });

    t.s.stepUps.push({ userId: "member", sessionId: SESSION, expiresAt: new Date(t.clock.now().getTime() + 60_000) });
    const syncing = await t.start({ sync: true });
    const row = t.s.mailImports.find((i) => i.id === syncing.id);
    if (!row) throw new Error("no row");
    row.status = "syncing";
    // Stopped by the person a moment ago: the last pass gets its grace period first.
    row.syncUntil = t.clock.now();
    expect((await expireImports(t.d)).syncEnded).toBe(0);
    t.clock.set(new Date(t.clock.now().getTime() + LAST_PASS_GRACE_MS + 1000));
    expect((await expireImports(t.d)).syncEnded).toBe(1);
    expect(t.s.audit.filter((a) => a.action === "data.import_sync_stopped").at(-1)?.meta).toMatchObject({
      reason: "window_ended",
    });

    // A syncing import a runner holds when its window ends: what that runner appended gets a clean-up (SA-65-02).
    t.s.stepUps.push({ userId: "member", sessionId: SESSION, expiresAt: new Date(t.clock.now().getTime() + 60_000) });
    const leased = await t.start({ sync: true });
    const lrow = t.s.mailImports.find((i) => i.id === leased.id);
    if (!lrow) throw new Error("no row");
    lrow.status = "syncing";
    lrow.leaseToken = "runner";
    lrow.leaseUntil = new Date(t.clock.now().getTime() + 30_000);
    lrow.syncUntil = new Date(t.clock.now().getTime() - 1000);
    lrow.destinationCredentialExpiresAt = new Date(t.clock.now().getTime() - 1000);
    expect((await expireImports(t.d)).syncEnded).toBe(1);
    expect(
      t.s.jobs.some((j) => j.kind === "mail_import.training_cleanup" && j.subjectId.startsWith(`${leased.id}:`)),
    ).toBe(true);

    // A terminal row that somehow kept a secret is wiped (Postgres refuses such a row; memory lets the test make one).
    const ended = t.s.mailImports.find((i) => i.id === paused.id);
    if (ended) ended.sourceSecret = "sealed:left";
    expect((await expireImports(t.d)).leftoversWiped).toBe(1);
    expect(ended?.sourceSecret).toBeNull();
  });
});

describe("reconciler and import credentials", () => {
  function inventory(server: Map<string, Cred[]>): AppPasswordInventory {
    return {
      list: async (externalId) => ({
        appPasswords: [],
        apiKeys: 0,
        passwords: 1,
        passwordIds: ["p"],
        importCredentials: server.get(externalId) ?? [],
      }),
    };
  }

  it("expects a live import's credential, reports any other and queues its import's revoke", async () => {
    const t = await setup();
    for (const m of t.s.mailboxes) t.s.mailboxPasswords.push({ mailboxId: m.id, pendingHash: null, credentialId: "p" });
    const v = await t.start();
    t.sync();
    const clean = await reconcileAppPasswords(t.d, inventory(t.server));
    expect(clean.importCredentialsOrphaned).toBe(0);
    t.server.set("s-dddd", [...t.onServer(), { credentialId: "orphan", createdAt: new Date(0) }]);
    const drift = await reconcileAppPasswords(t.d, inventory(t.server));
    expect(drift).toMatchObject({ importCredentialsOrphaned: 1, clean: false });
    expect(t.s.jobs.some((j) => j.kind === "mail_import.credential_revoke" && j.subjectId === v.id)).toBe(true);
    // Once the import ends, its own credential is no longer expected either.
    await cancelImport(t.d, member, ACCOUNT_A, v.id, req);
    expect((await reconcileAppPasswords(t.d, inventory(t.server))).importCredentialsOrphaned).toBe(2);
  });
});

describe("mailbox.training_purge", () => {
  it("removes a destroyed account's samples made before its destroy, fails without the training key", async () => {
    const t = await setup();
    const calls: { account: string; at: number }[] = [];
    const training: ImportTrainingSamples = {
      removeImported: async () => ({ removed: 0 }),
      async removeAccount(account, destroyedAt) {
        calls.push({ account, at: destroyedAt.getTime() });
        return { removed: 2 };
      },
    };
    await t.d.uow.run((r) =>
      r.provisioning.enqueue({ kind: "mailbox.training_purge", subjectId: "s:dd:ee:1500", runAfter: t.clock.now() }),
    );
    const { mail } = fakeMail(t.server);
    await runNextJob(t.d, mail);
    expect(t.s.jobs.find((j) => j.kind === "mailbox.training_purge")?.lastError).toMatch(/no spam-training/);
    for (const j of t.s.jobs) j.runAfter = t.clock.now();
    await runNextJob(t.d, mail, { trainingSamples: training });
    // The account id may hold colons: only the last part is the time.
    expect(calls).toEqual([{ account: "s:dd:ee", at: 1500 }]);
    expect(t.s.jobs.find((j) => j.kind === "mailbox.training_purge")?.status).toBe("succeeded");
  });

  it("refuses a malformed subject", async () => {
    const t = await setup();
    const training: ImportTrainingSamples = {
      removeImported: async () => ({ removed: 0 }),
      removeAccount: async () => ({ removed: 0 }),
    };
    for (const subjectId of ["no-time", ":1500", "acct:soon"]) {
      await t.d.uow.run((r) =>
        r.provisioning.enqueue({ kind: "mailbox.training_purge", subjectId, runAfter: t.clock.now() }),
      );
    }
    const { mail } = fakeMail(t.server);
    for (let i = 0; i < 3; i++) await runNextJob(t.d, mail, { trainingSamples: training });
    expect(t.s.jobs.map((j) => j.lastError)).toEqual(
      Array.from({ length: 3 }, () => expect.stringMatching(/not <account>/) as unknown),
    );
  });
});
