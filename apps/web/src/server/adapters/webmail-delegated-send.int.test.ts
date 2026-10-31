// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Sending from a mailbox shared with the person, through the webmail BFF on the dev Stalwart (ADR-0026 §6 and §8,
 * slice 13): send as puts the Sent copy in the shared mailbox and the recipient sees From = that mailbox; send on behalf
 * delivers with Sender = the person and no tag or expiry header in the stored Sent copy, the delivered copy or anywhere
 * in the shared mailbox; a revoked right and read-and-manage only are refused before anything is submitted. The
 * control plane is the in-memory adapter; the mail server, its OAuth, the sender-identity script (with the dev key)
 * and the throwaway credential (minted with the dev admin here, the operations key in the app) are real. External
 * recipients are fresh `@example.com` addresses, which the dev mail server hands to Mailpit (rule 19), one per case
 * (the per-recipient throttle).
 */
import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import { hashPassword } from "@anhourmail/adapters/auth";
import { DelegatedMailboxRefusedError, type Deps } from "@anhourmail/core";
import type { DelegationRight } from "@anhourmail/core/delegation";
import {
  authorizeDelegatedSend,
  delegatedMailboxesFor,
  delegatedSendCheck,
  delegationCheck,
  DelegationGate,
  ON_BEHALF_EXPIRES_HEADER,
  ON_BEHALF_HEADER,
  openDelegatedMailbox,
  recordDelegatedSendOutcome,
  resolveSenderDelegationKey,
} from "@anhourmail/core/webmail";
import { JmapClient } from "@anhourmail/jmap-client";
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

import { memoryKv, WebmailSessionStore } from "../webmail/session-store";
import { WebmailDelegationRefusedError, WebmailService } from "../webmail/service";
import { stalwartOAuthPort } from "./stalwart-oauth";

const STALWART_URL = process.env.STALWART_URL ?? "http://127.0.0.1:43080";
const WEBMAIL_URL = process.env.WEBMAIL_URL ?? "http://localhost:43300";
const MAILPIT = `http://127.0.0.1:${process.env.MAILPIT_UI_PORT ?? "43026"}`;
const tag = randomBytes(4).toString("hex");
const KIM = `int-dsend-kim-${tag}`;
const DESK = `int-dsend-desk-${tag}`;
const kimAddress = `${KIM}@dev.test`;
const deskAddress = `${DESK}@dev.test`;
const KIM_PASSWORD = randomBytes(18).toString("base64url");
const DESK_PASSWORD = randomBytes(18).toString("base64url");
const ACCOUNT = "11111111-1111-4111-8111-1111111111bb";
const DESK_ID = "aaaaaaaa-0000-4000-8000-0000000000b2";
/** RFC 5737 documentation range: this file's sign-ins count against this address only. */
const ip = `198.51.100.${String(1 + Math.floor(Math.random() * 254))}`;
const asClient = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithRequestContext({ requestId: `int-dsend-${tag}`, clientIp: ip }, fn);
const req = { requestId: `int-dsend-${tag}`, ip, userAgent: null };
const ids: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fresh = (label: string) => `int-dsend-${label}-${randomUUID().slice(0, 8)}@example.com`;

beforeAll(async () => {
  const admin = stalwartDevAdmin();
  for (const [name, password] of [
    [KIM, KIM_PASSWORD],
    [DESK, DESK_PASSWORD],
  ] as const) {
    ids.push(
      await admin.upsertUser({ name, domain: "dev.test", password: await hashPassword(password), quotaBytes: 1 << 24 }),
    );
  }
});
afterAll(async () => {
  for (const id of ids) await stalwartDevAdmin().destroy("x:Account", id);
});

/** The shared mailbox read directly (as its own account), to look at what it stores. */
const desk = () =>
  new JmapClient({
    sessionUrl: `${STALWART_URL}/jmap/session`,
    authorization: `Basic ${Buffer.from(`${deskAddress}:${DESK_PASSWORD}`).toString("base64")}`,
  });

