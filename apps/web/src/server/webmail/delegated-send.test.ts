// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import { DelegatedMailboxRefusedError, type Deps } from "@anhourmail/core";
import type { DelegationRight } from "@anhourmail/core/delegation";
import type { Mailbox } from "@anhourmail/core/mailboxes";
import {
  authorizeDelegatedSend,
  delegatedMailboxesFor,
  delegatedSendCheck,
  delegationCheck,
  DelegationGate,
  ON_BEHALF_EXPIRES_HEADER,
  ON_BEHALF_HEADER,
  onBehalfTag,
  openDelegatedMailbox,
  recordDelegatedSendOutcome,
  type WebmailAccess,
} from "@anhourmail/core/webmail";
import { createKeyRing } from "@anhourmail/server/keyring";
import { setLogSinkForTests } from "@anhourmail/server/log";
import type { QuotaWindow, SlidingQuotaStore } from "@anhourmail/server/rate-limit";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

import { COMPOSED_KEYWORD, delegatedSendingLimits, stricterLimits } from "./compose";
import { webmailErrorResponse } from "./http";
import { checkJmapRequest } from "./jmap-policy";
import {
  GrantRefusedError,
  type OAuthTokens,
  WebmailDelegationRefusedError,
  WebmailOwnMailboxOnlyError,
  WebmailQuotaError,
  WebmailRefusedError,
  WebmailSendUnconfirmedError,
  WebmailService,
  WebmailUnavailableError,
} from "./service";
import { memoryKv, WebmailSessionStore } from "./session-store";

const MAIL = "urn:ietf:params:jmap:mail";
const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";
const DESK = "aaaaaaaa-0000-4000-8000-000000000001";
const KIM_BOX = "aaaaaaaa-0000-4000-8000-000000000002";
const LEE_BOX = "aaaaaaaa-0000-4000-8000-000000000003";
const B_DESK = "bbbbbbbb-0000-4000-8000-000000000001";
const KEY = "c0ffee00".repeat(8);
const req = { requestId: "req-send", ip: "203.0.113.9", userAgent: "vitest" };

beforeEach(() => {
  setLogSinkForTests(() => undefined);
});
afterEach(() => {
  setLogSinkForTests(null);
});

type Email = Record<string, unknown> & { id: string; mailboxIds: Record<string, boolean> };
type Submission = {
  id: string;
  emailId: string;
  identityId: string;
  envelope: { mailFrom: { email: string }; rcptTo: { email: string }[] };
  undoStatus: string;
  /** How many send audit entries existed when the mail server got it. */
  auditsBefore: number;
};
type Box = {
  accountId: string;
  emails: Map<string, Email>;
  blobs: Map<string, Uint8Array>;
  submissions: Submission[];
  identities: { id: string; name: string; email: string }[];
};

/**
 * A small mail server holding each mailbox's emails, blobs, identities and submissions, enough for the send paths:
 * `Mailbox/get`, `Identity/get`, `Email/get`/`set` (create with `#` references from the same request, destroy,
 * patch), `EmailSubmission/set` (create with `onSuccessDestroyEmail` / `onSuccessUpdateEmail`, cancel), upload and
 * download. Tokens name their mailbox (`at-<address>`).
 */
/** A JMAP-shaped identity id for a mailbox (letters, digits, `_` and `-` only). */
const idOf = (who: string) => `i-${who.replace(/[^A-Za-z0-9]/g, "_")}`;
const KIM_ID = idOf("kim@family.test");

