// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import { DelegatedMailboxRefusedError, type Deps, ForbiddenError } from "@anhourmail/core";
import type { DelegationRight } from "@anhourmail/core/delegation";
import type { Mailbox } from "@anhourmail/core/mailboxes";
import {
  delegatedMailboxesFor,
  delegationCheck,
  DelegationGate,
  openDelegatedMailbox,
  type WebmailAccess,
} from "@anhourmail/core/webmail";
import { createKeyRing } from "@anhourmail/server/keyring";
import { setLogSinkForTests } from "@anhourmail/server/log";
import { memorySlidingQuota } from "@anhourmail/server/rate-limit";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

import { WebmailSettingsService, WebmailSignaturesService } from "@anhourmail/core/webmail";

import { mailExportStream } from "./export";
import { checkJmapRequest, setsSenderFields } from "./jmap-policy";
import { changeWebmailPassword } from "./password";
import { WebmailSettings } from "./settings";
import {
  GrantRefusedError,
  type OAuthTokens,
  WebmailDelegationRefusedError,
  WebmailOwnMailboxOnlyError,
  WebmailService,
  WebmailSignedOutError,
} from "./service";
import { memoryKv, type WebmailSession, WebmailSessionStore } from "./session-store";

const MAIL = "urn:ietf:params:jmap:mail";
const CORE = "urn:ietf:params:jmap:core";
const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";
const DESK = "aaaaaaaa-0000-4000-8000-000000000001";
const KIM_BOX = "aaaaaaaa-0000-4000-8000-000000000002";
const LEE_BOX = "aaaaaaaa-0000-4000-8000-000000000003";
const B_DESK = "bbbbbbbb-0000-4000-8000-000000000001";
const req = { requestId: "req-dlg", ip: "203.0.113.9", userAgent: "vitest" };

beforeEach(() => {
  setLogSinkForTests(() => undefined);
});
afterEach(() => {
  setLogSinkForTests(null);
});

/**
 * The BFF over the real core delegation code on the in-memory adapter: Kim (a member of account A) signs in to her own
 * mailbox; desk@ (shared) and lee@ are in the same account, desk@b.test in another. Tokens name their mailbox
 * (`at-<address>`), so the fake mail server answers each with its own account.
 */