/** Makes the next request whose body has `method` reach the mail server, then lose its answer (a transport failure). */
let loseAnswerOf: string | null = null;
const lossyFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const method = loseAnswerOf;
  if (method && typeof init?.body === "string" && init.body.includes(`"${method}"`)) {
    loseAnswerOf = null;
    await res.body?.cancel();
    throw new TypeError("fetch failed");
  }
  return res;
};

function world(rights: DelegationRight[], hold = 1) {
  const uow = new MemoryUnitOfWork();
  const s = uow.state;
  const deps: Deps = { uow, clock: { now: () => new Date() }, platform: PUBLIC_PLATFORM };
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
    box("aaaaaaaa-0000-4000-8000-0000000000b1", kimAddress, "kim", ids[0] ?? ""),
    box(DESK_ID, deskAddress, null, ids[1] ?? ""),
  );
  for (const right of rights) {
    s.delegations.push({
      id: `g-${right}`,
      accountId: ACCOUNT,
      mailboxId: DESK_ID,
      granteeUserId: "kim",
      right,
      grantedBy: null,
      createdAt: new Date(0),
    });
  }
  const access = { state: async () => "ok" as const };
  const oauth = new StalwartOAuth({
    baseUrl: STALWART_URL,
    clientId: WEBMAIL_OAUTH_CLIENT_ID,
    redirectUri: webmailRedirectUri(WEBMAIL_URL),
  });
  const svc = new WebmailService({
    store: new WebmailSessionStore(memoryKv(), createKeyRing([{ id: "t", key: randomBytes(32) }])),
    oauth: stalwartOAuthPort({ stalwartUrl: STALWART_URL, webmailUrl: WEBMAIL_URL }),
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
      open: (input, signIn, r) => openDelegatedMailbox(deps, access, input, signIn, r),
      gate: new DelegationGate(delegationCheck(deps, access), { ttlMs: 0 }),
      authorizeSend: (input, r) => authorizeDelegatedSend(deps, access, input, r),
      checkSend: (input) => delegatedSendCheck(deps, access, input),
      sendOutcome: (input, outcome, r) => recordDelegatedSendOutcome(deps, input, outcome, r),
    },
    // The key the dev plan wrote into the sender-identity script.
    onBehalfKey: () => resolveSenderDelegationKey(process.env),
    stalwartUrl: STALWART_URL,
    access,
    quota: memorySlidingQuota(),
    sieve: { read: async () => null, write: async () => true },
    confirmedForward: async () => null,
    holdSeconds: async () => hold,
    fetch: lossyFetch,
    defer: () => undefined,
  });
  return { svc, s };
}

/** Signs Kim in and saves a draft to `to` in her own mailbox; returns what `send` needs. */
async function kimDraft(svc: WebmailService, to: string, subject: string) {
  const { sessionId, session } = await asClient(() => svc.signIn(kimAddress, KIM_PASSWORD));
  const [identity] = await asClient(() => svc.identities(sessionId));
  if (!identity) throw new Error("no identity");
  const { id } = await asClient(() =>
    svc.saveDraft(
      sessionId,
      {
        identityId: identity.id,
        to: [{ email: to }],
        cc: [],
        bcc: [],
        subject,
        text: "Delegated send check.",
        attachments: [],
      },
      session.accountId,
    ),
  );
  return { sessionId, account: session.accountId, draftId: id, identityId: identity.id };
}

/** The headers of the one Mailpit message to `to`, names lowercased (after the hold and delivery). */
async function delivered(to: string): Promise<Record<string, string[]> | undefined> {
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
    const found = ((await res.json()) as { messages?: { ID: string }[] }).messages?.[0]?.ID;
    if (found) {
      const h = (await (await fetch(`${MAILPIT}/api/v1/message/${found}/headers`)).json()) as Record<string, string[]>;
      return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
    }
    await sleep(500);
  }
  return undefined;
}

