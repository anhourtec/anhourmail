// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A mailbox shared with the person, through the webmail BFF on the dev Stalwart (ADR-0026 §6, review 2026-10-30):
 * delegated use rides on the person's own sign-in, proven against the mail server, so resetting the person's own
 * mailbox password ends the whole webmail session — even while a shared mailbox (whose own tokens still work) is the
 * active one. The control plane is the in-memory adapter; the mail server, its OAuth and the throwaway credential
 * (minted with the dev admin here, the operations key in the app) are real.
 */
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import { hashPassword } from "@anhourmail/adapters/auth";
import type { Deps } from "@anhourmail/core";
import {
  authorizeDelegatedSend,
  delegatedMailboxesFor,
  delegatedSendCheck,
  delegationCheck,
  DelegationGate,
  openDelegatedMailbox,
  recordDelegatedSendOutcome,
} from "@anhourmail/core/webmail";
import { createKeyRing } from "@anhourmail/server/keyring";
import { memorySlidingQuota } from "@anhourmail/server/rate-limit";
import { runWithRequestContext } from "@anhourmail/server/request-context";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";
import {
  StalwartOAuth,
  stalwartDevAdmin,
  WEBMAIL_OAUTH_CLIENT_ID,
  webmailRedirectUri,
} from "@anhourmail/stalwart-client";

import { firstLoad } from "../webmail/bootstrap";
import { PinnedMailboxMissingError, withPinnedMailbox } from "../webmail/pin";
import { memoryKv, WebmailSessionStore } from "../webmail/session-store";
import { WebmailDelegationRefusedError, WebmailService, WebmailSignedOutError } from "../webmail/service";
import { stalwartOAuthPort } from "./stalwart-oauth";

const STALWART_URL = process.env.STALWART_URL ?? "http://127.0.0.1:43080";
const WEBMAIL_URL = process.env.WEBMAIL_URL ?? "http://localhost:43300";
const tag = randomBytes(4).toString("hex");
const KIM = `int-dlg-kim-${tag}`;
const DESK = `int-dlg-desk-${tag}`;
const kimAddress = `${KIM}@dev.test`;
const deskAddress = `${DESK}@dev.test`;
const KIM_PASSWORD = randomBytes(18).toString("base64url");
const ACCOUNT = "11111111-1111-4111-8111-1111111111aa";
/** RFC 5737 documentation range: this file's sign-ins count against this address only. */
const ip = `203.0.113.${String(1 + Math.floor(Math.random() * 254))}`;
const asClient = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithRequestContext({ requestId: `int-dlg-${tag}`, clientIp: ip }, fn);
const ids: string[] = [];

beforeAll(async () => {
  const admin = stalwartDevAdmin();
  for (const [name, password] of [
    [KIM, KIM_PASSWORD],
    [DESK, randomBytes(18).toString("base64url")],
  ] as const) {
    ids.push(
      await admin.upsertUser({ name, domain: "dev.test", password: await hashPassword(password), quotaBytes: 1 << 24 }),
    );
  }
});
afterAll(async () => {
  for (const id of ids) await stalwartDevAdmin().destroy("x:Account", id);
});

