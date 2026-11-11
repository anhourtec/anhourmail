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
  draftBody,
  draftEmail,
  draftProblem,
  delegatedLimits,
  MAX_RECIPIENTS,
  sendCheck,
  SHAPE_LIMITS,
  tierLimits,
  senderName,
  type StoredDraft,
  UNDO_SECONDS,
  uploadType,
} from "./compose";
import { MAX_OUTGOING_HTML } from "./outgoing-html";
import {
  GrantRefusedError,
  WebmailBlockedError,
  WebmailNotFoundError,
  WebmailQuotaError,
  WebmailRefusedError,
  WebmailBillingRestrictedError,
  WebmailSendingRefusedError,
  WebmailService,
  type WebmailTrust,
  WebmailSignInError,
  WebmailUnavailableError,
} from "./service";
import { memoryKv, WebmailSessionStore } from "./session-store";
import { fixedTrust } from "./__tests__/trust";

beforeEach(() => {
  setLogSinkForTests(() => undefined);
});
afterEach(() => {
  setLogSinkForTests(null);
});

const MAIL = "urn:ietf:params:jmap:mail";
const identity = { id: "i1", name: "Alex", email: "a@x.test" };

describe("tier limits", () => {
  it("are the published numbers of the tier; a delegated send takes the stricter of two, field by field", () => {
    for (const t of ["new", "standard", "trusted", "restricted"] as const)
      expect(tierLimits(t)).toEqual(TRUST_TIERS[t].limits);
    expect(delegatedLimits("standard", "new")).toEqual(TRUST_TIERS.new.limits);
    expect(delegatedLimits("new", "standard")).toEqual(TRUST_TIERS.new.limits);
    expect(delegatedLimits("standard", "restricted").messagesPerDay).toBe(0);
  });

  it("shape limits pause nothing and cap recipients at the input ceiling", () => {
    expect(SHAPE_LIMITS.recipientsPerMessage).toBe(MAX_RECIPIENTS);
    expect(SHAPE_LIMITS.messagesPerDay).toBeGreaterThan(0);
    expect(SHAPE_LIMITS.messagesPerHour).toBeGreaterThan(0);
  });
});

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

  it("never writes an empty Cc, Bcc or To header", () => {
    const e = draftEmail(DraftInput.parse({ ...base, to: [{ email: "s@x.test" }] }), identity, "drafts");
    expect(e).not.toHaveProperty("cc");
    expect(e).not.toHaveProperty("bcc");
    expect(e).not.toHaveProperty("replyTo");
    expect(draftEmail(DraftInput.parse(base), identity, "drafts")).not.toHaveProperty("to");
    const all = draftEmail(
      DraftInput.parse({
        ...base,
        to: [{ email: "s@x.test" }],
        cc: [{ email: "c@x.test" }],
        bcc: [{ email: "b@x.test" }],
      }),
      identity,
      "drafts",
    );
    expect(all).toMatchObject({ cc: [{ email: "c@x.test" }], bcc: [{ email: "b@x.test" }] });
  });

  it("sends HTML as multipart/alternative, re-sanitised, with a generated text part", () => {
    const e = draftEmail(
      DraftInput.parse({
        ...base,
        text: "",
        html: '<p onclick="x">Hi <b>there</b> <a href="javascript:alert(1)">x</a></p><script>alert(1)</script>',
      }),
      identity,
      "drafts",
    );
    expect(e).toMatchObject({
      bodyValues: {
        body: { value: "Hi there x" },
        html: { value: '<p>Hi <b>there</b> <a target="_blank" rel="noopener noreferrer">x</a></p>' },
      },
      textBody: [{ partId: "body", type: "text/plain" }],
      htmlBody: [{ partId: "html", type: "text/html" }],
    });
  });

  it("keeps the person's own text part next to the HTML", () => {
    expect(draftBody({ text: "Mine", html: "<p>Rich</p>" })).toMatchObject({
      bodyValues: { body: { value: "Mine" }, html: { value: "<p>Rich</p>" } },
    });
  });

  it("falls back to plain text when the HTML sanitises to nothing", () => {
    expect(draftBody({ text: "Plain", html: "<script>alert(1)</script>" })).toEqual({
      bodyValues: { body: { value: "Plain" } },
      textBody: [{ partId: "body", type: "text/plain" }],
    });
    expect(draftBody({ text: "Plain" })).not.toHaveProperty("htmlBody");
  });

  it("refuses HTML over the cap", () => {
    expect(DraftInput.safeParse({ ...base, html: "a".repeat(MAX_OUTGOING_HTML + 1) }).success).toBe(false);
  });

  it("puts the sender's display name in From, and none when it is blank", () => {
    expect(senderName({ id: "i", name: "  Alex Doe ", email: "a@x.test" })).toBe("Alex Doe");
    expect(senderName({ id: "i", name: "", email: "a@x.test" })).toBeNull();
    expect(senderName({ id: "i", name: "   ", email: "a@x.test" })).toBeNull();
    expect(senderName({ id: "i", name: "A@X.test", email: "a@x.test" })).toBeNull();
    expect(senderName({ id: "i", name: 'Alex "<x>"\r\nBcc: y', email: "a@x.test" })).not.toMatch(/[\r\n"<>]/);
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
    submissions: new Map<
      string,
      { emailId: string; undoStatus: string; deliveryStatus?: Record<string, { delivered: string; smtpReply: string }> }
    >(),
    /** Addresses the mail server refuses at RCPT (an unknown address on one of its own domains). */
    unknownAddresses: new Set<string>(),
    /** Answer `EmailSubmission/get` with a method error (the delivery report can't be read). */
    failSubmissionGet: false,
    seq: 0,
    calls: [] as string[],
    uploads: [] as { type: string | null; size: number }[],
    refuseSubmission: false,
    books: new Map<string, { id: string; name: string; isDefault: boolean; description: string | null }>([
      ["b", { id: "b", name: "Stalwart Address Book", isDefault: true, description: null }],
    ]),
    cards: new Map<string, Record<string, unknown> & { id: string }>(),
    failContacts: false,
    /** `ContactCard/set` calls answered before the next ones fail (null: never). */
    contactSetsLeft: null as number | null,
    /** Every `Identity/set` update the service sent (the names it renamed identities to). */
    identityUpdates: [] as Record<string, unknown>[],
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
      if (state.contactSetsLeft !== null && state.contactSetsLeft-- <= 0) return undefined;
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
        // Like the server: a key with `/` is a JSON pointer into the card (RFC 8620 §5.3 PatchObject).
        for (const [path, value] of Object.entries(patch)) {
          const parts = path.split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
          const last = parts.pop() ?? "";
          let at: Record<string, unknown> = c;
          for (const part of parts) at = at[part] as Record<string, unknown>;
          at[last] = value;
        }
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
    "Identity/set": (a) => {
      const update = a.update as Record<string, unknown>;
      state.identityUpdates.push(update);
      return { updated: Object.fromEntries(Object.keys(update).map((id) => [id, null])) };
    },
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
        const create = (
          a.create as Record<string, { emailId: string; envelope: { rcptTo: { email: string }[] } | undefined }>
        ).send;
        const id = `s${String(++state.seq)}`;
        // Like the server: RCPT is checked while the message is held; nothing accepted means nothing to hold.
        const deliveryStatus = Object.fromEntries(
          (create?.envelope?.rcptTo ?? []).map(({ email }) => [
            email,
            state.unknownAddresses.has(email)
              ? { delivered: "no", smtpReply: "550 5.1.2 Mailbox does not exist." }
              : { delivered: "queued", smtpReply: "250 2.1.5 Queued" },
          ]),
        );
        const accepted = Object.values(deliveryStatus).some((d) => d.delivered !== "no");
        state.submissions.set(id, {
          emailId: create?.emailId ?? "",
          undoStatus: accepted ? "pending" : "final",
          deliveryStatus,
        });
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
    "EmailSubmission/get": (a) => {
      if (state.failSubmissionGet) return undefined;
      return {
        list: (a.ids as string[]).flatMap((id) => {
          const s = state.submissions.get(id);
          return s ? [{ id, ...s }] : [];
        }),
      };
    },
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
      const answer = h?.(args);
      return answer !== undefined ? [name, answer, id] : ["error", { type: "unknownMethod" }, id];
    });
    return Response.json({ methodResponses });
  }) as typeof fetch;
  return { state, fetchImpl };
}