/** Every message in the shared mailbox with its folder roles and header names. */
async function deskMessages(): Promise<
  { roles: string[]; subject: string; headers: { name: string; value: string }[] }[]
> {
  const c = desk();
  const accountId = await c.accountId();
  const boxes = await c.request([["Mailbox/get", { accountId, ids: null, properties: ["role"] }, "m"]]);
  const role = new Map(
    ((boxes.get("m")?.list ?? []) as { id: string; role: string | null }[]).map((b) => [b.id, b.role]),
  );
  const q = await c.request([["Email/query", { accountId, limit: 100 }, "q"]]);
  const emailIds = (q.get("q")?.ids ?? []) as string[];
  if (emailIds.length === 0) return [];
  const g = await c.request([
    ["Email/get", { accountId, ids: emailIds, properties: ["mailboxIds", "subject", "headers"] }, "g"],
  ]);
  return (
    (g.get("g")?.list ?? []) as {
      mailboxIds: Record<string, boolean>;
      subject: string;
      headers: { name: string; value: string }[];
    }[]
  ).map((e) => ({
    roles: Object.keys(e.mailboxIds).map((k) => role.get(k) ?? "other"),
    subject: e.subject,
    headers: e.headers,
  }));
}

const tagHeaders = [ON_BEHALF_HEADER.toLowerCase(), ON_BEHALF_EXPIRES_HEADER.toLowerCase()];