function world() {
  let offset = 0;
  const now = () => Date.now() + offset;
  const uow = new MemoryUnitOfWork();
  const s = uow.state;
  const deps: Deps = { uow, clock: { now: () => new Date(now()) }, platform: PUBLIC_PLATFORM };
  s.accounts.push({ id: ACCOUNT, name: "Int", plan: "plus" });
  s.userEmails.kim = "kim@console.test";
  s.memberships.push({ userId: "kim", accountId: ACCOUNT, role: "member" });
  const box = (id: string, address: string, userId: string | null, stalwartId: string) => ({
    id,
    accountId: ACCOUNT,
    userId,
    address,
    status: "active" as const,
    quotaBytes: 1,
    stalwartId,
    lastError: null,
    purgeAfter: null,
    createdAt: new Date(0),
  });
  s.mailboxes.push(
    box("aaaaaaaa-0000-4000-8000-0000000000a1", kimAddress, "kim", ids[0] ?? ""),
    box("aaaaaaaa-0000-4000-8000-0000000000a2", deskAddress, null, ids[1] ?? ""),
  );
  s.delegations.push({
    id: "g1",
    accountId: ACCOUNT,
    mailboxId: "aaaaaaaa-0000-4000-8000-0000000000a2",
    granteeUserId: "kim",
    right: "full_access",
    grantedBy: null,
    createdAt: new Date(0),
  });
  const access = { state: async () => "ok" as const };
  const oauth = new StalwartOAuth({
    baseUrl: STALWART_URL,
    clientId: WEBMAIL_OAUTH_CLIENT_ID,
    redirectUri: webmailRedirectUri(WEBMAIL_URL),
  });
  const svc = new WebmailService({
    store: new WebmailSessionStore(memoryKv(), createKeyRing([{ id: "t", key: randomBytes(32) }])),
    oauth: stalwartOAuthPort({ stalwartUrl: STALWART_URL, webmailUrl: WEBMAIL_URL }),
    // The app's `stalwartHandoffSignIn`, with the dev admin instead of the operations key.
    handoffSignIn: async ({ address, externalId }) => {
      const admin = stalwartDevAdmin();
      const made = await admin.createHandoffCredential(externalId, 60_000);
      try {
        return await oauth.signInWithHandoffCredential(address, made.secret, ip);
      } finally {
        await admin.destroyAppPassword(externalId, made.id);
      }
    },
    delegation: {
      list: (owners) => delegatedMailboxesFor(deps, owners),
      open: (input, signIn, req) => openDelegatedMailbox(deps, access, input, signIn, req),
      gate: new DelegationGate(delegationCheck(deps, access), { now }),
      authorizeSend: (input, r) => authorizeDelegatedSend(deps, access, input, r),
      checkSend: (input) => delegatedSendCheck(deps, access, input),
      sendOutcome: (input, outcome, r) => recordDelegatedSendOutcome(deps, input, outcome, r),
    },
    stalwartUrl: STALWART_URL,
    access,
    quota: memorySlidingQuota(),
    sieve: { read: async () => null, write: async () => true },
    confirmedForward: async () => null,
    defer: () => undefined,
    now,
  });
  return {
    svc,
    revoke: () => {
      s.delegations.splice(0, s.delegations.length);
    },
    skip: (ms: number) => {
      offset += ms;
    },
  };
}

