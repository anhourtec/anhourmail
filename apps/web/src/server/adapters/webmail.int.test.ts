// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Webmail BFF against the real dev Stalwart (`npm run test:int`): the headless OAuth sign-in with a demo mailbox,
 * a proxied `Mailbox/get`, and the refusals. The demo password is read from the local credentials.md
 * (`npm run db:seed -- --demo`) and never printed.
 */
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashPassword } from "@anhourmail/adapters/auth";
import { createDb, pgMailboxStatusLookup } from "@anhourmail/adapters/postgres";
import { createKeyRing } from "@anhourmail/server/keyring";
import { runWithRequestContext } from "@anhourmail/server/request-context";
import { memorySlidingQuota } from "@anhourmail/server/rate-limit";
import { stalwartDevAdmin } from "@anhourmail/stalwart-client";

import { demoPassword } from "../../../../../tests/support/demo-credentials";
import { ContactInput } from "../webmail/contacts";
import { memoryKv, WebmailSessionStore } from "../webmail/session-store";
import { WebmailBusyError, WebmailService, WebmailSignInError } from "../webmail/service";
import { stalwartOAuthPort } from "./stalwart-oauth";

const STALWART_URL = process.env.STALWART_URL ?? "http://127.0.0.1:43080";
const WEBMAIL_URL = process.env.WEBMAIL_URL ?? "http://localhost:43300";
const OWNER = "owner@demo-family.test";
/**
 * A recipient mailbox of its own per run (on the dev-only `dev.test` domain, removed afterwards). Stalwart throttles
 * mail per sender domain and recipient (its default inbound "Sender address to recipient throttle", 25 an hour —
 * rule 27, left as is), so sending to a shared demo mailbox runs out after a few runs of these tests and the e2e
 * journeys; a fresh recipient gets a fresh allowance and the delivery and undo assertions stay strict.
 */
const RECIPIENT_NAME = `int-rcpt-${randomBytes(4).toString("hex")}`;
const RECIPIENT = `${RECIPIENT_NAME}@dev.test`;
const RECIPIENT_PASSWORD = randomBytes(18).toString("base64url");
let recipientId: string | null = null;
const MAILPIT = `http://localhost:${process.env.MAILPIT_UI_PORT ?? "43026"}`;

/**
 * A documentation-range client address (RFC 5737), random per run. Deliberate wrong passwords run as such a client
 * so Stalwart counts (and may ban) that address — never the shared loopback identity or the dev forwarder.
 */
const testIp = () =>
  `${Math.random() < 0.5 ? "198.51.100" : "203.0.113"}.${String(1 + Math.floor(Math.random() * 254))}`;
const isTestIp = (a: string) => /^(198\.51\.100|203\.0\.113)\./.test(a);
/** Runs `fn` as a request from `ip` (the OAuth adapter forwards it to Stalwart as X-Forwarded-For). */
const asClient = <T>(ip: string, fn: () => Promise<T>): Promise<T> =>
  runWithRequestContext({ requestId: `int-${ip}`, clientIp: ip }, fn);

type Blocked = { id: string; address: string };
const blocked = () => stalwartDevAdmin().transport.getAll<Blocked>("x:BlockedIp", ["address"]);
/** Bans that existed before this file ran: everything else a test address got is removed afterwards. */
let bansBefore = new Set<string>();
beforeAll(async () => {
  recipientId = await stalwartDevAdmin().upsertUser({
    name: RECIPIENT_NAME,
    domain: "dev.test",
    password: await hashPassword(RECIPIENT_PASSWORD),
    quotaBytes: 50 * 1024 * 1024,
  });
  bansBefore = new Set((await blocked()).map((b) => b.id));
});
afterAll(async () => {
  if (recipientId) await stalwartDevAdmin().destroy("x:Account", recipientId);
  // Stalwart bans an address failing on an account that just took many failures at once, so even a single
  // deliberate wrong password can leave a ban. Remove the ones this file's test addresses got (documentation
  // range only), so a later run picking the same address isn't refused.
  const ours = (await blocked()).filter((b) => !bansBefore.has(b.id) && isTestIp(b.address));
  if (ours.length > 0) {
    await stalwartDevAdmin().transport.set("x:BlockedIp", { destroy: ours.map((b) => b.id) });
    await stalwartDevAdmin().transport.call([
      ["x:Action/set", { create: { r: { "@type": "ReloadBlockedIps" } } }, "r"],
    ]);
  }
});