describe("sending from a shared mailbox in the webmail on the dev Stalwart", () => {
  it("sends as the mailbox: Sent copy in the shared mailbox, the recipient sees From = the mailbox", async () => {
    const t = world(["send_as"]);
    const to = fresh("as");
    const subject = `int dsend as ${tag}`;
    const d = await kimDraft(t.svc, to, subject);
    const out = await asClient(() =>
      t.svc.send(d.sessionId, d.draftId, d.identityId, d.account, { from: deskAddress, req }),
    );
    expect(out.from).toBe(deskAddress);
    const h = await delivered(to);
    expect(h?.from?.join(" ")).toContain(deskAddress);
    expect(h?.sender).toBeUndefined();
    const stored = (await deskMessages()).filter((m) => m.subject === subject);
    expect(stored.map((m) => m.roles)).toEqual([["sent"]]);
    expect(t.s.audit.filter((e) => e.action === "delegation.sent_as")).toHaveLength(1);
  }, 90_000);

  it("sends on behalf: Sender = the person, no tag or expiry stored or delivered, nothing left in Drafts", async () => {
    const t = world(["send_on_behalf"]);
    const to = fresh("behalf");
    const subject = `int dsend behalf ${tag}`;
    const d = await kimDraft(t.svc, to, subject);
    await asClient(() => t.svc.send(d.sessionId, d.draftId, d.identityId, d.account, { from: deskAddress, req }));
    const h = await delivered(to);
    expect(h?.from?.join(" ")).toContain(deskAddress);
    expect(h?.sender?.join(" ")).toContain(kimAddress);
    for (const name of tagHeaders) expect(h?.[name]).toBeUndefined();
    const stored = (await deskMessages()).filter((m) => m.subject === subject);
    // One copy, in Sent, with the Sender and without the tag; the temporary copy is gone.
    expect(stored.map((m) => m.roles)).toEqual([["sent"]]);
    const names = (stored[0]?.headers ?? []).map((x) => x.name.toLowerCase());
    expect(names).toContain("sender");
    for (const name of tagHeaders) expect(names).not.toContain(name);
    expect(t.s.audit.filter((e) => e.action === "delegation.sent_on_behalf")).toHaveLength(1);
  }, 90_000);

  it("undoes a send on behalf in its hold: nothing delivered, no copy left, the own draft handed back", async () => {
    const t = world(["send_on_behalf"], 8);
    const to = fresh("undo");
    const subject = `int dsend undo ${tag}`;
    const d = await kimDraft(t.svc, to, subject);
    const { submissionId } = await asClient(() =>
      t.svc.send(d.sessionId, d.draftId, d.identityId, d.account, { from: deskAddress, req }),
    );
    const back = await asClient(() =>
      t.svc.undoSend(d.sessionId, submissionId, d.account, { mailbox: deskAddress, req }),
    );
    expect(back).toEqual({ draftId: d.draftId });
    await sleep(12_000);
    expect((await deskMessages()).filter((m) => m.subject === subject)).toEqual([]);
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
    expect(await res.json()).toMatchObject({ messages_count: 0 });
    expect(t.s.audit.filter((e) => e.action === "delegation.send_cancelled")).toHaveLength(1);
  }, 90_000);

  it("finds and removes both copies when the creating request's answer is lost, nothing sent, recorded as failed", async () => {
    const t = world(["send_on_behalf"]);
    const to = fresh("lostcreate");
    const subject = `int dsend lost create ${tag}`;
    const d = await kimDraft(t.svc, to, subject);
    loseAnswerOf = "Email/set";
    await expect(
      asClient(() => t.svc.send(d.sessionId, d.draftId, d.identityId, d.account, { from: deskAddress, req })),
    ).rejects.toThrow();
    expect((await deskMessages()).filter((m) => m.subject === subject)).toEqual([]);
    expect(t.s.audit.filter((e) => e.action === "delegation.send_failed")).toHaveLength(1);
    await sleep(3_000);
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
    expect(await res.json()).toMatchObject({ messages_count: 0 });
  }, 90_000);

  it("treats a submission whose answer was lost as sent: delivered, kept copy in Sent, no tag left", async () => {
    const t = world(["send_on_behalf"]);
    const to = fresh("lostsubmit");
    const subject = `int dsend lost submit ${tag}`;
    const d = await kimDraft(t.svc, to, subject);
    loseAnswerOf = "EmailSubmission/set";
    const out = await asClient(() =>
      t.svc.send(d.sessionId, d.draftId, d.identityId, d.account, { from: deskAddress, req }),
    );
    expect(out.submissionId).toMatch(/\S/);
    const h = await delivered(to);
    expect(h?.sender?.join(" ")).toContain(kimAddress);
    const stored = (await deskMessages()).filter((m) => m.subject === subject);
    expect(stored.map((m) => m.roles)).toEqual([["sent"]]);
    for (const name of tagHeaders) {
      expect((stored[0]?.headers ?? []).map((x) => x.name.toLowerCase())).not.toContain(name);
    }
    expect(t.s.audit.filter((e) => e.action === "delegation.send_failed")).toEqual([]);
  }, 90_000);

  it("refuses a revoked right and read-and-manage only, submitting nothing", async () => {
    const t = world(["send_as", "full_access"]);
    const to = fresh("revoked");
    const subject = `int dsend revoked ${tag}`;
    const d = await kimDraft(t.svc, to, subject);
    t.s.delegations = t.s.delegations.filter((g) => g.right !== "send_as");
    await expect(
      asClient(() => t.svc.send(d.sessionId, d.draftId, d.identityId, d.account, { from: deskAddress, req })),
    ).rejects.toSatisfy((e) => e instanceof WebmailDelegationRefusedError || e instanceof DelegatedMailboxRefusedError);
    const only = world(["full_access"]);
    const d2 = await kimDraft(only.svc, fresh("fullonly"), subject);
    await expect(
      asClient(() => only.svc.send(d2.sessionId, d2.draftId, d2.identityId, d2.account, { from: deskAddress, req })),
    ).rejects.toSatisfy((e) => e instanceof WebmailDelegationRefusedError || e instanceof DelegatedMailboxRefusedError);
    await sleep(3_000);
    expect((await deskMessages()).filter((m) => m.subject === subject)).toEqual([]);
    expect(
      await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)).json(),
    ).toMatchObject({
      messages_count: 0,
    });
  }, 90_000);
});
