// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createKeyRing } from "@anhourmail/server/keyring";
import { memorySlidingQuota, type SlidingQuotaStore } from "@anhourmail/server/rate-limit";
import { setLogSinkForTests } from "@anhourmail/server/log";

import { TRUST_TIERS } from "@anhourmail/shared";

import { ContactInput } from "./contacts";
import {
  COMPOSED_KEYWORD,
  DraftInput,
  draftEmail,
  draftProblem,
  MAX_RECIPIENTS,
  sendCheck,
  type StoredDraft,
  UNDO_SECONDS,
  uploadType,
} from "./compose";
import {
  GrantRefusedError,
  WebmailBlockedError,
  WebmailQuotaError,
  WebmailRefusedError,
  WebmailService,
  WebmailSignInError,
  WebmailUnavailableError,
} from "./service";
import { memoryKv, WebmailSessionStore } from "./session-store";

beforeEach(() => {
  setLogSinkForTests(() => undefined);
});
afterEach(() => {
  setLogSinkForTests(null);
});

const MAIL = "urn:ietf:params:jmap:mail";
const identity = { id: "i1", name: "Alex", email: "a@x.test" };

describe("draft validation", () => {
  const base = { identityId: "i1", subject: "Hi", text: "Hello" };

  it("accepts a normal draft and cleans header-breaking input", () => {
    const d = DraftInput.parse({
      ...base,
      subject: "Line one\r\nBcc: evil@x.test",
      to: [{ name: 'Sam "the" <boss>\nX', email: "s@x.test" }],
      attachments: [{ blobId: "b1", name: "re‮port.pdf", type: "text/html; charset=x", size: 10 }],
    });
    expect(d.subject).toBe("Line one Bcc: evil@x.test");
    expect(d.to[0]?.name).toBe("Sam  the   boss  X");
    expect(d.attachments[0]?.name).toBe("re_port.pdf");
    expect(d.attachments[0]?.type).toBe("application/octet-stream");
    expect(draftProblem(d)).toBeNull();
  });

  it("refuses bad addresses, ids, message ids and oversize parts", () => {
    for (const bad of [
      { ...base, to: [{ email: "not an address" }] },
      { ...base, identityId: "../x" },
      { ...base, replaces: "a b" },
      { ...base, inReplyTo: ["<x@y>"] },
      { ...base, text: "x".repeat(512 * 1024 + 1) },
      { ...base, attachments: [{ blobId: "b", name: "a", type: "text/plain", size: 21 * 1024 * 1024 }] },
      { ...base, to: Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => ({ email: `p${String(i)}@x.test` })) },
    ]) {
      expect(DraftInput.safeParse(bad).success).toBe(false);
    }
    const many = DraftInput.parse({
      ...base,
      to: Array.from({ length: 60 }, (_, i) => ({ email: `t${String(i)}@x.test` })),
      cc: Array.from({ length: 60 }, (_, i) => ({ email: `c${String(i)}@x.test` })),
    });
    expect(draftProblem(many)?.message).toMatch(/at most/);
    const heavy = DraftInput.parse({
      ...base,
      attachments: [1, 2].map((i) => ({ blobId: `b${String(i)}`, name: "f", type: "a/b", size: 15 * 1024 * 1024 })),
    });
    expect(draftProblem(heavy)?.message).toMatch(/25 MB/);
  });

  it("builds a plain-text draft in Drafts from the chosen identity", () => {
    const d = DraftInput.parse({
      ...base,
      to: [{ email: "S@X.test" }],
      inReplyTo: ["m1@x.test"],
      references: ["m0@x.test", "m1@x.test"],
      attachments: [{ blobId: "b1", name: "a.pdf", type: "application/pdf", size: 3 }],
    });
    const e = draftEmail(d, identity, "drafts");
    expect(e).toMatchObject({
      mailboxIds: { drafts: true },
      keywords: { $draft: true, $seen: true, [COMPOSED_KEYWORD]: true },
      from: [{ name: "Alex", email: "a@x.test" }],
      to: [{ name: null, email: "s@x.test" }],
      inReplyTo: ["m1@x.test"],
      references: ["m0@x.test", "m1@x.test"],
      bodyValues: { body: { value: "Hello" } },
      textBody: [{ partId: "body", type: "text/plain" }],
      attachments: [{ blobId: "b1", type: "application/pdf", name: "a.pdf", disposition: "attachment" }],
    });
    expect(draftEmail(DraftInput.parse(base), { id: "i", name: "a@x.test", email: "a@x.test" }, "d").from).toEqual([
      { name: null, email: "a@x.test" },
    ]);
  });

  it("only sends a real draft, from the chosen identity, to 1..max recipients, within the size cap", () => {
    const draft: StoredDraft = {
      id: "d1",
      mailboxIds: { drafts: true },
      keywords: { $draft: true, [COMPOSED_KEYWORD]: true },
      from: [{ email: "A@x.test" }],
      to: [{ email: "s@x.test" }],
      cc: [{ email: "S@x.test" }],
      bcc: null,
      size: 100,
    };
    expect(sendCheck(draft, identity, "drafts")).toEqual({ ok: true, rcptTo: ["s@x.test"] });
    expect(sendCheck({ ...draft, mailboxIds: { inbox: true } }, identity, "drafts").ok).toBe(false);
    expect(sendCheck({ ...draft, keywords: {} }, identity, "drafts").ok).toBe(false);
    expect(sendCheck({ ...draft, from: [{ email: "boss@x.test" }] }, identity, "drafts").ok).toBe(false);
    expect(sendCheck({ ...draft, from: [{ email: "a@x.test" }, { email: "b@x.test" }] }, identity, "drafts").ok).toBe(
      false,
    );
    expect(sendCheck({ ...draft, from: null }, identity, "drafts").ok).toBe(false);
    expect(sendCheck({ ...draft, to: null, cc: null }, identity, "drafts").ok).toBe(false);
    const crowd = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => ({ email: `p${String(i)}@x.test` }));
    expect(sendCheck({ ...draft, to: crowd }, identity, "drafts").ok).toBe(false);
    expect(sendCheck({ ...draft, size: 31 * 1024 * 1024 }, identity, "drafts").ok).toBe(false);
    // Only drafts the BFF built (carrying its marker) can be sent: never a message promoted by hand.
    expect(sendCheck({ ...draft, keywords: { $draft: true } }, identity, "drafts").ok).toBe(false);
    // The `new` tier (the default) allows 10 recipients a message; `restricted` sends nothing.
    const eleven = Array.from({ length: 11 }, (_, i) => ({ email: `p${String(i)}@x.test` }));
    expect(sendCheck({ ...draft, to: eleven }, identity, "drafts")).toMatchObject({ ok: false });
    expect(sendCheck(draft, identity, "drafts", TRUST_TIERS.standard.limits).ok).toBe(true);
    expect(sendCheck(draft, identity, "drafts", TRUST_TIERS.restricted.limits)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/paused/) as unknown,
    });
  });

  it("reduces upload content types to a plain token pair", () => {
    expect(uploadType("image/PNG; name=x")).toBe("image/png");
    expect(uploadType("text/html\r\nX-Evil: 1")).toBe("application/octet-stream");
    expect(uploadType(null)).toBe("application/octet-stream");
  });
});