function mailServer(sendAudits: () => number) {
  const boxes = new Map<string, Box>();
  let seq = 0;
  const id = (p: string) => `${p}${String(++seq)}`;
  const box = (who: string): Box => {
    let b = boxes.get(who);
    if (!b) {
      b = {
        accountId: `acc-${who}`,
        emails: new Map(),
        blobs: new Map(),
        submissions: [],
        identities: [
          { id: idOf(who), name: who.startsWith("kim") ? "Kim Ito" : "Desk", email: who },
          ...(who === "kim@family.test"
            ? [{ id: idOf("kim.alias@family.test"), name: "Kim Alias", email: "kim.alias@family.test" }]
            : []),
        ],
      };
      boxes.set(who, b);
    }
    return b;
  };
  const roles = (who: string) => ({ drafts: `drafts-${who}`, sent: `sent-${who}`, inbox: `inbox-${who}` });
  let refuseSubmission: string | null = null;
  /** Fail the request containing `method`: after applying it (answer lost), or with a method error instead. */
  let failing: { method: string; how: "lost" | "error"; times: number }[] = [];
  /** The mail server ignores `onSuccessDestroyEmail`, and/or refuses explicit destroys. */
  let keepOnSuccess = false;
  let refuseDestroy = false;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const who = auth.replace(/^Bearer at-/, "").replace(/-r\d+$/, "");
    if (url.endsWith("/jmap/session")) {
      return Response.json({ username: who, primaryAccounts: { [MAIL]: box(who).accountId } });
    }
    const b = box(who);
    const upload = /\/jmap\/upload\/([^/]+)\/$/.exec(url);
    if (upload) {
      if (decodeURIComponent(upload[1] ?? "") !== b.accountId) return new Response(null, { status: 403 });
      const blobId = id("blob-");
      b.blobs.set(blobId, new Uint8Array(await new Response(init?.body).arrayBuffer()));
      return Response.json({ blobId, size: b.blobs.get(blobId)?.length });
    }
    const download = /\/jmap\/download\/([^/]+)\/([^/]+)\//.exec(url);
    if (download) {
      const bytes = b.blobs.get(decodeURIComponent(download[2] ?? ""));
      return bytes ? new Response(Buffer.from(bytes)) : new Response(null, { status: 404 });
    }
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      methodCalls: [string, Record<string, unknown>, string][];
    };
    const created = new Map<string, string>();
    const out: [string, Record<string, unknown>, string][] = [];
    const r = roles(who);
    const fail = failing.find((f) => body.methodCalls.some(([n]) => n === f.method)) ?? null;
    if (fail) {
      fail.times -= 1;
      if (fail.times <= 0) failing = failing.filter((f) => f !== fail);
      if (fail.how === "error") return Response.json({ methodResponses: [["error", { type: "serverFail" }, "x"]] });
    }
    for (const [name, args, callId] of body.methodCalls) {
      if (args.accountId !== b.accountId) {
        out.push(["error", { type: "accountNotFound" }, callId]);
        continue;
      }
      if (name === "Mailbox/get") {
        out.push([name, { list: Object.entries(r).map(([role, mid]) => ({ id: mid, role })) }, callId]);
      } else if (name === "Identity/get") {
        out.push([name, { list: b.identities }, callId]);
      } else if (name === "Email/query") {
        const inMailbox = (args.filter as { inMailbox?: string } | undefined)?.inMailbox;
        const ids = [...b.emails.values()].filter((e) => !inMailbox || e.mailboxIds[inMailbox]).map((e) => e.id);
        out.push([name, { ids: ids.reverse() }, callId]);
      } else if (name === "EmailSubmission/query") {
        const want = (args.filter as { emailIds?: string[] } | undefined)?.emailIds ?? [];
        out.push([name, { ids: b.submissions.filter((x) => want.includes(x.emailId)).map((x) => x.id) }, callId]);
      } else if (name === "Email/get") {
        const ids = args.ids as string[];
        out.push([name, { list: ids.flatMap((i) => b.emails.get(i) ?? []) }, callId]);
      } else if (name === "Email/set") {
        const made: Record<string, { id: string }> = {};
        for (const [cid, e] of Object.entries((args.create ?? {}) as Record<string, Record<string, unknown>>)) {
          const eid = id("e");
          b.emails.set(eid, { ...e, id: eid } as Email);
          created.set(cid, eid);
          made[cid] = { id: eid };
        }
        const destroyed: string[] = [];
        const notDestroyed: Record<string, { type: string }> = {};
        for (const d of (args.destroy ?? []) as string[]) {
          if (refuseDestroy) notDestroyed[d] = { type: "forbidden" };
          else if (b.emails.delete(d)) destroyed.push(d);
          else notDestroyed[d] = { type: "notFound" };
        }
        for (const [eid, patch] of Object.entries((args.update ?? {}) as Record<string, Record<string, unknown>>)) {
          const e = b.emails.get(eid);
          if (e) applyPatch(e, patch);
        }
        out.push([name, { created: made, destroyed, notDestroyed }, callId]);
      } else if (name === "EmailSubmission/set") {
        if (args.update) {
          const updated: Record<string, null> = {};
          for (const [sid, patch] of Object.entries(args.update as Record<string, { undoStatus?: string }>)) {
            const sub = b.submissions.find((x) => x.id === sid);
            if (sub?.undoStatus === "pending" && patch.undoStatus === "canceled") {
              sub.undoStatus = "canceled";
              updated[sid] = null;
            }
          }
          out.push([name, { updated }, callId]);
          continue;
        }
        const create = (args.create ?? {}) as Record<string, Omit<Submission, "id" | "undoStatus" | "auditsBefore">>;
        const made: Record<string, { id: string; sendAt: string }> = {};
        const notCreated: Record<string, { type: string }> = {};
        const after: [string, Record<string, unknown>, string][] = [];
        for (const [cid, sub] of Object.entries(create)) {
          const emailId = sub.emailId.startsWith("#") ? (created.get(sub.emailId.slice(1)) ?? "") : sub.emailId;
          if (refuseSubmission || !b.emails.has(emailId)) {
            notCreated[cid] = { type: refuseSubmission ?? "invalidProperties" };
            continue;
          }
          const sid = id("sub");
          b.submissions.push({ ...sub, id: sid, emailId, undoStatus: "pending", auditsBefore: sendAudits() });
          made[cid] = { id: sid, sendAt: "2026-10-30T12:00:06Z" };
          const destroy = (args.onSuccessDestroyEmail ?? []) as string[];
          if (!keepOnSuccess && (destroy.includes(`#${cid}`) || destroy.includes(emailId))) {
            b.emails.delete(emailId);
            after.push(["Email/set", { destroyed: [emailId] }, callId]);
          }
          const update = (args.onSuccessUpdateEmail ?? {}) as Record<string, Record<string, unknown>>;
          const patch = update[`#${cid}`];
          const e = b.emails.get(emailId);
          if (patch && e) applyPatch(e, patch);
        }
        out.push([name, { created: made, notCreated }, callId], ...after);
      } else {
        out.push(["error", { type: "unknownMethod" }, callId]);
      }
    }
    // Applied, but the answer never arrives.
    if (fail?.how === "lost") throw new TypeError("fetch failed");
    return Response.json({ methodResponses: out });
  }) as typeof fetch;
  return {
    fetchImpl,
    box,
    roles,
    refuse: (type: string | null) => {
      refuseSubmission = type;
    },
    fail: (method: string, how: "lost" | "error", times = 1) => {
      failing.push({ method, how, times });
    },
    keepOnSuccess: () => {
      keepOnSuccess = true;
    },
    refuseDestroys: (on: boolean) => {
      refuseDestroy = on;
    },
  };
}