/** `autoSave`: let sends save recipients to Other contacts after the hold (only the contacts test wants that). */
function service(autoSave = false) {
  return new WebmailService({
    store: new WebmailSessionStore(memoryKv(), createKeyRing([{ id: "t", key: randomBytes(32) }])),
    oauth: stalwartOAuthPort({ stalwartUrl: STALWART_URL, webmailUrl: WEBMAIL_URL }),
    stalwartUrl: STALWART_URL,
    access: { state: async () => "ok" as const },
    quota: memorySlidingQuota(),
    sieve: { read: async () => null, write: async () => undefined },
    confirmedForward: async () => null,
    ...(autoSave ? {} : { defer: () => undefined }),
  });
}

/** Sending saves recipients to Other contacts: remove what these tests add, so the demo address book stays tidy. */
afterAll(async () => {
  const svc = service();
  const { sessionId } = await svc.signIn(OWNER, demoPassword(OWNER));
  const { contacts, accountId } = await svc.contacts(sessionId);
  const ours = contacts.filter((c) =>
    c.emails.some((e) => /^(outside|int-contact|int-new|int-known)-/.test(e.address)),
  );
  if (ours.length > 0)
    await svc.deleteContacts(
      sessionId,
      accountId,
      ours.map((c) => c.id),
    );
});