// Before the password reset below: it ends Kim's sign-in for good.
describe("the webmail first load on the dev Stalwart", () => {
  const input = { start: "inbox", grouping: "conversations" as const, attachments: false };

  it("loads the person's own mailbox, a pinned shared one only once opened, and nothing once the grant goes", async () => {
    const t = world();
    const req = { requestId: `int-dlg-${tag}`, ip, userAgent: null };
    const { sessionId, session } = await asClient(() => t.svc.signIn(kimAddress, KIM_PASSWORD));

    // Own mailbox: its folders, the Inbox opened, the session document for its account, the sync states.
    const own = await asClient(() => firstLoad(t.svc, sessionId, input));
    expect(own?.session.username).toBe(kimAddress);
    expect(own?.session.primaryAccounts["urn:ietf:params:jmap:mail"]).toBe(session.accountId);
    const inbox = own?.folders.find((f) => f.role === "inbox");
    expect(own?.view).toEqual({ kind: "folder", id: inbox?.id });
    expect(own?.list).toMatchObject({ total: 0, rows: [], pinned: [] });
    expect(own?.state.email).not.toBe("");
    expect(own?.state.mailbox).not.toBe("");
    expect(JSON.stringify(own)).not.toMatch(/Bearer|refreshToken|accessToken/);

    // A tab pinned to the shared mailbox before it was opened: the one delegation refusal (the route answers 404).
    await expect(
      asClient(() => withPinnedMailbox(deskAddress, () => firstLoad(t.svc, sessionId, input))),
    ).rejects.toBeInstanceOf(PinnedMailboxMissingError);

    // Opened for a tab (not made active): the pinned first load is that mailbox's own (folder ids are per account, so a
    // folder the URL names is looked up in the shared mailbox only; one it doesn't have opens its Inbox).
    const opened = await asClient(() => t.svc.openDelegated(sessionId, deskAddress, req, { activate: false }));
    const desk = [opened, ...(opened.others ?? [])].find((m) => m.username === deskAddress);
    const pinned = await asClient(() =>
      withPinnedMailbox(deskAddress, () => firstLoad(t.svc, sessionId, { ...input, folder: "no-such-folder" })),
    );
    expect(pinned?.session.username).toBe(deskAddress);
    expect(pinned?.session.primaryAccounts["urn:ietf:params:jmap:mail"]).toBe(desk?.accountId);
    expect(desk?.accountId).not.toBe(session.accountId);
    const deskInbox = pinned?.folders.find((f) => f.role === "inbox");
    expect(pinned?.view).toEqual({ kind: "folder", id: deskInbox?.id });
    const sent = await asClient(() =>
      withPinnedMailbox(deskAddress, () => firstLoad(t.svc, sessionId, { ...input, folder: "sent" })),
    );
    expect(sent?.view).toEqual({ kind: "folder", id: sent?.folders.find((f) => f.role === "sent")?.id });

    // The pin changed nothing for Kim's other tabs: unpinned, her own mailbox still loads.
    const again = await asClient(() => firstLoad(t.svc, sessionId, input));
    expect(again?.session.username).toBe(kimAddress);

    // The grant goes: past the gate's 10 s, the pinned tab is refused, and Kim's own first load still works.
    t.revoke();
    t.skip(11_000);
    await expect(
      asClient(() => withPinnedMailbox(deskAddress, () => firstLoad(t.svc, sessionId, input))),
    ).rejects.toBeInstanceOf(WebmailDelegationRefusedError);
    expect((await asClient(() => firstLoad(t.svc, sessionId, input)))?.session.username).toBe(kimAddress);
  }, 60_000);

  it("answers null once signed out", async () => {
    const t = world();
    const { sessionId } = await asClient(() => t.svc.signIn(kimAddress, KIM_PASSWORD));
    await t.svc.signOut(sessionId);
    expect(await asClient(() => firstLoad(t.svc, sessionId, input))).toBeNull();
  }, 60_000);
});

describe("a shared mailbox in the webmail on the dev Stalwart", () => {
  it("ends the whole session once the person's own mailbox password is reset", async () => {
    const t = world();
    const req = { requestId: `int-dlg-${tag}`, ip, userAgent: null };
    const { sessionId } = await asClient(() => t.svc.signIn(kimAddress, KIM_PASSWORD));
    const opened = await asClient(() => t.svc.openDelegated(sessionId, deskAddress, req));
    expect(opened.username).toBe(deskAddress);
    const read = await asClient(() =>
      t.svc.jmap(sessionId, {
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
        methodCalls: [["Mailbox/get", { accountId: opened.accountId, properties: ["role"] }, "m"]],
      }),
    );
    expect(read.status).toBe(200);

    // An administrator resets Kim's own mailbox password: the mail server revokes her tokens.
    await stalwartDevAdmin().upsertUser({
      name: KIM,
      domain: "dev.test",
      password: await hashPassword(randomBytes(18).toString("base64url")),
      resetPassword: true,
      quotaBytes: 1 << 24,
    });
    await new Promise((r) => setTimeout(r, 1_500));
    // Past the 10 s proof: the next use proves Kim's sign-in again and the session ends.
    t.skip(11_000);
    await expect(asClient(() => t.svc.session(sessionId))).rejects.toBeInstanceOf(WebmailSignedOutError);
    expect(await t.svc.store.read(sessionId)).toBeNull();
  }, 60_000);
});
