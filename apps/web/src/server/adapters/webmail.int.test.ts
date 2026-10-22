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

import { demoPassword } from "../../../../../tests/support/demo-credentials";
import { memoryKv, WebmailSessionStore } from "../webmail/session-store";
import { WebmailService, WebmailSignInError } from "../webmail/service";
import { stalwartOAuthPort } from "./stalwart-oauth";

const STALWART_URL = process.env.STALWART_URL ?? "http://127.0.0.1:43080";
const WEBMAIL_URL = process.env.WEBMAIL_URL ?? "http://localhost:43300";
const OWNER = "owner@demo-family.test";

function service() {
  return new WebmailService({
    store: new WebmailSessionStore(memoryKv(), createKeyRing([{ id: "t", key: randomBytes(32) }])),
    oauth: stalwartOAuthPort({ stalwartUrl: STALWART_URL, webmailUrl: WEBMAIL_URL }),
    stalwartUrl: STALWART_URL,
    access: { allowed: async () => true },
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