// ---- a tiny fake Stalwart ---------------------------------------------------------------------------------

type Email = StoredDraft & { subject?: string };

function fakeStalwart() {
  const state = {
    emails: new Map<string, Email>([
      [
        "inb1",
        { id: "inb1", mailboxIds: { inbox: true }, keywords: {}, from: null, to: null, cc: null, bcc: null, size: 1 },
      ],
      [
        "tr1",
        { id: "tr1", mailboxIds: { trash: true }, keywords: {}, from: null, to: null, cc: null, bcc: null, size: 1 },
      ],
      [
        "jk1",
        { id: "jk1", mailboxIds: { junk: true }, keywords: {}, from: null, to: null, cc: null, bcc: null, size: 1 },
      ],
      [
        "handmade",
        {
          id: "handmade",
          mailboxIds: { drafts: true },
          keywords: { $draft: true },
          from: [{ email: "a@x.test" }],
          to: [{ email: "s@x.test" }],
          cc: null,
          bcc: null,
          size: 10,
        },
      ],
    ]),
    submissions: new Map<string, { emailId: string; undoStatus: string }>(),
    seq: 0,
    calls: [] as string[],
    uploads: [] as { type: string | null; size: number }[],
    refuseSubmission: false,
    books: new Map<string, { id: string; name: string; isDefault: boolean; description: string | null }>([
      ["b", { id: "b", name: "Stalwart Address Book", isDefault: true, description: null }],
    ]),
    cards: new Map<string, Record<string, unknown> & { id: string }>(),
    failContacts: false,
  };
  const handlers: Record<string, (a: Record<string, unknown>) => unknown> = {
    "AddressBook/get": () => ({ list: [...state.books.values()] }),
    "AddressBook/set": (a) => {
      const created: Record<string, { id: string }> = {};
      for (const [k, v] of Object.entries((a.create ?? {}) as Record<string, { name: string; description?: string }>)) {
        const id = `bk${String(++state.seq)}`;
        state.books.set(id, { id, name: v.name, isDefault: false, description: v.description ?? null });
        created[k] = { id };
      }
      for (const [id, patch] of Object.entries((a.update ?? {}) as Record<string, { description?: string }>)) {
        const b = state.books.get(id);
        if (b && patch.description !== undefined) b.description = patch.description;
      }
      return { created, updated: {} };
    },
    "ContactCard/query": (a) => {
      const email = (a.filter as { email?: string } | undefined)?.email?.toLowerCase();
      const ids = [...state.cards.values()]
        .filter(
          (c) =>
            email === undefined ||
            Object.values((c.emails ?? {}) as Record<string, { address: string }>).some(
              (e) => e.address.toLowerCase() === email,
            ),
        )
        .map((c) => c.id);
      const limit = typeof a.limit === "number" ? a.limit : ids.length;
      return { ids: ids.slice(0, limit), ...(a.calculateTotal === true ? { total: ids.length } : {}) };
    },
    "ContactCard/get": (a) => ({
      list: (Array.isArray(a.ids) ? (a.ids as string[]) : [...state.cards.keys()])
        .map((id) => state.cards.get(id))
        .filter(Boolean),
    }),
    "ContactCard/set": (a) => {
      // Which account the cards were written to (auto-save must use the account that sent).
      if (a.create) state.calls.push(`cards@${String(a.accountId)}`);
      const created: Record<string, { id: string }> = {};
      for (const [k, v] of Object.entries((a.create ?? {}) as Record<string, Record<string, unknown>>)) {
        const id = `ct${String(++state.seq)}`;
        state.cards.set(id, { ...v, id });
        created[k] = { id };
      }
      const updated: Record<string, null> = {};
      for (const [id, patch] of Object.entries((a.update ?? {}) as Record<string, Record<string, unknown>>)) {
        const c = state.cards.get(id);
        if (!c) continue;
        Object.assign(c, patch);
        updated[id] = null;
      }
      const destroyed: string[] = [];
      for (const id of (a.destroy ?? []) as string[]) if (state.cards.delete(id)) destroyed.push(id);
      return { created, updated, destroyed };
    },
    "Mailbox/get": () => ({
      list: ["inbox", "drafts", "sent", "archive", "junk", "trash"].map((role) => ({ id: role, role })),
    }),
    "Identity/get": () => ({
      list: [identity, { id: "i2", name: "a@x.test", email: "hello@x.test" }],
    }),
    "Email/get": (a) => ({ list: (a.ids as string[]).map((id) => state.emails.get(id)).filter(Boolean) }),
    "Email/set": (a) => {
      const created: Record<string, { id: string }> = {};
      for (const [k, v] of Object.entries((a.create ?? {}) as Record<string, Email & { to: { email: string }[] }>)) {
        const id = `e${String(++state.seq)}`;
        state.emails.set(id, { ...v, id, size: 500 });
        created[k] = { id };
      }
      for (const id of (a.destroy ?? []) as string[]) state.emails.delete(id);
      for (const [id, patch] of Object.entries((a.update ?? {}) as Record<string, Record<string, unknown>>)) {
        const e = state.emails.get(id);
        if (!e) continue;
        for (const [path, value] of Object.entries(patch)) {
          const [field, key] = path.split("/") as ["mailboxIds" | "keywords", string];
          const next = { ...e[field] };
          if (value === null) e[field] = Object.fromEntries(Object.entries(next).filter(([k]) => k !== key));
          else e[field] = { ...next, [key]: true };
        }
      }
      return { created, updated: Object.fromEntries(Object.keys(a.update ?? {}).map((k) => [k, null])) };
    },
    "EmailSubmission/set": (a) => {
      if (a.create) {
        if (state.refuseSubmission) return { notCreated: { send: { type: "forbiddenFrom" } } };
        const create = (a.create as Record<string, { emailId: string; envelope: unknown }>).send;
        const id = `s${String(++state.seq)}`;
        state.submissions.set(id, { emailId: create?.emailId ?? "", undoStatus: "pending" });
        // onSuccessUpdateEmail: Drafts → Sent, no $draft.
        const e = state.emails.get(create?.emailId ?? "");
        if (e) {
          e.mailboxIds = { sent: true };
          delete e.keywords.$draft;
        }
        state.calls.push(`submit ${JSON.stringify(create?.envelope)}`);
        return { created: { send: { id, sendAt: "2026-10-22T00:00:06Z" } } };
      }
      const updated: Record<string, null> = {};
      for (const id of Object.keys(a.update ?? {})) {
        const sub = state.submissions.get(id);
        if (sub?.undoStatus === "pending") {
          sub.undoStatus = "canceled";
          updated[id] = null;
        }
      }
      return { updated, notUpdated: {} };
    },
    "EmailSubmission/get": (a) => ({
      list: (a.ids as string[]).flatMap((id) => {
        const s = state.submissions.get(id);
        return s ? [{ id, ...s }] : [];
      }),
    }),
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/jmap/session")) {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      const user = auth.replace("Bearer at-", "");
      return Response.json({ username: user, primaryAccounts: { [MAIL]: `acc-${user}` } });
    }
    if (url.includes("/jmap/upload/")) {
      const body = init?.body as Uint8Array;
      state.uploads.push({ type: new Headers(init?.headers).get("content-type"), size: body.byteLength });
      return Response.json({ blobId: "blob9", size: body.byteLength, type: "x" });
    }
    const req = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      using: string[];
      methodCalls: [string, Record<string, unknown>, string][];
    };
    const methodResponses = req.methodCalls.map(([name, args, id]) => {
      state.calls.push(name);
      if (name.startsWith("EmailSubmission") || name === "Identity/get") {
        expect(req.using).toContain("urn:ietf:params:jmap:submission");
      }
      if (name.startsWith("ContactCard") || name.startsWith("AddressBook")) {
        expect(req.using).toContain("urn:ietf:params:jmap:contacts");
      }
      const h = state.failContacts && name.startsWith("ContactCard") ? undefined : handlers[name];
      // Like the server: at most 500 objects per /get (getMaxResults).
      if (name.endsWith("/get") && Array.isArray(args.ids) && args.ids.length > 500) {
        return ["error", { type: "requestTooLarge" }, id];
      }
      return h ? [name, h(args), id] : ["error", { type: "unknownMethod" }, id];
    });
    return Response.json({ methodResponses });
  }) as typeof fetch;
  return { state, fetchImpl };
}

