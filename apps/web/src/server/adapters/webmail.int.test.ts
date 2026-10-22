// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Webmail BFF against the real dev Stalwart (`npm run test:int`): the headless OAuth sign-in with a demo mailbox,
 * a proxied `Mailbox/get`, and the refusals. The demo password is read from the local credentials.md
 * (`npm run db:seed -- --demo`) and never printed.
 */
import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createDb, pgMailboxStatusLookup } from "@anhourmail/adapters/postgres";
import { createKeyRing } from "@anhourmail/server/keyring";
import { memorySlidingQuota } from "@anhourmail/server/rate-limit";

import { demoPassword } from "../../../../../tests/support/demo-credentials";
import { memoryKv, WebmailSessionStore } from "../webmail/session-store";
import { WebmailService, WebmailSignInError } from "../webmail/service";
import { stalwartOAuthPort } from "./stalwart-oauth";

const STALWART_URL = process.env.STALWART_URL ?? "http://127.0.0.1:43080";
const WEBMAIL_URL = process.env.WEBMAIL_URL ?? "http://localhost:43300";
const OWNER = "owner@demo-family.test";
const MEMBER = "member@demo-family.test";
const MAILPIT = `http://localhost:${process.env.MAILPIT_UI_PORT ?? "43026"}`;

function service() {
  return new WebmailService({
    store: new WebmailSessionStore(memoryKv(), createKeyRing([{ id: "t", key: randomBytes(32) }])),
    oauth: stalwartOAuthPort({ stalwartUrl: STALWART_URL, webmailUrl: WEBMAIL_URL }),
    stalwartUrl: STALWART_URL,
    access: { allowed: async () => true },
    quota: memorySlidingQuota(),
  });
}

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

  it("sends between two demo mailboxes: draft, held submission, delivery", async () => {
    const tag = randomBytes(5).toString("hex");
    const owner = service();
    const { sessionId } = await owner.signIn(OWNER, demoPassword(OWNER));
    const identity = (await owner.identities(sessionId)).find((i) => i.email === OWNER);
    if (!identity) throw new Error("owner identity missing");
    const draft = await owner.saveDraft(sessionId, {
      identityId: identity.id,
      to: [{ name: null, email: MEMBER }],
      cc: [],
      bcc: [],
      subject: `int-test ${tag}`,
      text: "Hello from the integration test.",
      attachments: [],
    });
    await owner.send(sessionId, draft.id, identity.id);

    const member = service();
    const m = await member.signIn(MEMBER, demoPassword(MEMBER));
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

  it("can undo a send while it is held", async () => {
    const tag = randomBytes(5).toString("hex");
    const owner = service();
    const { sessionId } = await owner.signIn(OWNER, demoPassword(OWNER));
    const identity = (await owner.identities(sessionId)).find((i) => i.email === OWNER);
    if (!identity) throw new Error("owner identity missing");
    const draft = await owner.saveDraft(sessionId, {
      identityId: identity.id,
      to: [{ name: null, email: MEMBER }],
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
    await expect(service().signIn(OWNER, "not-the-password")).rejects.toBeInstanceOf(WebmailSignInError);
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
});