function setup(
  allowed: (a: string) => boolean = () => true,
  quota: SlidingQuotaStore = memorySlidingQuota(),
  holdSeconds?: (address: string) => Promise<number>,
  senderName?: (address: string) => Promise<{ name: string | null; masked?: readonly string[] } | null>,
  trust: WebmailTrust = fixedTrust(),
) {
  const fake = fakeStalwart();
  const deferred: { fn: () => void; ms: number }[] = [];
  /** Every wait the service asked for (answered at once). */
  const sleeps: number[] = [];
  /** Lets held submissions go out (or not), then runs what the service deferred and waits for it. */
  const afterHold = async (release = true) => {
    if (release)
      for (const sub of fake.state.submissions.values()) {
        if (sub.undoStatus !== "pending") continue;
        sub.undoStatus = "final";
        // Handed on: accepted recipients are no longer "queued" here.
        for (const d of Object.values(sub.deliveryStatus ?? {})) if (d.delivered === "queued") d.delivered = "unknown";
      }
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
    access: { state: async (a) => (allowed(a) ? "ok" : "suspended") },
    quota,
    trust,
    sieve: { read: async () => null, write: async () => true },
    confirmedForward: async () => null,
    fetch: fake.fetchImpl,
    defer: (fn, ms) => {
      deferred.push({ fn, ms });
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...(holdSeconds ? { holdSeconds } : {}),
    ...(senderName ? { senderName } : {}),
  });
  return { svc, deferred, afterHold, sleeps, ...fake };
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

  it("refuses a send billing stops (restricted account or held mailbox) before anything is submitted or charged", async () => {
    let block: "restricted" | "held" | null | Error = "restricted";
    const asked: string[] = [];
    const quota = memorySlidingQuota();
    const t = setup(undefined, quota, undefined, undefined, {
      ...fixedTrust(),
      standing: async (address) => {
        asked.push(address);
        if (block instanceof Error) throw block;
        return { tier: "standard", billingBlock: block, heldOnServer: false };
      },
    });
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    const d = await t.svc.saveDraft(sessionId, draft());
    await expect(t.svc.send(sessionId, d.id, "i1")).rejects.toMatchObject({
      name: "WebmailBillingRestrictedError",
      reason: "restricted",
    });
    block = "held";
    await expect(t.svc.send(sessionId, d.id, "i1")).rejects.toBeInstanceOf(WebmailBillingRestrictedError);
    // The check can't be made: refused too (fail closed, rule 27).
    block = new Error("db down");
    await expect(t.svc.send(sessionId, d.id, "i1")).rejects.toBeInstanceOf(WebmailUnavailableError);
    expect(t.state.calls.some((c) => c.startsWith("submit "))).toBe(false);
    expect(asked).toEqual(["a@x.test", "a@x.test", "a@x.test"]);
    // Paid again: the same draft goes.
    block = null;
    await t.svc.send(sessionId, d.id, "i1");
    expect(t.state.calls.some((c) => c.startsWith("submit "))).toBe(true);
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

  it("names a masked alias with no name and sends from it with none; the address and plain aliases get the name", async () => {
    // hello@ is one of the mailbox's masked aliases in the control plane (any case).
    const names = async (address: string) =>
      address === "a@x.test" ? { name: "Ada Lovelace", masked: ["HELLO@x.test"] } : null;
    const t = setup(undefined, undefined, undefined, names);
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    expect((await t.svc.identities(sessionId)).map((i) => [i.email, i.name])).toEqual([
      ["a@x.test", "Ada Lovelace"],
      ["hello@x.test", ""],
    ]);
    // Renamed on the mail server: the address to the sender name, the masked alias to no name (it was its address).
    expect(t.state.identityUpdates).toEqual([{ i1: { name: "Ada Lovelace" }, i2: { name: "" } }]);
    const masked = await t.svc.saveDraft(sessionId, draft({ identityId: "i2" }));
    expect(t.state.emails.get(masked.id)?.from).toEqual([{ name: null, email: "hello@x.test" }]);
    await t.svc.send(sessionId, masked.id, "i2");
    expect(t.state.emails.get(masked.id)?.from).toEqual([{ name: null, email: "hello@x.test" }]);
    const own = await t.svc.saveDraft(sessionId, draft());
    expect(t.state.emails.get(own.id)?.from).toEqual([{ name: "Ada Lovelace", email: "a@x.test" }]);
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
    expect(await t.svc.mailboxes(sessionId)).toEqual({
      active: "b@x.test",
      activeShared: false,
      others: ["a@x.test"],
      shared: [],
    });
    expect((await t.svc.session(sessionId))?.accountId).toBe("acc-b@x.test");
    await t.svc.switchMailbox(sessionId, "a@x.test");
    expect(await t.svc.mailboxes(sessionId)).toEqual({
      active: "a@x.test",
      activeShared: false,
      others: ["b@x.test"],
      shared: [],
    });
    expect((await t.svc.session(sessionId))?.accessToken).toBe("at-a@x.test");
    // Re-adding one already there renews it instead of duplicating.
    await t.svc.addMailbox(sessionId, "b@x.test", "right");
    expect(await t.svc.mailboxes(sessionId)).toEqual({
      active: "b@x.test",
      activeShared: false,
      others: ["a@x.test"],
      shared: [],
    });
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

describe("delivery problems after a send", () => {
  const nobody = "nobody@x.test";
  const noMailbox = { email: nobody, code: "5.1.2", reason: "No mailbox with this address exists." };

  it("reports nothing when every recipient was accepted, before and after the hold", async () => {
    const t = setup();
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    const a = "acc-a@x.test";
    const d = await t.svc.saveDraft(sessionId, draft(), a);
    const sent = await t.svc.send(sessionId, d.id, "i1", a);
    expect(sent).toMatchObject({ undelivered: [], held: true });
    await t.afterHold();
    await expect(t.svc.deliveryReportOf(sessionId, sent.submissionId, a)).resolves.toEqual({
      undelivered: [],
      settled: true,
      held: false,
    });
    expect(t.sleeps).toEqual([]);
  });

  it("names an unknown address at once, keeps the others held for undo, and the copy in Sent", async () => {
    const t = setup();
    t.state.unknownAddresses.add(nobody);
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    const a = "acc-a@x.test";
    const d = await t.svc.saveDraft(sessionId, draft({ to: [{ email: "s@x.test" }, { email: nobody }] }), a);
    const sent = await t.svc.send(sessionId, d.id, "i1", a);
    // Partly refused: the accepted recipient is still held, so undo still works.
    expect(sent.undelivered).toEqual([noMailbox]);
    expect(sent.held).toBe(true);
    expect(t.state.emails.get(d.id)?.mailboxIds).toEqual({ sent: true });
    await t.afterHold();
    const after = await t.svc.deliveryReportOf(sessionId, sent.submissionId, a);
    expect(after).toEqual({ undelivered: [noMailbox], settled: true, held: false });
  });

  it("says nothing was held when every recipient was refused (nothing to undo)", async () => {
    const t = setup();
    t.state.unknownAddresses.add(nobody);
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    const d = await t.svc.saveDraft(sessionId, draft({ to: [{ email: nobody }] }));
    const sent = await t.svc.send(sessionId, d.id, "i1");
    expect(sent).toMatchObject({ undelivered: [noMailbox], held: false });
    // The message was submitted: it stays in Sent, nothing destructive happens.
    expect(t.state.emails.get(d.id)?.mailboxIds).toEqual({ sent: true });
  });

  it("still answers the send when the report can't be read, and the check after the hold says unavailable", async () => {
    const t = setup();
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    const d = await t.svc.saveDraft(sessionId, draft());
    t.state.failSubmissionGet = true;
    const sent = await t.svc.send(sessionId, d.id, "i1");
    expect(sent).toMatchObject({ undelivered: [], held: true });
    await expect(t.svc.deliveryReportOf(sessionId, sent.submissionId, "acc-a@x.test")).rejects.toBeInstanceOf(
      WebmailUnavailableError,
    );
    // Re-checked within the bound, then gave up: never more than about 3 s.
    expect(t.sleeps.reduce((x, y) => x + y, 0)).toBeLessThanOrEqual(3000);
  });

  it("re-checks a report that hasn't settled for about 3 s at most, then answers what it has", async () => {
    const t = setup();
    t.state.unknownAddresses.add(nobody);
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    const a = "acc-a@x.test";
    const d = await t.svc.saveDraft(sessionId, draft({ to: [{ email: "s@x.test" }, { email: nobody }] }), a);
    const sent = await t.svc.send(sessionId, d.id, "i1", a);
    // Still held (a long undo delay, or the server hasn't handed it on): the bounded re-check runs out.
    const report = await t.svc.deliveryReportOf(sessionId, sent.submissionId, a);
    expect(report).toEqual({ undelivered: [noMailbox], settled: false, held: true });
    expect(t.sleeps).toEqual([750, 750, 1500]);
  });

  it("is a 404 for a submission this mailbox doesn't have, and refused for a mailbox not signed in here", async () => {
    const t = setup();
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    await expect(t.svc.deliveryReportOf(sessionId, "s999", "acc-a@x.test")).rejects.toBeInstanceOf(
      WebmailNotFoundError,
    );
    // Another person's mailbox (their account id) isn't one of this session's: refused, never read.
    const before = t.state.calls.length;
    await expect(t.svc.deliveryReportOf(sessionId, "s1", "acc-b@x.test")).rejects.toBeInstanceOf(WebmailRefusedError);
    expect(t.state.calls.slice(before)).not.toContain("EmailSubmission/get");
  });

  it("reads a send of a mailbox the session has switched away from with that mailbox's own token", async () => {
    const t = setup();
    t.state.unknownAddresses.add(nobody);
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    const a = "acc-a@x.test";
    const d = await t.svc.saveDraft(sessionId, draft({ to: [{ email: "s@x.test" }, { email: nobody }] }), a);
    const sent = await t.svc.send(sessionId, d.id, "i1", a);
    await t.svc.addMailbox(sessionId, "b@x.test", "right");
    await t.afterHold();
    await expect(t.svc.deliveryReportOf(sessionId, sent.submissionId, a)).resolves.toMatchObject({
      undelivered: [noMailbox],
    });
  });

  it("never logs the recipients of a refused send", async () => {
    const lines: string[] = [];
    setLogSinkForTests((l) => {
      lines.push(l);
    });
    const t = setup();
    t.state.unknownAddresses.add(nobody);
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    const d = await t.svc.saveDraft(sessionId, draft({ to: [{ email: nobody }] }));
    t.state.failSubmissionGet = true;
    await t.svc.send(sessionId, d.id, "i1");
    t.state.failSubmissionGet = false;
    await t.svc.deliveryReportOf(sessionId, "s999", "acc-a@x.test").catch(() => undefined);
    expect(lines.join("\n")).not.toContain("nobody");
    expect(lines.join("\n")).not.toContain("5.1.2");
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
    // A new account writing to addresses we host (x.test): held to nothing, limited by the new tier's numbers.
    const t = setup(undefined, undefined, undefined, undefined, fixedTrust("new", ["x.test"]));
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

  it("standard: the standard tier's numbers apply, and outside recipients are fine", async () => {
    const t = setup(undefined, undefined, undefined, undefined, fixedTrust("standard", ["x.test"]));
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    const d = await t.svc.saveDraft(sessionId, draft({ to: [{ email: "friend@outside.example" }] }));
    await expect(t.svc.send(sessionId, d.id, "i1")).resolves.toMatchObject({
      submissionId: expect.any(String) as unknown,
    });
    // 51 recipients: within the input ceiling (the trusted tier's 100), over standard's 50.
    const over = TRUST_TIERS.standard.limits.recipientsPerMessage + 1;
    expect(over).toBeLessThanOrEqual(MAX_RECIPIENTS);
    const big = await t.svc.saveDraft(sessionId, draft({ to: to(over, "z") }));
    await expect(t.svc.send(sessionId, big.id, "i1")).rejects.toThrow(/at most 50/);
  });

  it("standard but not yet applied on the mail server: outside recipients are held until its ensure has run", async () => {
    const trust = fixedTrust("standard", ["x.test"], true);
    const t = setup(undefined, undefined, undefined, undefined, trust);
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    const out = await t.svc.saveDraft(sessionId, draft({ to: [{ email: "friend@outside.example" }] }));
    await expect(t.svc.send(sessionId, out.id, "i1")).rejects.toMatchObject({ reason: "held" });
    expect(trust.recorded).toEqual([{ address: "a@x.test", externalRecipients: 1 }]);
    // Hosted recipients go, with the standard tier's numbers.
    const hosted = await t.svc.saveDraft(
      sessionId,
      draft({ to: to(TRUST_TIERS.new.limits.recipientsPerMessage + 1, "s") }),
    );
    await expect(t.svc.send(sessionId, hosted.id, "i1")).resolves.toMatchObject({
      submissionId: expect.any(String) as unknown,
    });
  });

  it("new: a send with any recipient outside is held (403 sending_held), recorded with a count, nothing charged", async () => {
    const trust = fixedTrust("new", ["x.test"]);
    const quota = memorySlidingQuota();
    const t = setup(undefined, quota, undefined, undefined, trust);
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    const d = await t.svc.saveDraft(
      sessionId,
      draft({
        to: [{ email: "s@x.test" }],
        cc: [{ email: "One@Outside.example" }],
        bcc: [{ email: "two@else.example" }],
      }),
    );
    const refused = await t.svc.send(sessionId, d.id, "i1").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(WebmailSendingRefusedError);
    expect(refused).toMatchObject({
      reason: "held",
      message: expect.stringMatching(/^New accounts can send/) as unknown,
    });
    expect(trust.recorded).toEqual([{ address: "a@x.test", externalRecipients: 2 }]);
    expect(JSON.stringify(trust.recorded)).not.toContain("outside.example");
    expect(t.state.calls.some((c) => c.startsWith("submit "))).toBe(false);
    // Nothing was charged: the hour's whole allowance is still there for hosted recipients.
    const hosted = await t.svc.saveDraft(
      sessionId,
      draft({ to: to(TRUST_TIERS.new.limits.recipientsPerMessage, "h") }),
    );
    await expect(t.svc.send(sessionId, hosted.id, "i1")).resolves.toMatchObject({
      submissionId: expect.any(String) as unknown,
    });
  });

  it("restricted: refused before the draft is read (403 sending_paused); an address we don't hold reads restricted", async () => {
    for (const trust of [fixedTrust("restricted"), { ...fixedTrust(), standing: async () => null }]) {
      const t = setup(undefined, undefined, undefined, undefined, trust);
      const { sessionId } = await t.svc.signIn("a@x.test", "right");
      const d = await t.svc.saveDraft(sessionId, draft());
      await expect(t.svc.send(sessionId, d.id, "i1")).rejects.toMatchObject({
        name: "WebmailSendingRefusedError",
        reason: "paused",
      });
      expect(t.state.calls.some((c) => c.startsWith("submit "))).toBe(false);
    }
  });

  it("fails closed when the tier or the hosted-domain check can't be read (503)", async () => {
    const down = () => Promise.reject(new Error("db down"));
    for (const trust of [
      { ...fixedTrust(), standing: down },
      { ...fixedTrust("new", ["x.test"]), outside: down },
    ]) {
      const t = setup(undefined, undefined, undefined, undefined, trust);
      const { sessionId } = await t.svc.signIn("a@x.test", "right");
      const d = await t.svc.saveDraft(sessionId, draft({ to: [{ email: "s@x.test" }] }));
      await expect(t.svc.send(sessionId, d.id, "i1")).rejects.toBeInstanceOf(WebmailUnavailableError);
      expect(t.state.calls.some((c) => c.startsWith("submit "))).toBe(false);
    }
  });

  it("a held send whose record fails is still refused", async () => {
    const trust = { ...fixedTrust("new", ["x.test"]), held: () => Promise.reject(new Error("audit down")) };
    const t = setup(undefined, undefined, undefined, undefined, trust);
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    const d = await t.svc.saveDraft(sessionId, draft({ to: [{ email: "x@outside.example" }] }));
    await expect(t.svc.send(sessionId, d.id, "i1")).rejects.toBeInstanceOf(WebmailSendingRefusedError);
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
      access: { state: async () => "ok" as const },
      quota: memorySlidingQuota(),
      trust: fixedTrust(),
      sieve: { read: async () => null, write: async () => true },
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
  const vcard = (text: string) => ({ format: "vcard" as const, bytes: new TextEncoder().encode(text) });
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
      vcard("BEGIN:VCARD\nFN:Jo\nEMAIL:jo@x.test\nEND:VCARD\nBEGIN:VCARD\nEND:VCARD\n"),
    );
    expect(imported).toEqual({ created: 1, merged: 0, duplicates: 0, invalid: 1, overCap: 0 });
    expect(await t.svc.exportContacts(sessionId)).toContain("EMAIL:jo@x.test");
    expect(await t.svc.importContacts(sessionId, ACC, vcard("nothing here"))).toEqual({
      created: 0,
      merged: 0,
      duplicates: 0,
      invalid: 0,
      overCap: 0,
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
      t.svc.importContacts(sessionId, other, vcard("BEGIN:VCARD\nFN:Jo\nEND:VCARD\n")),
    ];
    for (const p of refused) await expect(p).rejects.toBeInstanceOf(WebmailRefusedError);
    expect((await t.svc.contacts(sessionId)).contacts.map((c) => c.name)).toEqual(["Sam Rivera"]);
  });

  it("keeps a mailbox to 5,000 contacts, and says when the list is cut", async () => {
    const t = setup();
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    cards(t, 4999);
    expect(
      await t.svc.importContacts(sessionId, ACC, vcard("BEGIN:VCARD\nFN:A\nEND:VCARD\nBEGIN:VCARD\nFN:B\nEND:VCARD\n")),
    ).toMatchObject({ created: 1, overCap: 1 });
    await expect(t.svc.createContact(sessionId, ACC, contact())).rejects.toThrow(/up to 5,000 contacts/);
    const list = await t.svc.contacts(sessionId);
    expect([list.contacts.length, list.truncated]).toEqual([5000, false]);
    t.state.cards.set("extra", { id: "extra", name: { full: "Extra" }, addressBookIds: { b: true } });
    expect((await t.svc.contacts(sessionId)).truncated).toBe(true);
  });

  it("imports a CSV with the submitted mapping, merging by email and filling only what's empty", async () => {
    const t = setup();
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    await t.svc.createContact(sessionId, ACC, contact({ organization: "Kept Co" }));
    const done: { address: string; counts: unknown }[] = [];
    const csv = [
      "First Name;Last Name;E-mail Address;Company;Notes;Middle Name",
      "Samuel;R;S@X.test;New Co;Met on the trail;Q",
      "Ana;Diaz;ana@x.test;;;",
      "Ana;Diaz;ANA@x.test;;;",
      "No;Identity;not-an-address;;;",
    ].join("\r\n");
    const counts = await t.svc.importContacts(
      sessionId,
      ACC,
      {
        format: "csv",
        bytes: new TextEncoder().encode(csv),
        columns: ["given", "surname", "emails", "organization", "notes", null],
      },
      async (address, c) => {
        done.push({ address, counts: c });
      },
    );
    expect(counts).toEqual({ created: 1, merged: 1, duplicates: 1, invalid: 1, overCap: 0 });
    expect(done).toEqual([{ address: "a@x.test", counts }]);
    const list = (await t.svc.contacts(sessionId)).contacts;
    const sam = list.find((c) => c.emails.some((e) => e.address === "s@x.test"));
    // Never overwritten: Sam keeps his name and company; the empty notes are filled.
    expect(sam).toMatchObject({ given: "Sam", surname: "Rivera", organization: "Kept Co", notes: "Met on the trail" });
    expect(list.map((c) => c.name).sort()).toEqual(["Ana Diaz", "Sam Rivera"]);
  });

  it("refuses a file it can't read, a mapping that doesn't fit and a vCard over the card limit, writing nothing", async () => {
    const t = setup();
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    const done: unknown[] = [];
    const onDone = async (_a: string, c: unknown) => {
      done.push(c);
    };
    const latin1 = new Uint8Array([0x4e, 0x0a, 0x43, 0x61, 0x66, 0xe9]);
    await expect(
      t.svc.importContacts(sessionId, ACC, { format: "csv", bytes: latin1, columns: ["fullName"] }, onDone),
    ).rejects.toThrow(/Save it as UTF-8/);
    await expect(
      t.svc.importContacts(
        sessionId,
        ACC,
        { format: "csv", bytes: new TextEncoder().encode("A,B\r\n1,2\r\n"), columns: ["fullName"] },
        onDone,
      ),
    ).rejects.toThrow(/don't match this file/);
    await expect(
      t.svc.importContacts(sessionId, ACC, vcard("BEGIN:VCARD\nFN:x\nEND:VCARD\n".repeat(5001)), onDone),
    ).rejects.toThrow(/up to 5,000 contacts/);
    expect(done).toEqual([]);
    expect(t.state.cards.size).toBe(0);
  });

  it("writes in batches of 100 and still reports what was written when the mail server stops part-way", async () => {
    const t = setup();
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    const many = Array.from({ length: 250 }, (_, i) => `BEGIN:VCARD\nFN:P${String(i)}\nEND:VCARD\n`).join("");
    const sets = () => t.state.calls.filter((c) => c === "ContactCard/set").length;
    const before = sets();
    expect(await t.svc.importContacts(sessionId, ACC, vcard(many))).toMatchObject({ created: 250 });
    expect(sets() - before).toBe(3);

    const t2 = setup();
    const s2 = (await t2.svc.signIn("a@x.test", "right")).sessionId;
    t2.state.contactSetsLeft = 1;
    const done: unknown[] = [];
    await expect(
      t2.svc.importContacts(s2, ACC, vcard(many), async (_a, c) => {
        done.push(c);
      }),
    ).rejects.toBeInstanceOf(WebmailUnavailableError);
    expect(done).toEqual([{ created: 100, merged: 0, duplicates: 0, invalid: 0, overCap: 0 }]);
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