function setup(
  allowed: (a: string) => boolean = () => true,
  quota: SlidingQuotaStore = memorySlidingQuota(),
  holdSeconds?: (address: string) => Promise<number>,
) {
  const fake = fakeStalwart();
  const deferred: { fn: () => void; ms: number }[] = [];
  /** Lets held submissions go out (or not), then runs what the service deferred and waits for it. */
  const afterHold = async (release = true) => {
    if (release)
      for (const sub of fake.state.submissions.values()) if (sub.undoStatus === "pending") sub.undoStatus = "final";
    const due = deferred.splice(0);
    for (const d of due) d.fn();
    await new Promise((r) => setTimeout(r, 30));
    return due;
  };
  const svc = new WebmailService({
    store: new WebmailSessionStore(memoryKv(), createKeyRing([{ id: "k", key: randomBytes(32) }])),
    oauth: {
      signIn: async (name, secret) => {
        if (secret !== "right") throw new GrantRefusedError("no");
        return { accessToken: `at-${name}`, refreshToken: "rt", expiresAt: Date.now() + 3_600_000 };
      },
      refresh: async () => ({ accessToken: "at-x", refreshToken: "rt", expiresAt: Date.now() + 3_600_000 }),
    },
    stalwartUrl: "http://stalwart",
    access: { allowed: async (a) => allowed(a) },
    quota,
    sieve: { read: async () => null, write: async () => undefined },
    confirmedForward: async () => null,
    fetch: fake.fetchImpl,
    defer: (fn, ms) => {
      deferred.push({ fn, ms });
    },
    ...(holdSeconds ? { holdSeconds } : {}),
  });
  return { svc, deferred, afterHold, ...fake };
}