function applyPatch(e: Email, patch: Record<string, unknown>) {
  for (const [path, value] of Object.entries(patch)) {
    const [field, key] = path.split("/") as [string, string | undefined];
    if (!key) {
      e[field] = value;
      continue;
    }
    const obj = Object.entries((e[field] as Record<string, unknown> | undefined) ?? {}).filter(([k]) => k !== key);
    e[field] = Object.fromEntries(value === null ? obj : [...obj, [key, value]]);
  }
}

/**
 * Kim (account A) signs in to kim@; desk@ (shared) and lee@ are in her account, desk@b.test in another. Delegation is
 * the real core code on the in-memory adapter; the gate never caches here.
 */
function setup(opts: { key?: string | null } = {}) {
  let now = Date.parse("2026-10-30T12:00:00Z");
  const uow = new MemoryUnitOfWork();
  const s = uow.state;
  const deps: Deps = { uow, clock: { now: () => new Date(now) }, platform: PUBLIC_PLATFORM };
  s.accounts.push({ id: ACCOUNT_A, name: "A", plan: "plus" }, { id: ACCOUNT_B, name: "B", plan: "plus" });
  for (const [uid, accountId] of [
    ["kim", ACCOUNT_A],
    ["lee", ACCOUNT_A],
    ["bea", ACCOUNT_B],
  ] as const) {
    s.userEmails[uid] = `${uid}@console.test`;
    s.memberships.push({ userId: uid, accountId, role: "member" });
  }
  const mk = (mid: string, accountId: string, address: string, userId: string | null): Mailbox => ({
    id: mid,
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
    mk(DESK, ACCOUNT_A, "desk@family.test", null),
    mk(KIM_BOX, ACCOUNT_A, "kim@family.test", "kim"),
    mk(LEE_BOX, ACCOUNT_A, "lee@family.test", "lee"),
    mk(B_DESK, ACCOUNT_B, "desk@b.test", null),
  );
  const grant = (mailboxId: string, right: DelegationRight) =>
    s.delegations.push({
      id: `${mailboxId}-kim-${right}`,
      accountId: ACCOUNT_A,
      mailboxId,
      granteeUserId: "kim",
      right,
      grantedBy: "owner",
      createdAt: new Date(0),
    });
  const revoke = (right: DelegationRight) => {
    s.delegations = s.delegations.filter((g) => g.right !== right);
  };
  const sendAudits = () =>
    s.audit.filter((e) => e.action === "delegation.sent_as" || e.action === "delegation.sent_on_behalf");
  const server = mailServer(() => sendAudits().length);
  const states: Record<string, WebmailAccess> = {};
  const access = { state: async (a: string) => states[a] ?? ("ok" as const) };
  const minted: string[] = [];
  const charged: QuotaWindow[][] = [];
  let quotaOk = true;
  const quota: SlidingQuotaStore = {
    take: async (windows) => {
      charged.push(windows);
      return quotaOk;
    },
  };
  const deferred: (() => void)[] = [];
  let outcomeFails = 0;
  let revokeBeforeAuthorize = false;
  const svc = new WebmailService({
    store: new WebmailSessionStore(
      memoryKv(() => now),
      createKeyRing([{ id: "k1", key: randomBytes(32) }]),
      {
        now: () => now,
      },
    ),
    oauth: {
      signIn: async (name, secret): Promise<OAuthTokens> => {
        if (secret !== "right") throw new GrantRefusedError("no");
        return { accessToken: `at-${name}`, refreshToken: `rt-${name}`, expiresAt: now + 3_600_000 };
      },
      refresh: async (token) => {
        const who = token.replace(/^rt-/, "");
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
      gate: new DelegationGate(delegationCheck(deps, access), { ttlMs: 0, now: () => now }),
      authorizeSend: (input, r) => {
        if (revokeBeforeAuthorize) revoke("send_as");
        return authorizeDelegatedSend(deps, access, input, r);
      },
      checkSend: (input) => delegatedSendCheck(deps, access, input),
      sendOutcome: async (input, outcome, r) => {
        if (outcomeFails > 0) {
          outcomeFails -= 1;
          throw new Error("audit store down");
        }
        await recordDelegatedSendOutcome(deps, input, outcome, r);
      },
    },
    ...(opts.key === null ? {} : { onBehalfKey: () => opts.key ?? KEY }),
    consoleSessionAlive: async () => true,
    stalwartUrl: "http://stalwart:8080",
    access,
    quota,
    sieve: { read: async () => null, write: async () => undefined },
    confirmedForward: async () => null,
    fetch: server.fetchImpl,
    now: () => now,
    sleep: async () => undefined,
    defer: (fn) => {
      deferred.push(fn);
    },
  });
  /** Kim's own draft, as the BFF saves it. */
  const draft = async (sessionId: string, extra: Record<string, unknown> = {}) =>
    (
      await svc.saveDraft(
        sessionId,
        {
          identityId: KIM_ID,
          to: [{ email: "Ann@Example.org", name: "Ann" }],
          cc: [],
          bcc: [{ email: "bo@example.org" }],
          subject: "Quarterly figures",
          text: "Hello from the desk.",
          attachments: [],
          ...extra,
        },
        "acc-kim@family.test",
      )
    ).id;
  return {
    svc,
    s,
    server,
    grant,
    revoke,
    states,
    minted,
    charged,
    deferred,
    sendAudits,
    denyQuota: () => {
      quotaOk = false;
    },
    revokeOnAuthorize: () => {
      revokeBeforeAuthorize = true;
    },
    failOutcomes: (n: number) => {
      outcomeFails = n;
    },
    outcomes: (action: string) => s.audit.filter((e) => e.action === action),
    advance: (ms: number) => {
      now += ms;
    },
    draft,
  };
}

/** Both answer 404 "You don't have access to this mailbox." (core's from the open, the BFF's from the gate). */
const notFound = (e: unknown) =>
  e instanceof WebmailDelegationRefusedError || e instanceof DelegatedMailboxRefusedError;

/** Text of every stored message in a mailbox, to look for a tag anywhere in it. */
const stored = (t: ReturnType<typeof setup>, who: string) => JSON.stringify([...t.server.box(who).emails.values()]);

describe("sending from a mailbox shared with the person (ADR-0026 §6, §8; slice 13)", () => {
  it("lists own identities, then send as (winning) and on behalf, through the active mailbox only", async () => {
    const t = setup();
    t.grant(DESK, "send_as");
    t.grant(DESK, "send_on_behalf");
    t.grant(DESK, "full_access");
    t.grant(LEE_BOX, "send_on_behalf");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    expect(await t.svc.senders(sessionId)).toEqual({
      identities: [
        { id: KIM_ID, name: "Kim Ito", email: "kim@family.test", signature: "" },
        { id: idOf("kim.alias@family.test"), name: "Kim Alias", email: "kim.alias@family.test", signature: "" },
      ],
      shared: [
        { mailbox: "desk@family.test", mode: "send_as", label: "desk@family.test" },
        { mailbox: "lee@family.test", mode: "send_on_behalf", label: "Kim Ito on behalf of lee@family.test" },
      ],
    });
    // Listing mints nothing.
    expect(t.minted).toEqual([]);
  });

  it("sends as the mailbox: from its own identity and envelope, Sent copy there, audited before the submission", async () => {
    const t = setup();
    t.grant(DESK, "send_as");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    const draftId = await t.draft(sessionId);
    const out = await t.svc.send(sessionId, draftId, KIM_ID, "acc-kim@family.test", {
      from: "Desk@Family.test",
      req,
    });
    expect(out).toMatchObject({ from: "desk@family.test", holdSeconds: 6 });
    const desk = t.server.box("desk@family.test");
    const [sub] = desk.submissions;
    expect(sub).toMatchObject({
      identityId: idOf("desk@family.test"),
      envelope: {
        mailFrom: { email: "desk@family.test" },
        rcptTo: [{ email: "ann@example.org" }, { email: "bo@example.org" }],
      },
    });
    expect(sub?.auditsBefore).toBe(1);
    const sent = desk.emails.get(sub?.emailId ?? "");
    expect(sent).toMatchObject({
      mailboxIds: { "sent-desk@family.test": true },
      from: [{ name: "Desk", email: "desk@family.test" }],
      subject: "Quarterly figures",
    });
    expect(sent?.keywords).toEqual({ $seen: true });
    expect(sent).not.toHaveProperty("sender");
    expect(stored(t, "desk@family.test")).not.toContain(ON_BEHALF_HEADER);
    // Opened for sending (audited), charged to the mailbox it went from and to this session.
    expect(t.minted).toEqual(["desk@family.test"]);
    expect(t.s.audit.find((e) => e.action === "delegation.mailbox_opened")).toMatchObject({ meta: { need: "send" } });
    expect(t.charged[0]?.map((w) => w.key)).toEqual([
      "am:send:m:desk@family.test:h",
      "am:send:m:desk@family.test:d",
      expect.stringMatching(/^am:send:s:/),
      expect.stringMatching(/^am:send:s:/),
    ]);
    expect(t.sendAudits()[0]).toMatchObject({
      action: "delegation.sent_as",
      meta: { mailboxId: DESK, recipientCount: 2, need: "send" },
    });
    // Kim's own draft stays through the undo hold, then goes.
    const kim = t.server.box("kim@family.test");
    expect(kim.emails.has(draftId)).toBe(true);
    expect(kim.submissions).toEqual([]);
    for (const fn of t.deferred) fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(kim.emails.has(draftId)).toBe(false);
  });

  it("sends on behalf: Sender is the person, the tag only on a temporary copy the submission destroys", async () => {
    const t = setup();
    t.grant(DESK, "send_on_behalf");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    const draftId = await t.draft(sessionId);
    await t.svc.send(sessionId, draftId, KIM_ID, "acc-kim@family.test", { from: "desk@family.test", req });
    const desk = t.server.box("desk@family.test");
    const [sub] = desk.submissions;
    expect(sub?.envelope.mailFrom.email).toBe("desk@family.test");
    // The submitted copy is gone; only the kept copy is left, in Sent, without a tag or expiry.
    expect(desk.emails.has(sub?.emailId ?? "")).toBe(false);
    const left = [...desk.emails.values()];
    expect(left).toHaveLength(1);
    const kept = left[0];
    expect(kept).toMatchObject({
      mailboxIds: { "sent-desk@family.test": true },
      from: [{ email: "desk@family.test" }],
      sender: [{ name: "Kim Ito", email: "kim@family.test" }],
    });
    expect(stored(t, "desk@family.test")).not.toMatch(/X-AnhourMail-On-Behalf/i);
    expect(stored(t, "kim@family.test")).not.toMatch(/X-AnhourMail-On-Behalf/i);
    expect(t.sendAudits()[0]).toMatchObject({ action: "delegation.sent_on_behalf", result: "success" });
    expect(sub?.auditsBefore).toBe(1);
  });

  it("builds the tag for the Message-ID it made, both copies sharing it, with a few minutes' expiry", async () => {
    const t = setup();
    t.grant(DESK, "send_on_behalf");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    const draftId = await t.draft(sessionId);
    // Keep the temporary copy this time to read what was submitted.
    const desk = t.server.box("desk@family.test");
    const seen: Email[] = [];
    const del = desk.emails.delete.bind(desk.emails);
    desk.emails.delete = (k: string) => {
      const e = desk.emails.get(k);
      if (e) seen.push(e);
      return del(k);
    };
    await t.svc.send(sessionId, draftId, KIM_ID, "acc-kim@family.test", { from: "desk@family.test", req });
    const temp = seen[0];
    const kept = [...desk.emails.values()][0];
    const [mid] = (temp?.messageId as string[] | undefined) ?? [];
    expect(mid).toMatch(/^[0-9a-f-]{36}@family\.test$/);
    expect(kept?.messageId).toEqual([mid]);
    const expires = temp?.[`header:${ON_BEHALF_EXPIRES_HEADER}:asText`];
    expect(expires).toBe("2026-10-30T12:05:00Z");
    expect(temp?.[`header:${ON_BEHALF_HEADER}:asText`]).toBe(
      onBehalfTag(KEY, "desk@family.test", "kim@family.test", mid ?? "", "2026-10-30T12:05:00Z"),
    );
    expect(temp?.mailboxIds).toEqual({ "drafts-desk@family.test": true });
    // Not a draft the webmail would send again.
    expect(temp?.keywords).toEqual({ $seen: true });
  });

  it("refuses with 404 for read and manage only, no right, another account's mailbox, and submits nothing", async () => {
    const t = setup();
    t.grant(DESK, "full_access");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    const draftId = await t.draft(sessionId);
    for (const from of ["desk@family.test", "lee@family.test", "desk@b.test", "nobody@family.test"]) {
      await expect(t.svc.send(sessionId, draftId, KIM_ID, "acc-kim@family.test", { from, req })).rejects.toSatisfy(
        notFound,
      );
    }
    expect(t.minted).toEqual([]);
    expect(t.server.box("desk@family.test").submissions).toEqual([]);
    expect(t.sendAudits()).toEqual([]);
    expect(t.charged).toEqual([]);
    // The refused opens are audited in Kim's account (need "send").
    expect(t.s.audit.find((e) => e.action === "delegation.mailbox_opened")).toMatchObject({
      result: "denied",
      meta: { need: "send" },
    });
  });

  it("re-checks the right inside the send: revoked after the open, nothing is sent and the entry goes", async () => {
    const t = setup();
    t.grant(DESK, "send_as");
    t.grant(DESK, "full_access");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    const draftId = await t.draft(sessionId);
    await t.svc.send(sessionId, draftId, KIM_ID, "acc-kim@family.test", { from: "desk@family.test", req });
    t.revoke("send_as");
    const again = await t.draft(sessionId);
    await expect(
      t.svc.send(sessionId, again, KIM_ID, "acc-kim@family.test", { from: "desk@family.test", req }),
    ).rejects.toBeInstanceOf(WebmailDelegationRefusedError);
    expect(t.server.box("desk@family.test").submissions).toHaveLength(1);
    // The gate (send right) refused the entry before the check in core; the full-access entry is dropped too.
    expect((await t.svc.store.read(sessionId))?.others ?? []).toEqual([]);
  });

  it("refuses at the uncached check when the right goes between the gate and the submission, audited denied", async () => {
    const t = setup();
    t.grant(DESK, "send_as");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    const draftId = await t.draft(sessionId);
    // The quota is charged right before the check: revoke there.
    t.charged.push = (...items: QuotaWindow[][]) => {
      t.revoke("send_as");
      return Array.prototype.push.apply(t.charged, items);
    };
    await expect(
      t.svc.send(sessionId, draftId, KIM_ID, "acc-kim@family.test", { from: "desk@family.test", req }),
    ).rejects.toBeInstanceOf(WebmailDelegationRefusedError);
    expect(t.server.box("desk@family.test").submissions).toEqual([]);
    expect(t.server.box("desk@family.test").emails.size).toBe(0);
    // Audited as sent before any work in the mailbox, then stopped by the last uncached check: recorded as failed.
    expect(t.sendAudits()[0]).toMatchObject({ result: "success" });
    expect(t.outcomes("delegation.send_failed")[0]).toMatchObject({
      meta: { mailboxId: DESK, reason: "delegationrefused" },
    });
  });

  it("refuses over the mailbox's limit (fail closed), recorded as a failed send, nothing created", async () => {
    const t = setup();
    t.grant(DESK, "send_as");
    t.denyQuota();
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    const draftId = await t.draft(sessionId);
    await expect(
      t.svc.send(sessionId, draftId, KIM_ID, "acc-kim@family.test", { from: "desk@family.test", req }),
    ).rejects.toBeInstanceOf(WebmailQuotaError);
    expect(t.sendAudits()).toHaveLength(1);
    expect(t.outcomes("delegation.send_failed")[0]).toMatchObject({ meta: { reason: "quota" } });
    expect(t.server.box("desk@family.test").submissions).toEqual([]);
    expect(t.server.box("desk@family.test").emails.size).toBe(0);
  });

  it("refuses sending on behalf without the key, and sends as still", async () => {
    const t = setup({ key: null });
    t.grant(DESK, "send_on_behalf");
    t.grant(LEE_BOX, "send_as");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    const draftId = await t.draft(sessionId);
    await expect(
      t.svc.send(sessionId, draftId, KIM_ID, "acc-kim@family.test", { from: "desk@family.test", req }),
    ).rejects.toBeInstanceOf(WebmailUnavailableError);
    expect(t.server.box("desk@family.test").emails.size).toBe(0);
    await t.svc.send(sessionId, draftId, KIM_ID, "acc-kim@family.test", { from: "lee@family.test", req });
    expect(t.server.box("lee@family.test").submissions).toHaveLength(1);
  });

  it("removes both copies when the mail server refuses the submission", async () => {
    const t = setup();
    t.grant(DESK, "send_on_behalf");
    t.server.refuse("forbiddenToSend");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    const draftId = await t.draft(sessionId);
    await expect(
      t.svc.send(sessionId, draftId, KIM_ID, "acc-kim@family.test", { from: "desk@family.test", req }),
    ).rejects.toBeInstanceOf(WebmailRefusedError);
    expect(t.server.box("desk@family.test").emails.size).toBe(0);
    expect(t.server.box("kim@family.test").emails.has(draftId)).toBe(true);
  });

  it("copies attachments into the mailbox it sends from, within the caps", async () => {
    const t = setup();
    t.grant(DESK, "send_as");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    const kim = t.server.box("kim@family.test");
    kim.blobs.set("blob-kim", new Uint8Array([1, 2, 3, 4]));
    const draftId = await t.draft(sessionId, {
      attachments: [{ blobId: "blob-kim", name: "a.pdf", type: "application/pdf", size: 4 }],
    });
    // What the mail server answers for the draft's attachments.
    const stored = kim.emails.get(draftId);
    if (stored) stored.attachments = [{ blobId: "blob-kim", name: "a.pdf", type: "application/pdf", size: 4 }];
    await t.svc.send(sessionId, draftId, KIM_ID, "acc-kim@family.test", { from: "desk@family.test", req });
    const desk = t.server.box("desk@family.test");
    const copied = [...desk.blobs.entries()];
    expect(copied).toHaveLength(1);
    expect([...(copied[0]?.[1] ?? [])]).toEqual([1, 2, 3, 4]);
    const sent = desk.emails.get(desk.submissions[0]?.emailId ?? "");
    expect(sent?.attachments).toEqual([
      { blobId: copied[0]?.[0], type: "application/pdf", name: "a.pdf", disposition: "attachment" },
    ]);
  });

  it("undo cancels the held submission, removes the mailbox's copy, hands the own draft back, audited", async () => {
    const t = setup();
    t.grant(DESK, "send_on_behalf");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    const draftId = await t.draft(sessionId);
    const { submissionId } = await t.svc.send(sessionId, draftId, KIM_ID, "acc-kim@family.test", {
      from: "desk@family.test",
      req,
    });
    expect(
      await t.svc.undoSend(sessionId, submissionId, "acc-kim@family.test", { mailbox: "desk@family.test", req }),
    ).toEqual({ draftId });
    const desk = t.server.box("desk@family.test");
    expect(desk.submissions[0]?.undoStatus).toBe("canceled");
    expect(desk.emails.size).toBe(0);
    expect(t.s.audit.find((e) => e.action === "delegation.send_cancelled")).toMatchObject({
      result: "success",
      target: { id: DESK },
    });
    // The end of the hold leaves the handed-back draft alone, and a second undo is "already sent".
    for (const fn of t.deferred) fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(t.server.box("kim@family.test").emails.has(draftId)).toBe(true);
    await expect(
      t.svc.undoSend(sessionId, submissionId, "acc-kim@family.test", { mailbox: "desk@family.test", req }),
    ).rejects.toBeInstanceOf(WebmailRefusedError);
  });

  it("never sends from a shared mailbox while one is the active mailbox, nor to the own mailbox as 'from'", async () => {
    const t = setup();
    t.grant(DESK, "full_access");
    t.grant(DESK, "send_as");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    const draftId = await t.draft(sessionId);
    await expect(
      t.svc.send(sessionId, draftId, KIM_ID, "acc-kim@family.test", { from: "kim@family.test", req }),
    ).rejects.toBeInstanceOf(WebmailRefusedError);
    await t.svc.openDelegated(sessionId, "desk@family.test", req);
    await expect(
      t.svc.send(sessionId, draftId, KIM_ID, undefined, { from: "desk@family.test", req }),
    ).rejects.toBeInstanceOf(WebmailOwnMailboxOnlyError);
    await expect(t.svc.senders(sessionId)).rejects.toBeInstanceOf(WebmailOwnMailboxOnlyError);
    expect(t.server.box("desk@family.test").submissions).toEqual([]);
  });

  it("only sends a draft the BFF built in the own Drafts, from the own identity named", async () => {
    const t = setup();
    t.grant(DESK, "send_as");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    const draftId = await t.draft(sessionId);
    const e = t.server.box("kim@family.test").emails.get(draftId);
    if (e) e.keywords = { $draft: true };
    await expect(
      t.svc.send(sessionId, draftId, KIM_ID, "acc-kim@family.test", { from: "desk@family.test", req }),
    ).rejects.toThrow(/Only a saved draft/);
    if (e) e.keywords = { $draft: true, [COMPOSED_KEYWORD]: true };
    await expect(
      t.svc.send(sessionId, draftId, "i-other", "acc-kim@family.test", { from: "desk@family.test", req }),
    ).rejects.toThrow(/your own addresses/);
    expect(t.minted).toEqual([]);
  });

  it("checks the right before any work in the mailbox: no blob copied and no quota charged without it", async () => {
    const t = setup();
    t.grant(DESK, "send_as");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    const kim = t.server.box("kim@family.test");
    kim.blobs.set("blob-kim", new Uint8Array([1, 2]));
    const draftId = await t.draft(sessionId, {
      attachments: [{ blobId: "blob-kim", name: "a.pdf", type: "application/pdf", size: 2 }],
    });
    const stored = kim.emails.get(draftId);
    if (stored) stored.attachments = [{ blobId: "blob-kim", name: "a.pdf", type: "application/pdf", size: 2 }];
    // Revoked after the gate let the entry through: the uncached check refuses before anything else happens.
    t.revokeOnAuthorize();
    await expect(
      t.svc.send(sessionId, draftId, KIM_ID, "acc-kim@family.test", { from: "desk@family.test", req }),
    ).rejects.toSatisfy(notFound);
    expect(t.server.box("desk@family.test").blobs.size).toBe(0);
    expect(t.charged).toEqual([]);
    expect(t.sendAudits()[0]).toMatchObject({ result: "denied" });
  });

  it("names the Sender as the From picker does (the active mailbox's own identity), whichever own identity was used", async () => {
    const t = setup();
    t.grant(DESK, "send_on_behalf");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    const draftId = await t.draft(sessionId, { identityId: idOf("kim.alias@family.test") });
    await t.svc.send(sessionId, draftId, idOf("kim.alias@family.test"), "acc-kim@family.test", {
      from: "desk@family.test",
      req,
    });
    const kept = [...t.server.box("desk@family.test").emails.values()][0];
    expect(kept?.sender).toEqual([{ name: "Kim Ito", email: "kim@family.test" }]);
  });

  it("limits a delegated send by the stricter of the two tiers", () => {
    const a = { messagesPerDay: 100, messagesPerHour: 10, recipientsPerMessage: 50 };
    const b = { messagesPerDay: 0, messagesPerHour: 20, recipientsPerMessage: 5 };
    expect(stricterLimits(a, b)).toEqual({ messagesPerDay: 0, messagesPerHour: 10, recipientsPerMessage: 5 });
    expect(delegatedSendingLimits("desk@family.test", "kim@family.test")).toEqual(
      stricterLimits(
        delegatedSendingLimits("desk@family.test", "desk@family.test"),
        delegatedSendingLimits("kim@family.test", "kim@family.test"),
      ),
    );
  });

  it("removes both copies when the submission request fails with a method error, recorded as failed", async () => {
    const t = setup();
    t.grant(DESK, "send_on_behalf");
    t.server.fail("EmailSubmission/set", "error", 2);
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    const draftId = await t.draft(sessionId);
    await expect(
      t.svc.send(sessionId, draftId, KIM_ID, "acc-kim@family.test", { from: "desk@family.test", req }),
    ).rejects.toBeInstanceOf(WebmailUnavailableError);
    const desk = t.server.box("desk@family.test");
    expect(desk.submissions).toEqual([]);
    expect(desk.emails.size).toBe(0);
    expect(t.outcomes("delegation.send_failed")).toHaveLength(1);
  });

  it("finds and removes the copies when the creating request was applied but its answer lost", async () => {
    const t = setup();
    t.grant(DESK, "send_on_behalf");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    const draftId = await t.draft(sessionId);
    t.server.fail("Email/set", "lost");
    await expect(
      t.svc.send(sessionId, draftId, KIM_ID, "acc-kim@family.test", { from: "desk@family.test", req }),
    ).rejects.toBeInstanceOf(WebmailUnavailableError);
    expect(t.server.box("desk@family.test").emails.size).toBe(0);
    expect(stored(t, "desk@family.test")).not.toContain(ON_BEHALF_HEADER);
    expect(t.server.box("desk@family.test").submissions).toEqual([]);
    expect(t.outcomes("delegation.send_failed")).toHaveLength(1);
  });

  it("treats a submission applied but whose answer was lost as sent: kept copy stays, tagged copy gone", async () => {
    const t = setup();
    t.grant(DESK, "send_on_behalf");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    const draftId = await t.draft(sessionId);
    t.server.fail("EmailSubmission/set", "lost");
    const out = await t.svc.send(sessionId, draftId, KIM_ID, "acc-kim@family.test", {
      from: "desk@family.test",
      req,
    });
    const desk = t.server.box("desk@family.test");
    expect(out.submissionId).toBe(desk.submissions[0]?.id);
    expect([...desk.emails.values()].map((e) => e.mailboxIds)).toEqual([{ "sent-desk@family.test": true }]);
    expect(stored(t, "desk@family.test")).not.toContain(ON_BEHALF_HEADER);
    expect(t.outcomes("delegation.send_failed")).toEqual([]);
  });

  it("keeps 'unknown' apart from 'not sent': lost answer and failed lookup keep the Sent copy and say so", async () => {
    const t = setup();
    t.grant(DESK, "send_on_behalf");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    const draftId = await t.draft(sessionId);
    t.server.fail("EmailSubmission/set", "lost");
    t.server.fail("EmailSubmission/query", "error", 2);
    const err = await t.svc
      .send(sessionId, draftId, KIM_ID, "acc-kim@family.test", { from: "desk@family.test", req })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebmailSendUnconfirmedError);
    const res = webmailErrorResponse(err);
    expect(res?.status).toBe(503);
    expect(await res?.json()).toEqual({
      error: {
        code: "send_unconfirmed",
        message: "We couldn't confirm whether this was sent. Check Sent before sending it again.",
      },
    });
    const desk = t.server.box("desk@family.test");
    // It was in fact submitted: its kept copy is still in Sent, the tagged one is gone.
    expect(desk.submissions).toHaveLength(1);
    expect([...desk.emails.values()].map((e) => e.mailboxIds)).toEqual([{ "sent-desk@family.test": true }]);
    expect(stored(t, "desk@family.test")).not.toContain(ON_BEHALF_HEADER);
    expect(t.outcomes("delegation.send_failed")[0]).toMatchObject({ meta: { reason: "unknown" } });
  });

  it("answers a sent message as sent even when recording a left-behind tagged copy fails, with undo held", async () => {
    const t = setup();
    t.grant(DESK, "send_on_behalf");
    t.server.keepOnSuccess();
    t.server.refuseDestroys(true);
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    const draftId = await t.draft(sessionId);
    t.failOutcomes(2);
    const out = await t.svc.send(sessionId, draftId, KIM_ID, "acc-kim@family.test", {
      from: "desk@family.test",
      req,
    });
    expect(out.submissionId).toBe(t.server.box("desk@family.test").submissions[0]?.id);
    expect(t.outcomes("delegation.tagged_copy_left")).toEqual([]);
    // The hold was registered: undo works and hands the own draft back.
    t.server.refuseDestroys(false);
    expect(
      await t.svc.undoSend(sessionId, out.submissionId, "acc-kim@family.test", { mailbox: "desk@family.test", req }),
    ).toEqual({ draftId });
  });

  it("removes the tagged copy itself when the submission didn't, retrying once, and records one it couldn't", async () => {
    const t = setup();
    t.grant(DESK, "send_on_behalf");
    t.server.keepOnSuccess();
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    const first = await t.draft(sessionId);
    await t.svc.send(sessionId, first, KIM_ID, "acc-kim@family.test", { from: "desk@family.test", req });
    expect(stored(t, "desk@family.test")).not.toContain(ON_BEHALF_HEADER);
    t.server.refuseDestroys(true);
    const second = await t.draft(sessionId);
    await t.svc.send(sessionId, second, KIM_ID, "acc-kim@family.test", { from: "desk@family.test", req });
    expect(t.outcomes("delegation.tagged_copy_left")[0]).toMatchObject({ target: { id: DESK } });
  });

  it("undo uses only the entry already open: never mints one, answers 'already sent' without it", async () => {
    const t = setup();
    t.grant(DESK, "send_as");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    const draftId = await t.draft(sessionId);
    const { submissionId } = await t.svc.send(sessionId, draftId, KIM_ID, "acc-kim@family.test", {
      from: "desk@family.test",
      req,
    });
    await t.svc.dropDelegated(sessionId, new Set(["desk@family.test"]));
    await expect(
      t.svc.undoSend(sessionId, submissionId, "acc-kim@family.test", { mailbox: "desk@family.test", req }),
    ).rejects.toThrow(/already been sent/);
    expect(t.minted).toEqual(["desk@family.test"]);
    expect(t.server.box("desk@family.test").submissions[0]?.undoStatus).toBe("pending");
  });

  it("undo still cancels after the send right was revoked in the hold (it only reduces what is sent)", async () => {
    const t = setup();
    t.grant(DESK, "send_as");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    const draftId = await t.draft(sessionId);
    const { submissionId } = await t.svc.send(sessionId, draftId, KIM_ID, "acc-kim@family.test", {
      from: "desk@family.test",
      req,
    });
    t.revoke("send_as");
    expect(
      await t.svc.undoSend(sessionId, submissionId, "acc-kim@family.test", { mailbox: "desk@family.test", req }),
    ).toEqual({ draftId });
    expect(t.server.box("desk@family.test").submissions[0]?.undoStatus).toBe("canceled");
  });

  it("retries the undo's audit once, and answers an error after the cancel when it still can't be written", async () => {
    const t = setup();
    t.grant(DESK, "send_as");
    const { sessionId } = await t.svc.signIn("kim@family.test", "right");
    const d1 = await t.draft(sessionId);
    const s1 = await t.svc.send(sessionId, d1, KIM_ID, "acc-kim@family.test", { from: "desk@family.test", req });
    t.failOutcomes(1);
    await t.svc.undoSend(sessionId, s1.submissionId, "acc-kim@family.test", { mailbox: "desk@family.test", req });
    expect(t.outcomes("delegation.send_cancelled")).toHaveLength(1);
    const d2 = await t.draft(sessionId);
    const s2 = await t.svc.send(sessionId, d2, KIM_ID, "acc-kim@family.test", { from: "desk@family.test", req });
    t.failOutcomes(2);
    await expect(
      t.svc.undoSend(sessionId, s2.submissionId, "acc-kim@family.test", { mailbox: "desk@family.test", req }),
    ).rejects.toBeInstanceOf(WebmailUnavailableError);
    // Cancelled all the same.
    expect(t.server.box("desk@family.test").submissions[1]?.undoStatus).toBe("canceled");
  });

  it("keeps the proxy from writing a Sender or the tag, so a delegate's own session can't attach one", () => {
    for (const create of [
      { sender: [{ email: "kim@family.test" }] },
      { [`header:${ON_BEHALF_HEADER}:asText`]: "0".repeat(64) },
      { [`header:${ON_BEHALF_EXPIRES_HEADER}:asText`]: "2099-01-01T00:00:00Z" },
    ]) {
      const res = checkJmapRequest(
        {
          using: ["urn:ietf:params:jmap:core", MAIL],
          methodCalls: [["Email/set", { accountId: "acc", create: { x: create } }, "c"]],
        },
        "acc",
      );
      expect(res.ok).toBe(false);
    }
  });
});