describe("webmail BFF on the dev Stalwart", () => {
  it("signs in with the mailbox password and proxies Mailbox/get with the server-held token", async () => {
    const svc = service();
    const { sessionId, session } = await svc.signIn(OWNER, demoPassword(OWNER));
    expect(session.username).toBe(OWNER);
    const res = await svc.jmap(sessionId, {
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [["Mailbox/get", { accountId: session.accountId, properties: ["name", "role"] }, "m"]],
    });
    expect(res.status).toBe(200);
    const first = (res.body as { methodResponses: [string, { list: { role: string | null }[] }, string][] })
      .methodResponses[0];
    expect(first?.[0]).toBe("Mailbox/get");
    expect(first?.[1].list.map((m) => m.role)).toEqual(expect.arrayContaining(["inbox", "sent", "trash"]));
    await svc.signOut(sessionId);
    expect(await svc.session(sessionId)).toBeNull();
  });

  it("sends to another mailbox: draft, held submission, delivery", async () => {
    const tag = randomBytes(5).toString("hex");
    const owner = service();
    const { sessionId } = await owner.signIn(OWNER, demoPassword(OWNER));
    const identity = (await owner.identities(sessionId)).find((i) => i.email === OWNER);
    if (!identity) throw new Error("owner identity missing");
    const draft = await owner.saveDraft(sessionId, {
      identityId: identity.id,
      to: [{ name: null, email: RECIPIENT }],
      cc: [],
      bcc: [],
      subject: `int-test ${tag}`,
      text: "Hello from the integration test.",
      attachments: [],
    });
    await owner.send(sessionId, draft.id, identity.id);

    const member = service();
    const m = await member.signIn(RECIPIENT, RECIPIENT_PASSWORD);
    const deadline = Date.now() + 40_000;
    let found = false;
    while (!found && Date.now() < deadline) {
      const res = (await member.jmapAs(m.sessionId, (s) => ({
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
        methodCalls: [["Email/query", { accountId: s.accountId, filter: { subject: tag } }, "q"]],
      }))) as { methodResponses: [string, { ids: string[] }, string][] };
      found = (res.methodResponses[0]?.[1].ids.length ?? 0) > 0;
      if (!found) await new Promise((r) => setTimeout(r, 1500));
    }
    expect(found).toBe(true);
  });

  it("delivers mail for an outside address to Mailpit (dev never sends out)", async () => {
    const tag = randomBytes(5).toString("hex");
    const outside = `outside-${tag}@example.com`;
    const owner = service();
    const { sessionId } = await owner.signIn(OWNER, demoPassword(OWNER));
    const identity = (await owner.identities(sessionId)).find((i) => i.email === OWNER);
    if (!identity) throw new Error("owner identity missing");
    const draft = await owner.saveDraft(sessionId, {
      identityId: identity.id,
      to: [{ name: null, email: outside }],
      cc: [],
      bcc: [],
      subject: `int-test external ${tag}`,
      text: "This must land in Mailpit.",
      attachments: [],
    });
    await owner.send(sessionId, draft.id, identity.id);
    const deadline = Date.now() + 40_000;
    let caught = 0;
    while (caught === 0 && Date.now() < deadline) {
      const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${outside}`)}`);
      caught = ((await r.json()) as { messages_count?: number }).messages_count ?? 0;
      if (caught === 0) await new Promise((res) => setTimeout(res, 1500));
    }
    expect(caught).toBe(1);
  });

  it("sends rich text as multipart/alternative with a text part, scripts removed", async () => {
    const tag = randomBytes(5).toString("hex");
    const outside = `outside-html-${tag}@example.com`;
    const owner = service();
    const { sessionId } = await owner.signIn(OWNER, demoPassword(OWNER));
    const identity = (await owner.identities(sessionId)).find((i) => i.email === OWNER);
    if (!identity) throw new Error("owner identity missing");
    const draft = await owner.saveDraft(sessionId, {
      identityId: identity.id,
      to: [{ name: null, email: outside }],
      cc: [],
      bcc: [],
      subject: `int-test html ${tag}`,
      text: "",
      html: `<p>Hello <b>rich ${tag}</b></p><script>alert(1)</script>`,
      attachments: [],
    });
    await owner.send(sessionId, draft.id, identity.id);
    const deadline = Date.now() + 40_000;
    let id: string | undefined;
    while (!id && Date.now() < deadline) {
      const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${outside}`)}`);
      id = ((await r.json()) as { messages?: { ID: string }[] }).messages?.[0]?.ID;
      if (!id) await new Promise((res) => setTimeout(res, 1500));
    }
    if (!id) throw new Error("html mail never reached Mailpit");
    const raw = await (await fetch(`${MAILPIT}/api/v1/message/${id}/raw`)).text();
    expect(raw).toMatch(/Content-Type: multipart\/alternative/i);
    expect(raw).toMatch(/Content-Type: text\/plain/i);
    expect(raw).toMatch(/Content-Type: text\/html/i);
    expect(raw).toContain(`rich ${tag}`);
    expect(raw).not.toContain("<script");
  });

  it("can undo a send while it is held", async () => {
    const tag = randomBytes(5).toString("hex");
    const owner = service();
    const { sessionId } = await owner.signIn(OWNER, demoPassword(OWNER));
    const identity = (await owner.identities(sessionId)).find((i) => i.email === OWNER);
    if (!identity) throw new Error("owner identity missing");
    const draft = await owner.saveDraft(sessionId, {
      identityId: identity.id,
      to: [{ name: null, email: RECIPIENT }],
      cc: [],
      bcc: [],
      subject: `int-test undo ${tag}`,
      text: "Never delivered.",
      attachments: [],
    });
    const sent = await owner.send(sessionId, draft.id, identity.id);
    expect((await owner.undoSend(sessionId, sent.submissionId)).draftId).toBe(draft.id);
    // Back in Drafts, so it can be deleted (moved to Trash) to keep the demo mailbox tidy.
    const roles = await owner.roles(sessionId);
    await owner.jmapAs(sessionId, (s) => ({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        [
          "Email/set",
          { accountId: s.accountId, update: { [draft.id]: { mailboxIds: { [roles.trash ?? ""]: true } } } },
          "u",
        ],
      ],
    }));
  });

  it("refuses a wrong password with the generic error", async () => {
    await expect(asClient(testIp(), () => service().signIn(OWNER, "not-the-password"))).rejects.toBeInstanceOf(
      WebmailSignInError,
    );
  });

  it("counts failed sign-ins per client: one address's wrong passwords never lock out others or the forwarder", async () => {
    const before = new Set((await blocked()).map((b) => b.id));
    const attacker = testIp();
    const svc = service();
    for (let i = 0; i < 16; i++) {
      // Wrong password, then (once Stalwart bans this address) "busy" — never anything else.
      const err = await asClient(attacker, () => svc.signIn(OWNER, `wrong-${String(i)}`)).catch((e: unknown) => e);
      expect(err instanceof WebmailSignInError || err instanceof WebmailBusyError).toBe(true);
    }
    // Another client (and the right password) still signs in.
    const ok = await asClient(testIp(), () => svc.signIn(OWNER, demoPassword(OWNER)));
    expect(ok.session.username).toBe(OWNER);
    await svc.signOut(ok.sessionId);

    const added = (await blocked()).filter((b) => !before.has(b.id));
    // Only documentation-range test addresses were banned: never loopback, the forwarder or the app (removed in
    // afterAll).
    expect(added.filter((b) => !isTestIp(b.address))).toEqual([]);
  });

  it("looks mailbox status up by address in Postgres (unknown → null)", async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error("TEST_DATABASE_URL is not set");
    const { db, pool } = createDb(url);
    try {
      expect(await pgMailboxStatusLookup(db)(`nobody-${randomBytes(4).toString("hex")}@example.test`)).toBeNull();
    } finally {
      await pool.end();
    }
  });

  it("keeps contacts in the mailbox's own address book: create, edit, delete", async () => {
    const tag = randomBytes(5).toString("hex");
    const svc = service();
    const { sessionId } = await svc.signIn(OWNER, demoPassword(OWNER));
    const input = ContactInput.parse({
      given: "Int",
      surname: tag,
      emails: [{ address: `int-contact-${tag}@example.org` }],
    });
    const { accountId, truncated } = await svc.contacts(sessionId);
    expect(truncated).toBe(false);
    const { id } = await svc.createContact(sessionId, accountId, input);
    await svc.updateContact(sessionId, accountId, id, { ...input, organization: "Integration" });
    expect(await svc.moveContacts(sessionId, accountId, [id, "zzzz"], "mine")).toBe(1);
    await expect(svc.createContact(sessionId, "not-this-account", input)).rejects.toThrow(/active mailbox changed/);
    const saved = (await svc.contacts(sessionId)).contacts.find((c) => c.id === id);
    expect(saved).toMatchObject({ name: `Int ${tag}`, organization: "Integration" });
    expect(await svc.exportContacts(sessionId, [id])).toContain(`EMAIL:int-contact-${tag}@example.org`);
    expect(await svc.deleteContacts(sessionId, accountId, [id])).toBe(1);
    expect((await svc.contacts(sessionId)).contacts.some((c) => c.id === id)).toBe(false);
  });

  it("saves new recipients to Other contacts after the send is released and leaves existing contacts alone", async () => {
    const tag = randomBytes(5).toString("hex");
    const known = `int-known-${tag}@example.org`;
    const fresh = `int-new-${tag}@example.org`;
    const owner = service(true);
    const { sessionId } = await owner.signIn(OWNER, demoPassword(OWNER));
    const { accountId } = await owner.contacts(sessionId);
    const { id: knownId } = await owner.createContact(
      sessionId,
      accountId,
      ContactInput.parse({ given: "Known", surname: tag, emails: [{ address: known }] }),
    );
    const identity = (await owner.identities(sessionId)).find((i) => i.email === OWNER);
    if (!identity) throw new Error("owner identity missing");
    const draft = await owner.saveDraft(sessionId, {
      identityId: identity.id,
      to: [
        { name: "Someone Else", email: known.toUpperCase() },
        { name: `New ${tag}`, email: fresh },
      ],
      cc: [],
      bcc: [],
      subject: `int-test contacts ${tag}`,
      text: "Outside addresses: this lands in Mailpit.",
      attachments: [],
    });
    await owner.send(sessionId, draft.id, identity.id);
    // Not saved while the send can still be undone…
    expect((await owner.contacts(sessionId)).contacts.some((c) => c.emails.some((e) => e.address === fresh))).toBe(
      false,
    );
    // …but once the hold is over (6 s, checked 2 s later).
    await new Promise((r) => setTimeout(r, 10_000));
    const { books, contacts } = await owner.contacts(sessionId);
    const other = books.find((b) => b.isOther);
    const added = contacts.filter((c) => c.emails.some((e) => e.address === fresh));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ name: `New ${tag}`, bookIds: [other?.id] });
    const kept = contacts.filter((c) => c.emails.some((e) => e.address === known));
    expect(kept.map((c) => [c.id, c.name])).toEqual([[knownId, `Known ${tag}`]]);
  }, 30_000);
});