const draft = (over: Record<string, unknown> = {}) =>
  DraftInput.parse({ identityId: "i1", to: [{ email: "s@x.test" }], subject: "Hi", text: "Hello", ...over });

describe("compose and send through the BFF", () => {
  it("refuses drafts, sending, undo and uploads for a mailbox the tab doesn't show any more", async () => {
    const t = setup();
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    const a = "acc-a@x.test";
    // The tab showing a@ works normally with its own account.
    const d = await t.svc.saveDraft(sessionId, draft(), a);
    const sent = await t.svc.send(sessionId, d.id, "i1", a);
    // Another tab switches the session to b@: the first tab's requests are refused, never applied to b@.
    await t.svc.addMailbox(sessionId, "b@x.test", "right");
    const changed = /active mailbox changed/;
    await expect(t.svc.saveDraft(sessionId, draft(), a)).rejects.toThrow(changed);
    await expect(t.svc.send(sessionId, d.id, "i1", a)).rejects.toThrow(changed);
    await expect(t.svc.undoSend(sessionId, sent.submissionId, a)).rejects.toThrow(changed);
    await expect(t.svc.upload(sessionId, new Uint8Array([1, 2, 3]), "text/plain", a)).rejects.toThrow(changed);
    // The tab now showing b@ can.
    await expect(t.svc.upload(sessionId, new Uint8Array([1]), "text/plain", "acc-b@x.test")).resolves.toMatchObject({
      blobId: expect.any(String) as unknown,
    });
  });

  it("saves a draft, replaces it on autosave, sends it held for undo, and undo puts it back in Drafts", async () => {
    const t = setup();
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    const first = await t.svc.saveDraft(sessionId, draft());
    const second = await t.svc.saveDraft(sessionId, draft({ replaces: first.id, text: "Hello again" }));
    expect(t.state.emails.has(first.id)).toBe(false);
    expect(t.state.emails.get(second.id)?.mailboxIds).toEqual({ drafts: true });

    const sent = await t.svc.send(sessionId, second.id, "i1");
    expect(t.state.emails.get(second.id)?.mailboxIds).toEqual({ sent: true });
    const submit = t.state.calls.find((c) => c.startsWith("submit "));
    expect(submit).toContain(`"HOLDFOR":"${String(UNDO_SECONDS)}"`);
    expect(submit).toContain('"rcptTo":[{"email":"s@x.test"}]');
    expect(submit).toContain('"mailFrom":{"email":"a@x.test"');

    const undone = await t.svc.undoSend(sessionId, sent.submissionId);
    expect(undone.draftId).toBe(second.id);
    expect(t.state.emails.get(second.id)?.mailboxIds).toEqual({ drafts: true });
    expect(t.state.emails.get(second.id)?.keywords.$draft).toBe(true);
    // Too late (already cancelled or released): refused.
    await expect(t.svc.undoSend(sessionId, sent.submissionId)).rejects.toBeInstanceOf(WebmailRefusedError);
    await expect(t.svc.undoSend(sessionId, "nope")).rejects.toBeInstanceOf(WebmailRefusedError);
  });

  it("holds a send for the mailbox's chosen undo delay, falling back to the default when it can't be read", async () => {
    const chosen = setup(undefined, undefined, async () => 20);
    const a = await chosen.svc.signIn("a@x.test", "right");
    const d = await chosen.svc.saveDraft(a.sessionId, draft());
    expect((await chosen.svc.send(a.sessionId, d.id, "i1")).holdSeconds).toBe(20);
    expect(chosen.state.calls.find((c) => c.startsWith("submit "))).toContain('"HOLDFOR":"20"');
    expect(chosen.deferred[0]?.ms).toBe(22_000);

    for (const broken of [async () => Promise.reject(new Error("db down")), async () => 600]) {
      const t = setup(undefined, undefined, broken);
      const s = await t.svc.signIn("a@x.test", "right");
      const d2 = await t.svc.saveDraft(s.sessionId, draft());
      expect((await t.svc.send(s.sessionId, d2.id, "i1")).holdSeconds).toBe(UNDO_SECONDS);
    }
  });

  it("refuses someone else's identity, non-drafts, and drafts it can't replace", async () => {
    const t = setup();
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    await expect(t.svc.saveDraft(sessionId, draft({ identityId: "other" }))).rejects.toBeInstanceOf(
      WebmailRefusedError,
    );
    await expect(t.svc.saveDraft(sessionId, draft({ replaces: "inb1" }))).rejects.toBeInstanceOf(WebmailRefusedError);
    await expect(t.svc.send(sessionId, "inb1", "i1")).rejects.toThrow(/saved draft/);
    await expect(t.svc.send(sessionId, "missing", "i1")).rejects.toThrow(/saved draft/);
    const d = await t.svc.saveDraft(sessionId, draft());
    // From is i1's address; sending it as i2 is refused.
    await expect(t.svc.send(sessionId, d.id, "i2")).rejects.toThrow(/own addresses/);
    await expect(t.svc.send(sessionId, d.id, "zz")).rejects.toThrow(/own addresses/);
    t.state.refuseSubmission = true;
    await expect(t.svc.send(sessionId, d.id, "i1")).rejects.toThrow(/didn't accept/);
    const crowded = draft({
      to: Array.from({ length: 60 }, (_, i) => ({ email: `t${String(i)}@x.test` })),
      cc: Array.from({ length: 60 }, (_, i) => ({ email: `c${String(i)}@x.test` })),
    });
    await expect(t.svc.saveDraft(sessionId, crowded)).rejects.toThrow(/at most/);
  });

  it("lets the proxy destroy only messages in Trash or Junk", async () => {
    const t = setup();
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    const body = (ids: string[]) => ({
      using: ["urn:ietf:params:jmap:core", MAIL],
      methodCalls: [["Email/set", { accountId: "acc-a@x.test", destroy: ids }, "d"]] as [
        string,
        Record<string, unknown>,
        string,
      ][],
    });
    await expect(t.svc.jmap(sessionId, body(["tr1", "jk1"]), ["tr1", "jk1"])).resolves.toMatchObject({ status: 200 });
    expect(t.state.emails.has("tr1")).toBe(false);
    await expect(t.svc.jmap(sessionId, body(["inb1"]), ["inb1"])).rejects.toBeInstanceOf(WebmailRefusedError);
    await expect(t.svc.jmap(sessionId, body(["gone"]), ["gone"])).rejects.toBeInstanceOf(WebmailRefusedError);
    expect(t.state.emails.has("inb1")).toBe(true);
  });

  it("uploads an attachment to the active mailbox", async () => {
    const t = setup();
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    expect(await t.svc.upload(sessionId, new Uint8Array([1, 2, 3]), "image/png")).toEqual({
      blobId: "blob9",
      type: "image/png",
      size: 3,
    });
    expect(t.state.uploads).toEqual([{ type: "image/png", size: 3 }]);
  });

  it("caches identities and folder roles per mailbox", async () => {
    const t = setup();
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    await t.svc.identities(sessionId);
    await t.svc.identities(sessionId);
    await t.svc.roles(sessionId);
    await t.svc.roles(sessionId);
    expect(t.state.calls.filter((c) => c === "Identity/get")).toHaveLength(1);
    expect(t.state.calls.filter((c) => c === "Mailbox/get")).toHaveLength(1);
  });
});

describe("several mailboxes in one session", () => {
  it("adds, lists and switches mailboxes, each with its own tokens", async () => {
    const t = setup();
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    await t.svc.addMailbox(sessionId, "b@x.test", "right");
    expect(await t.svc.mailboxes(sessionId)).toEqual({ active: "b@x.test", others: ["a@x.test"] });
    expect((await t.svc.session(sessionId))?.accountId).toBe("acc-b@x.test");
    await t.svc.switchMailbox(sessionId, "a@x.test");
    expect(await t.svc.mailboxes(sessionId)).toEqual({ active: "a@x.test", others: ["b@x.test"] });
    expect((await t.svc.session(sessionId))?.accessToken).toBe("at-a@x.test");
    // Re-adding one already there renews it instead of duplicating.
    await t.svc.addMailbox(sessionId, "b@x.test", "right");
    expect(await t.svc.mailboxes(sessionId)).toEqual({ active: "b@x.test", others: ["a@x.test"] });
    // Same answers for a wrong password; unknown switch targets are refused.
    await expect(t.svc.addMailbox(sessionId, "c@x.test", "wrong")).rejects.toBeInstanceOf(WebmailSignInError);
    await expect(t.svc.switchMailbox(sessionId, "zz@x.test")).rejects.toBeInstanceOf(WebmailRefusedError);
    expect(await t.svc.switchMailbox(sessionId, "b@x.test")).toMatchObject({ username: "b@x.test" });
  });

  it("caps the number of mailboxes and drops a suspended one on switch", async () => {
    let blocked = "";
    const t = setup((a) => a !== blocked);
    const { sessionId } = await t.svc.signIn("m0@x.test", "right");
    for (let i = 1; i < 5; i++) await t.svc.addMailbox(sessionId, `m${String(i)}@x.test`, "right");
    await expect(t.svc.addMailbox(sessionId, "m5@x.test", "right")).rejects.toThrow(/5 mailboxes/);
    blocked = "m0@x.test";
    await expect(t.svc.switchMailbox(sessionId, "m0@x.test")).rejects.toThrow(/can't be used/);
    expect((await t.svc.mailboxes(sessionId))?.others).not.toContain("m0@x.test");
    // Adding a blocked mailbox is refused like a first sign-in.
    blocked = "m9@x.test";
    await expect(t.svc.addMailbox(sessionId, "m9@x.test", "right")).rejects.toBeInstanceOf(WebmailBlockedError);
    await t.svc.signOut(sessionId);
    expect(await t.svc.mailboxes(sessionId)).toBeNull();
    await expect(t.svc.addMailbox(sessionId, "m1@x.test", "right")).rejects.toThrow();
    await expect(t.svc.switchMailbox(sessionId, "m1@x.test")).rejects.toThrow();
  });
});

describe("sending limits and hand-made drafts", () => {
  const to = (n: number, tag: string) => Array.from({ length: n }, (_, i) => ({ email: `${tag}${String(i)}@x.test` }));

  it("refuses to send or replace a draft the BFF didn't build", async () => {
    const t = setup();
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    await expect(t.svc.send(sessionId, "handmade", "i1")).rejects.toThrow(/saved draft/);
    await expect(t.svc.saveDraft(sessionId, draft({ replaces: "handmade" }))).rejects.toThrow(/can't be changed/);
    expect(t.state.emails.has("handmade")).toBe(true);
  });

  it("charges the new tier's hourly limit by recipients, per mailbox, and refuses beyond it", async () => {
    const t = setup();
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    for (const tag of ["a", "b"]) {
      const d = await t.svc.saveDraft(sessionId, draft({ to: to(4, tag) }));
      await t.svc.send(sessionId, d.id, "i1");
    }
    const third = await t.svc.saveDraft(sessionId, draft({ to: to(4, "c") }));
    await expect(t.svc.send(sessionId, third.id, "i1")).rejects.toBeInstanceOf(WebmailQuotaError);
    // Two recipients still fit (8 + 2 = 10 an hour); the refused attempt charged nothing.
    const fits = await t.svc.saveDraft(sessionId, draft({ to: to(2, "d") }));
    await expect(t.svc.send(sessionId, fits.id, "i1")).resolves.toMatchObject({
      submissionId: expect.any(String) as unknown,
    });
    // Another session for the same mailbox shares the mailbox's quota.
    const other = await t.svc.signIn("a@x.test", "right");
    const d2 = await t.svc.saveDraft(other.sessionId, draft({ to: to(1, "e") }));
    await expect(t.svc.send(other.sessionId, d2.id, "i1")).rejects.toBeInstanceOf(WebmailQuotaError);
  });

  it("fails closed when the quota store is down", async () => {
    const t = setup(() => true, { take: () => Promise.reject(new Error("redis down")) });
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    const d = await t.svc.saveDraft(sessionId, draft());
    await expect(t.svc.send(sessionId, d.id, "i1")).rejects.toBeInstanceOf(WebmailUnavailableError);
    expect(t.state.calls.some((c) => c.startsWith("submit"))).toBe(false);
  });

  it("refuses to submit if the active mailbox changed during the send", async () => {
    const holder: { svc: WebmailService | null; sid: string } = { svc: null, sid: "" };
    const t = setup(() => true, {
      take: async () => {
        // Another tab switches mailbox while this send is in progress.
        await holder.svc?.switchMailbox(holder.sid, "b@x.test");
        return true;
      },
    });
    holder.svc = t.svc;
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    holder.sid = sessionId;
    await t.svc.addMailbox(sessionId, "b@x.test", "right");
    await t.svc.switchMailbox(sessionId, "a@x.test");
    const d = await t.svc.saveDraft(sessionId, draft());
    await expect(t.svc.send(sessionId, d.id, "i1")).rejects.toThrow(/active mailbox changed/);
    expect(t.state.calls.some((c) => c.startsWith("submit"))).toBe(false);
  });
});

describe("session writes are compare-and-set", () => {
  it("a refresh finishing after another tab switched mailbox doesn't undo the switch", async () => {
    let release: () => void = () => undefined;
    const fake = fakeStalwart();
    const store = new WebmailSessionStore(memoryKv(), createKeyRing([{ id: "k", key: randomBytes(32) }]));
    let now = Date.now();
    const svc = new WebmailService({
      store,
      oauth: {
        signIn: async (name) => ({ accessToken: `at-${name}`, refreshToken: "rt", expiresAt: now + 3_600_000 }),
        refresh: () =>
          new Promise((resolve) => {
            release = () => {
              resolve({ accessToken: "late", refreshToken: "rt", expiresAt: now + 3_600_000 });
            };
          }),
      },
      stalwartUrl: "http://stalwart",
      access: { allowed: async () => true },
      quota: memorySlidingQuota(),
      sieve: { read: async () => null, write: async () => undefined },
      confirmedForward: async () => null,
      fetch: fake.fetchImpl,
      now: () => now,
    });
    const { sessionId } = await svc.signIn("a@x.test", "right");
    await svc.addMailbox(sessionId, "b@x.test", "right");
    now += 3_600_000; // the active mailbox (b) is due for a refresh
    const refreshing = svc.session(sessionId);
    await new Promise((r) => setTimeout(r, 0));
    // Meanwhile another tab switches back to a (its request writes the record first).
    const cur = await store.read(sessionId);
    if (!cur) throw new Error("session missing");
    const { others = [], createdAt, version, ...active } = cur;
    const a = others.find((m) => m.username === "a@x.test");
    if (!a) throw new Error("a missing");
    expect(await store.write(sessionId, { ...a, createdAt, version, others: [active] })).toBe(true);
    release();
    expect((await refreshing)?.username).toBe("a@x.test");
    expect((await store.read(sessionId))?.username).toBe("a@x.test");
  });
});

describe("contacts through the BFF", () => {
  const contact = (over: Record<string, unknown> = {}) =>
    ContactInput.parse({ given: "Sam", surname: "Rivera", emails: [{ address: "s@x.test" }], ...over });
  const ACC = "acc-a@x.test";
  const cards = (t: ReturnType<typeof setup>, n: number) => {
    for (let i = 0; i < n; i++) {
      t.state.cards.set(`k${String(i)}`, {
        id: `k${String(i)}`,
        name: { full: `P${String(i)}` },
        addressBookIds: { b: true },
      });
    }
  };

  it("creates, lists, edits, moves and deletes contacts, and imports and exports vCards", async () => {
    const t = setup();
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    const { id } = await t.svc.createContact(sessionId, ACC, contact());
    let list = await t.svc.contacts(sessionId);
    expect(list).toMatchObject({ accountId: ACC, autoSave: true, truncated: false });
    expect(list.contacts.map((c) => [c.name, c.bookIds])).toEqual([["Sam Rivera", ["b"]]]);
    expect(list.books).toEqual([{ id: "b", name: "My contacts", isDefault: true, isOther: false }]);

    await t.svc.updateContact(sessionId, ACC, id, contact({ organization: "Trail Club" }));
    // The count the server actually moved (an unknown id isn't counted).
    expect(await t.svc.moveContacts(sessionId, ACC, [id, "missing"], "other")).toBe(1);
    list = await t.svc.contacts(sessionId);
    const other = list.books.find((b) => b.isOther);
    expect(list.contacts[0]).toMatchObject({ organization: "Trail Club", bookIds: [other?.id] });
    await expect(t.svc.updateContact(sessionId, ACC, "missing", contact())).rejects.toBeInstanceOf(WebmailRefusedError);

    const imported = await t.svc.importContacts(
      sessionId,
      ACC,
      "BEGIN:VCARD\nFN:Jo\nEMAIL:jo@x.test\nEND:VCARD\nBEGIN:VCARD\nEND:VCARD\n",
    );
    expect(imported).toEqual({ imported: 1, skipped: 1, full: false });
    expect(await t.svc.exportContacts(sessionId)).toContain("EMAIL:jo@x.test");
    expect(await t.svc.importContacts(sessionId, ACC, "nothing here")).toEqual({
      imported: 0,
      skipped: 0,
      full: false,
    });

    expect(await t.svc.deleteContacts(sessionId, ACC, [id])).toBe(1);
    expect((await t.svc.contacts(sessionId)).contacts.map((c) => c.name)).toEqual(["Jo"]);
  });

  it("refuses every change made for another mailbox than the active one", async () => {
    const t = setup();
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    const { id } = await t.svc.createContact(sessionId, ACC, contact());
    const other = "acc-b@x.test";
    const refused = [
      t.svc.createContact(sessionId, other, contact()),
      t.svc.updateContact(sessionId, other, id, contact()),
      t.svc.deleteContacts(sessionId, other, [id]),
      t.svc.moveContacts(sessionId, other, [id], "other"),
      t.svc.setAutoSave(sessionId, other, false),
      t.svc.importContacts(sessionId, other, "BEGIN:VCARD\nFN:Jo\nEND:VCARD\n"),
    ];
    for (const p of refused) await expect(p).rejects.toBeInstanceOf(WebmailRefusedError);
    expect((await t.svc.contacts(sessionId)).contacts.map((c) => c.name)).toEqual(["Sam Rivera"]);
  });

  it("keeps a mailbox to 5,000 contacts, and says when the list is cut", async () => {
    const t = setup();
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    cards(t, 4999);
    expect(
      (await t.svc.importContacts(sessionId, ACC, "BEGIN:VCARD\nFN:A\nEND:VCARD\nBEGIN:VCARD\nFN:B\nEND:VCARD\n")).full,
    ).toBe(true);
    await expect(t.svc.createContact(sessionId, ACC, contact())).rejects.toThrow(/up to 5,000 contacts/);
    const list = await t.svc.contacts(sessionId);
    expect([list.contacts.length, list.truncated]).toEqual([5000, false]);
    t.state.cards.set("extra", { id: "extra", name: { full: "Extra" }, addressBookIds: { b: true } });
    expect((await t.svc.contacts(sessionId)).truncated).toBe(true);
  });

  it("reads more contacts than one /get allows, in batches", async () => {
    const t = setup();
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    cards(t, 620);
    expect((await t.svc.contacts(sessionId)).contacts).toHaveLength(620);
  });

  it("saves new recipients to Other contacts once the send is released, never touching existing contacts", async () => {
    const t = setup();
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    await t.svc.createContact(
      sessionId,
      ACC,
      contact({ given: "Known", surname: "", emails: [{ address: "known@x.test" }] }),
    );
    const d = await t.svc.saveDraft(
      sessionId,
      draft({
        to: [
          { name: "New Person", email: "New@X.test" },
          { email: "KNOWN@x.test", name: "Other Name" },
        ],
        cc: [{ email: "new@x.test" }],
      }),
    );
    await t.svc.send(sessionId, d.id, "i1");
    // Nothing yet: the send can still be undone. Checked after the hold (6 s + 2 s).
    expect((await t.svc.contacts(sessionId)).contacts).toHaveLength(1);
    expect(t.deferred.map((x) => x.ms)).toEqual([8000]);
    await t.afterHold();
    const list = await t.svc.contacts(sessionId);
    const other = list.books.find((b) => b.isOther);
    expect(other).toBeDefined();
    expect(list.contacts.map((c) => [c.name, c.emails[0]?.address, c.bookIds[0] === other?.id])).toEqual([
      ["Known", "known@x.test", false],
      ["New Person", "new@x.test", true],
    ]);
  });

  it("saves nobody from an undone send, and checks again while the server still holds it", async () => {
    const t = setup();
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    const d = await t.svc.saveDraft(sessionId, draft({ to: [{ email: "undone@x.test" }] }));
    const sent = await t.svc.send(sessionId, d.id, "i1");
    await t.svc.undoSend(sessionId, sent.submissionId);
    await t.afterHold(false);
    expect((await t.svc.contacts(sessionId)).contacts).toEqual([]);

    const d2 = await t.svc.saveDraft(sessionId, draft({ to: [{ email: "slow@x.test" }] }));
    await t.svc.send(sessionId, d2.id, "i1");
    await t.afterHold(false); // Still pending: try again in 5 s.
    expect(t.deferred.map((x) => x.ms)).toEqual([5000]);
    await t.afterHold();
    expect((await t.svc.contacts(sessionId)).contacts.map((c) => c.emails[0]?.address)).toEqual(["slow@x.test"]);
  });

  it("saves to the account that sent, even after switching mailbox during the hold", async () => {
    const t = setup();
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    const d = await t.svc.saveDraft(sessionId, draft({ to: [{ email: "fresh@x.test" }] }));
    await t.svc.send(sessionId, d.id, "i1");
    // Another tab adds (and switches to) a second mailbox before the hold is over.
    await t.svc.addMailbox(sessionId, "b@x.test", "right");
    expect((await t.svc.mailboxes(sessionId))?.active).toBe("b@x.test");
    await t.afterHold();
    expect(t.state.calls.filter((c) => c.startsWith("cards@"))).toEqual(["cards@acc-a@x.test"]);
    expect(
      [...t.state.cards.values()].map(
        (c) => Object.values(c.emails as Record<string, { address: string }>)[0]?.address,
      ),
    ).toEqual(["fresh@x.test"]);
  });

  it("respects the setting and the cap, and a failing contacts store never fails the send", async () => {
    const t = setup();
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    await t.svc.setAutoSave(sessionId, ACC, false);
    expect((await t.svc.contacts(sessionId)).autoSave).toBe(false);
    const d = await t.svc.saveDraft(sessionId, draft({ to: [{ email: "someone@x.test" }] }));
    await t.svc.send(sessionId, d.id, "i1");
    await t.afterHold();
    expect((await t.svc.contacts(sessionId)).contacts).toEqual([]);

    await t.svc.setAutoSave(sessionId, ACC, true);
    cards(t, 5000);
    const full = await t.svc.saveDraft(sessionId, draft({ to: [{ email: "over@x.test" }] }));
    await t.svc.send(sessionId, full.id, "i1");
    await t.afterHold();
    expect(t.state.cards.size).toBe(5000);
    t.state.cards.clear();

    t.state.failContacts = true; // The contacts store errors: the message still goes out.
    const d2 = await t.svc.saveDraft(sessionId, draft({ to: [{ email: "x2@x.test" }] }));
    await expect(t.svc.send(sessionId, d2.id, "i1")).resolves.toMatchObject({
      submissionId: expect.any(String) as unknown,
    });
    await t.afterHold();
    expect(t.state.calls.filter((c) => c.startsWith("submit"))).toHaveLength(3);
  });
});