function setup() {
  let now = 1_000_000;
  const uow = new MemoryUnitOfWork();
  const s = uow.state;
  const deps: Deps = { uow, clock: { now: () => new Date(now) }, platform: PUBLIC_PLATFORM };
  s.accounts.push({ id: ACCOUNT_A, name: "A", plan: "plus" }, { id: ACCOUNT_B, name: "B", plan: "plus" });
  for (const [id, accountId] of [
    ["kim", ACCOUNT_A],
    ["lee", ACCOUNT_A],
    ["bea", ACCOUNT_B],
  ] as const) {
    s.userEmails[id] = `${id}@console.test`;
    s.memberships.push({ userId: id, accountId, role: "member" });
  }
  const box = (id: string, accountId: string, address: string, userId: string | null): Mailbox => ({
    id,
    accountId,
    userId,
    address,
    status: "active",
    quotaBytes: 1,
    stalwartId: `s-${address}`,
    lastError: null,
    purgeAfter: null,
    createdAt: new Date(0),
  });
  s.mailboxes.push(
    box(DESK, ACCOUNT_A, "desk@family.test", null),
    box(KIM_BOX, ACCOUNT_A, "kim@family.test", "kim"),
    box(LEE_BOX, ACCOUNT_A, "lee@family.test", "lee"),
    box(B_DESK, ACCOUNT_B, "desk@b.test", null),
  );
  const grant = (mailboxId: string, right: DelegationRight, userId = "kim") =>
    s.delegations.push({
      id: `${mailboxId}-${userId}-${right}`,
      accountId: ACCOUNT_A,
      mailboxId,
      granteeUserId: userId,
      right,
      grantedBy: "owner",
      createdAt: new Date(0),
    });
  const states: Record<string, WebmailAccess> = {};
  const access = { state: async (a: string) => states[a] ?? ("ok" as const) };
  const minted: string[] = [];
  const calls: { url: string; auth: string }[] = [];
  let upstreamStatus = 200;
  /** Tokens the mail server no longer accepts (their mailbox's password was reset), by mailbox. */
  const revoked = new Set<string>();
  const sieveWrites: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    calls.push({ url, auth });
    const who = auth.replace(/^Bearer at-/, "").replace(/-r\d+$/, "");
    if (revoked.has(who)) return new Response(null, { status: 401 });
    if (url.endsWith("/jmap/session"))
      return Response.json({ username: who, primaryAccounts: { [MAIL]: `acc-${who}` } });
    if (upstreamStatus !== 200) return new Response(null, { status: upstreamStatus });
    return Response.json({ methodResponses: [["Mailbox/get", { list: [] }, "m"]] });
  }) as typeof fetch;
  const refreshRefused = new Set<string>();
  const store = new WebmailSessionStore(
    memoryKv(() => now),
    createKeyRing([{ id: "k1", key: randomBytes(32) }]),
    {
      now: () => now,
    },
  );
  const svc = new WebmailService({
    store,
    oauth: {
      signIn: async (name, secret): Promise<OAuthTokens> => {
        if (secret !== "right") throw new GrantRefusedError("no");
        return { accessToken: `at-${name}`, refreshToken: `rt-${name}`, expiresAt: now + 3_600_000 };
      },
      refresh: async (token) => {
        const who = token.replace(/^rt-/, "");
        if (refreshRefused.has(who)) throw new GrantRefusedError("revoked");
        return { accessToken: `at-${who}-r1`, refreshToken: token, expiresAt: now + 3_600_000 };
      },
    },
    handoffSignIn: async ({ address }) => {
      minted.push(address);
      return { accessToken: `at-${address}`, refreshToken: `rt-${address}`, expiresAt: now + 3_600_000 };
    },
    delegation: {
      list: (owners) => delegatedMailboxesFor(deps, owners),
      open: (input, signIn, r) => openDelegatedMailbox(deps, access, input, signIn, r),
      // Never cached here, so every revoke shows at once (the cache is core's, tested there).
      gate: new DelegationGate(delegationCheck(deps, access), { ttlMs: 0, now: () => now }),
    },
    consoleSessionAlive: async () => true,
    stalwartUrl: "http://stalwart:8080",
    access,
    quota: memorySlidingQuota(),
    sieve: {
      read: async () => null,
      write: async (accountId) => {
        sieveWrites.push(accountId);
      },
    },
    confirmedForward: async () => null,
    fetch: fetchImpl,
    now: () => now,
    sleep: async () => undefined,
  });
  const audits = () => s.audit.filter((e) => e.action === "delegation.mailbox_opened");
  return {
    svc,
    s,
    store,
    grant,
    states,
    minted,
    calls,
    audits,
    refreshRefused,
    revoked,
    sieveWrites,
    deps,
    setUpstream: (status: number) => {
      upstreamStatus = status;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("mailboxes shared with the person in the webmail (ADR-0026 §6)", () => {
  it("lists what is shared with the session's person, without minting anything", async () => {
    const t = setup();
    t.grant(DESK, "full_access");
    t.grant(DESK, "send_as");
    t.grant(LEE_BOX, "send_on_behalf");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    expect(await t.svc.mailboxes(sessionId)).toEqual({
      active: "kim@family.test",
      activeShared: false,
      others: [],
      shared: [
        {
          address: "desk@family.test",
          via: "kim@family.test",
          fullAccess: true,
          sendAs: true,
          sendOnBehalf: false,
          open: false,
        },
        {
          address: "lee@family.test",
          via: "kim@family.test",
          fullAccess: false,
          sendAs: false,
          sendOnBehalf: true,
          open: false,
        },
      ],
    });
    expect(t.minted).toEqual([]);
  });

  it("opens one with that mailbox's own token, sealed in this session, and reads through it", async () => {
    const t = setup();
    t.grant(DESK, "full_access");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    const opened = await t.svc.openDelegated(sessionId, " Desk@Family.test ", req);
    expect(opened).toMatchObject({
      username: "desk@family.test",
      accountId: "acc-desk@family.test",
      delegated: { mailboxId: DESK, granteeUserId: "kim", via: "kim@family.test" },
    });
    expect(opened.others?.map((m) => m.username)).toEqual(["kim@family.test"]);
    expect(t.minted).toEqual(["desk@family.test"]);
    expect(t.audits()).toHaveLength(1);
    await t.svc.jmap(sessionId, { using: [CORE, MAIL], methodCalls: [["Mailbox/get", { accountId: "x" }, "m"]] });
    expect(t.calls.at(-1)?.auth).toBe("Bearer at-desk@family.test");
    expect((await t.svc.mailboxes(sessionId))?.shared[0]).toMatchObject({ address: "desk@family.test", open: true });
    // Opening it again just switches to it: no second credential.
    await t.svc.switchMailbox(sessionId, "kim@family.test");
    await t.svc.openDelegated(sessionId, "desk@family.test", req);
    expect(t.minted).toEqual(["desk@family.test"]);
    expect((await t.svc.session(sessionId))?.username).toBe("desk@family.test");
  });

  it("gives one answer for no grant, a send-only grant, an unknown address and another account's mailbox", async () => {
    const t = setup();
    t.grant(LEE_BOX, "send_as");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    for (const address of ["desk@family.test", "lee@family.test", "nobody@family.test", "desk@b.test"]) {
      const err = await t.svc.openDelegated(sessionId, address, req).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DelegatedMailboxRefusedError);
      expect((err as Error).message).toBe("You don't have access to this mailbox.");
    }
    expect(t.minted).toEqual([]);
    expect((await t.svc.session(sessionId))?.username).toBe("kim@family.test");
    expect(t.audits().every((e) => e.scope === `account:${ACCOUNT_A}` && e.result === "denied")).toBe(true);
  });

  it("drops the entry on the next use after a revoke, a plan downgrade or a suspension, and keeps the person's own", async () => {
    for (const change of ["revoke", "plan", "suspended", "removed"] as const) {
      const t = setup();
      t.grant(DESK, "full_access");
      const { sessionId } = await t.svc.signIn("kim@family.test", "right");
      await t.svc.openDelegated(sessionId, "desk@family.test", req);
      if (change === "revoke") t.s.delegations = [];
      if (change === "plan") t.s.accounts[0] = { id: ACCOUNT_A, name: "A", plan: "free" };
      if (change === "suspended") {
        t.states["desk@family.test"] = "suspended";
        const desk = t.s.mailboxes.find((m) => m.id === DESK);
        if (desk) desk.status = "suspended";
      }
      if (change === "removed") t.s.memberships = t.s.memberships.filter((m) => m.userId !== "kim");
      await expect(t.svc.session(sessionId)).rejects.toBeInstanceOf(WebmailDelegationRefusedError);
      const after = await t.svc.session(sessionId);
      expect(after?.username).toBe("kim@family.test");
      expect(after?.others ?? []).toEqual([]);
      expect(await t.svc.mailboxes(sessionId)).toMatchObject({ active: "kim@family.test", shared: [] });
    }
  });

  it("refuses switching back to an opened entry once its grant is gone, and drops it from the list", async () => {
    const t = setup();
    t.grant(DESK, "full_access");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    await t.svc.openDelegated(sessionId, "desk@family.test", req);
    await t.svc.switchMailbox(sessionId, "kim@family.test");
    t.s.delegations = [];
    await expect(t.svc.switchMailbox(sessionId, "desk@family.test")).rejects.toBeInstanceOf(
      WebmailDelegationRefusedError,
    );
    expect((await t.svc.session(sessionId))?.others ?? []).toEqual([]);
    // Listing prunes opened entries whose grant went, without a use.
    t.grant(DESK, "full_access");
    await t.svc.openDelegated(sessionId, "desk@family.test", req);
    await t.svc.switchMailbox(sessionId, "kim@family.test");
    t.s.delegations = [];
    expect(await t.svc.mailboxes(sessionId)).toMatchObject({ others: [], shared: [] });
    expect((await t.store.read(sessionId))?.others ?? []).toEqual([]);
  });

  it("drops only the entry when its token is refused (the mailbox's password changed or it was suspended)", async () => {
    const t = setup();
    t.grant(DESK, "full_access");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    await t.svc.openDelegated(sessionId, "desk@family.test", req);
    t.refreshRefused.add("desk@family.test");
    t.advance(3_600_000);
    await expect(t.svc.session(sessionId)).rejects.toBeInstanceOf(WebmailDelegationRefusedError);
    expect((await t.svc.session(sessionId))?.username).toBe("kim@family.test");

    await t.svc.openDelegated(sessionId, "desk@family.test", req);
    t.setUpstream(403);
    await expect(
      t.svc.jmap(sessionId, { using: [CORE, MAIL], methodCalls: [["Mailbox/get", { accountId: "x" }, "m"]] }),
    ).rejects.toBeInstanceOf(WebmailDelegationRefusedError);
    t.setUpstream(200);
    expect((await t.svc.session(sessionId))?.username).toBe("kim@family.test");
  });

  it("keeps sending, drafts, uploads, identities and settings to the person's own mailbox", async () => {
    const t = setup();
    t.grant(DESK, "full_access");
    t.grant(DESK, "send_as");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    await t.svc.openDelegated(sessionId, "desk@family.test", req);
    const draft = { to: [], cc: [], bcc: [], subject: "", text: "", attachments: [], identityId: "i1" };
    for (const attempt of [
      () => t.svc.identities(sessionId),
      () => t.svc.saveDraft(sessionId, draft),
      () => t.svc.send(sessionId, "d1", "i1"),
      () => t.svc.undoSend(sessionId, "s1"),
      () => t.svc.upload(sessionId, new Uint8Array(1), "text/plain"),
      () => t.svc.mailRules(sessionId),
      () => t.svc.legacySignature(sessionId),
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(WebmailOwnMailboxOnlyError);
    }
  });

  it("refuses while the console session the webmail came from has act-as open", async () => {
    const t = setup();
    t.grant(DESK, "full_access");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    const cur = await t.store.read(sessionId);
    if (!cur) throw new Error("no session");
    await t.store.write(sessionId, { ...cur, console: { userId: "kim", sessionId: "cs-1" } });
    t.s.actAsSessions.push({
      id: "aa",
      staffUserId: "kim",
      staffRole: "support_admin",
      authSessionId: "cs-1",
      accountId: ACCOUNT_B,
      reason: "ticket",
      startedAt: new Date(0),
      expiresAt: new Date(9e12),
      endedAt: null,
      endReason: null,
    });
    await expect(t.svc.openDelegated(sessionId, "desk@family.test", req)).rejects.toBeInstanceOf(ForbiddenError);
    expect(t.minted).toEqual([]);
  });

  it("counts delegated entries apart from the session's own mailboxes", async () => {
    const t = setup();
    t.grant(DESK, "full_access");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    await t.svc.openDelegated(sessionId, "desk@family.test", req);
    for (const n of [1, 2, 3, 4]) await t.svc.addMailbox(sessionId, `own${String(n)}@x.test`, "right");
    const s = await t.store.read(sessionId);
    expect([s, ...(s?.others ?? [])].filter((m) => m && !m.delegated)).toHaveLength(5);
    await expect(t.svc.addMailbox(sessionId, "own5@x.test", "right")).rejects.toThrow(/5 mailboxes/);
  });
});

describe("own-mailbox actions can't be aimed at a shared mailbox by switching after the gate (review 2026-10-30)", () => {
  /** Kim's session with desk@ open, then back on her own mailbox: the route's gate would let own-only routes through. */
  async function race() {
    const t = setup();
    t.grant(DESK, "full_access");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    await t.svc.openDelegated(sessionId, "desk@family.test", req);
    await t.svc.switchMailbox(sessionId, "kim@family.test");
    const own = await t.store.read(sessionId);
    if (!own) throw new Error("no session");
    // The gate read the session here (own mailbox active). Then another request switches to the shared one.
    const switchToShared = () => t.svc.switchMailbox(sessionId, "desk@family.test");
    return { t, sessionId, own, switchToShared };
  }

  it("refuses every own-only service action on the entry it would use, and makes no call with its token", async () => {
    const { t, sessionId, own, switchToShared } = await race();
    await switchToShared();
    const before = t.calls.length;
    const account = own.accountId;
    const draft = { to: [], cc: [], bcc: [], subject: "", text: "", attachments: [], identityId: "i1" };
    const contact = { name: "", emails: [], phones: [] } as unknown as Parameters<WebmailService["createContact"]>[2];
    for (const attempt of [
      () => t.svc.contacts(sessionId),
      () => t.svc.createContact(sessionId, account, contact),
      () => t.svc.updateContact(sessionId, account, "c1", contact),
      () => t.svc.deleteContacts(sessionId, account, ["c1"]),
      () => t.svc.moveContacts(sessionId, account, ["c1"], "mine"),
      () => t.svc.setAutoSave(sessionId, account, true),
      () => t.svc.importContacts(sessionId, account, "BEGIN:VCARD\nVERSION:4.0\nFN:A\nEND:VCARD"),
      () => t.svc.exportContacts(sessionId),
      () => t.svc.quota(sessionId),
      () => t.svc.identities(sessionId),
      () => t.svc.updateIdentity(sessionId, account, "i1", { name: "x" }),
      () => t.svc.mirrorSignature(sessionId, account, null),
      () => t.svc.legacySignature(sessionId),
      () => t.svc.mailRules(sessionId),
      () => t.svc.saveMailRules(sessionId, account, { vacation: null, forwarding: null, junk: null } as never),
      () => t.svc.saveDraft(sessionId, draft),
      () => t.svc.send(sessionId, "d1", "i1"),
      () => t.svc.undoSend(sessionId, "s1"),
      () => t.svc.upload(sessionId, new Uint8Array(1), "text/plain"),
      () => t.svc.download(sessionId, "acc-desk@family.test", "b1", "x"),
      () =>
        t.svc.jmapAs(sessionId, (x) => ({
          using: [CORE, MAIL],
          methodCalls: [["Mailbox/get", { accountId: x.accountId }, "m"]],
        })),
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(WebmailOwnMailboxOnlyError);
    }
    // Only the gate's own proof of Kim's sign-in reached the mail server; nothing with the shared mailbox's token.
    expect(t.calls.slice(before).filter((c) => c.auth === "Bearer at-desk@family.test")).toEqual([]);
    expect(t.sieveWrites).toEqual([]);
    // Reads stay available on it.
    await t.svc.jmap(sessionId, { using: [CORE, MAIL], methodCalls: [["Mailbox/get", { accountId: "x" }, "m"]] });
  });

  it("refuses the settings, password, photo and export callers, deciding on the same read they use", async () => {
    const { t, sessionId, own, switchToShared } = await race();
    await switchToShared();
    const settings = new WebmailSettings({
      mail: t.svc,
      settings: new WebmailSettingsService(t.deps),
      signatures: new WebmailSignaturesService(t.deps),
      mailer: { send: async () => undefined },
      webmailUrl: "http://localhost:43300",
      siteHost: "localhost",
    });
    await expect(settings.overview(sessionId)).rejects.toBeInstanceOf(WebmailOwnMailboxOnlyError);
    await expect(
      settings.updatePreferences(sessionId, own.accountId, { density: "compact" }, req),
    ).rejects.toBeInstanceOf(WebmailOwnMailboxOnlyError);
    await expect(settings.removeForwarding(sessionId, own.accountId, req)).rejects.toBeInstanceOf(
      WebmailOwnMailboxOnlyError,
    );
    let changed = 0;
    await expect(
      changeWebmailPassword(
        {
          mail: t.svc,
          change: async () => {
            changed += 1;
            return { jobId: "j", ownerEmail: null };
          },
          notify: async () => undefined,
          state: async () => "applied",
          failures: { exceeded: async () => false, record: async () => undefined },
        },
        sessionId,
        { current: "right", next: "a much longer password 1", account: "acc-desk@family.test" },
        req,
      ),
    ).rejects.toBeInstanceOf(WebmailOwnMailboxOnlyError);
    expect(changed).toBe(0);
    await expect(mailExportStream(t.svc, sessionId, {}, async () => undefined)).rejects.toBeInstanceOf(
      WebmailOwnMailboxOnlyError,
    );
    expect(t.s.audit.filter((e) => e.action !== "delegation.mailbox_opened")).toEqual([]);
  });

  it("never caches another mailbox's identities under the account it started with", async () => {
    const t = setup();
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    await t.svc.addMailbox(sessionId, "b@x.test", "right");
    await t.svc.switchMailbox(sessionId, "kim@family.test");
    // Switch to b@ right after identities() read the active mailbox, before its call picks a token.
    const read = t.store.read.bind(t.store);
    let reads = 0;
    t.store.read = async (id: string): Promise<WebmailSession | null> => {
      reads += 1;
      const out = await read(id);
      if (reads === 1 && out) {
        const b = out.others?.find((m) => m.username === "b@x.test");
        if (b) await t.store.write(id, { ...out, ...b, others: [{ ...out, others: undefined } as never] });
      }
      return out;
    };
    await expect(t.svc.identities(sessionId)).rejects.toThrow(/active mailbox changed/);
  });
});

describe("delegated use rides on the person's own sign-in at the mail server (review 2026-10-30)", () => {
  it("ends the whole session when the own mailbox's password was reset, within the 10 s proof", async () => {
    const t = setup();
    t.grant(DESK, "full_access");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    await t.svc.openDelegated(sessionId, "desk@family.test", req);
    // Kim's password is reset: her tokens and refresh grant are refused; desk@'s own tokens still work.
    t.revoked.add("kim@family.test");
    t.refreshRefused.add("kim@family.test");
    // Proven a moment ago: the remaining window is the 10 s proof.
    expect((await t.svc.session(sessionId))?.username).toBe("desk@family.test");
    t.advance(10_000);
    await expect(t.svc.session(sessionId)).rejects.toBeInstanceOf(WebmailSignedOutError);
    expect(await t.store.read(sessionId)).toBeNull();
  });

  it("proves every own sign-in before opening, so a stolen session can't open more after a reset", async () => {
    const t = setup();
    t.grant(DESK, "full_access");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    t.revoked.add("kim@family.test");
    t.refreshRefused.add("kim@family.test");
    await expect(t.svc.openDelegated(sessionId, "desk@family.test", req)).rejects.toBeInstanceOf(WebmailSignedOutError);
    expect(t.minted).toEqual([]);
    expect(await t.store.read(sessionId)).toBeNull();
  });

  it("refreshes an own token that is due (or refused once) and keeps going", async () => {
    const t = setup();
    t.grant(DESK, "full_access");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    await t.svc.openDelegated(sessionId, "desk@family.test", req);
    // The old token is refused but the refresh grant is fine (e.g. it simply expired at the mail server).
    t.revoked.add("kim@family.test");
    t.advance(10_000);
    t.revoked.delete("kim@family.test");
    expect((await t.svc.session(sessionId))?.username).toBe("desk@family.test");
    t.advance(3_600_000);
    expect((await t.svc.session(sessionId))?.username).toBe("desk@family.test");
    const own = (await t.store.read(sessionId))?.others?.find((m) => m.username === "kim@family.test");
    expect(own?.accessToken).toBe("at-kim@family.test-r1");
  });
});

describe("the JMAP proxy and a mailbox shared with the person", () => {
  const req1 = (calls: unknown[]) => ({ using: [CORE, MAIL], methodCalls: calls });

  it("refuses its identities without a send right", () => {
    const call = [["Identity/get", { accountId: "acc1" }, "i"]];
    expect(checkJmapRequest(req1(call), "acc1").ok).toBe(true);
    expect(checkJmapRequest(req1(call), "acc1", { delegated: { send: false } })).toEqual({
      ok: false,
      message: "Method not available: Identity/get",
    });
    expect(checkJmapRequest(req1(call), "acc1", { delegated: { send: true } }).ok).toBe(true);
    expect(
      checkJmapRequest(req1([["Email/query", { accountId: "acc1" }, "q"]]), "acc1", { delegated: { send: false } }).ok,
    ).toBe(true);
  });

  it("refuses a client-supplied Sender, raw headers and the on-behalf tag in Email/set and Email/import", () => {
    const refused = { ok: false, message: "The sender of a message can't be set here." };
    for (const args of [
      { accountId: "acc1", update: { e1: { sender: [{ email: "x@y.test" }] } } },
      { accountId: "acc1", update: { e1: { "header:Sender": "x@y.test" } } },
      { accountId: "acc1", update: { e1: { "header:X-AnhourMail-On-Behalf:asText": "ab" } } },
      { accountId: "acc1", create: { d: { from: [{ email: "a@x.test" }], sender: [{ email: "b@x.test" }] } } },
      { accountId: "acc1", create: { d: { headers: [{ name: "X-AnhourMail-On-Behalf", value: "ab" }] } } },
    ]) {
      expect(checkJmapRequest(req1([["Email/set", args, "s"]]), "acc1")).toEqual(refused);
      expect(checkJmapRequest(req1([["Email/import", args, "s"]]), "acc1")).toEqual(refused);
    }
    expect(setsSenderFields({ update: { e1: { "keywords/$seen": true } } })).toBe(false);
    expect(setsSenderFields({ update: { e1: { "mailboxIds/m1": true } }, destroy: ["e2"] })).toBe(false);
    expect(setsSenderFields(null)).toBe(false);
  });
});
