// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMailClient, RefusedError } from "./mail-client";

const ORIGIN = "http://mail.test";
const SESSION = {
  apiUrl: `${ORIGIN}/api/webmail/jmap`,
  downloadUrl: `${ORIGIN}/api/webmail/download/{blobId}`,
  uploadUrl: `${ORIGIN}/api/webmail/upload`,
  eventSourceUrl: "",
  state: "s1",
  username: "pat@example.test",
  primaryAccounts: { "urn:ietf:params:jmap:mail": "acc1" },
  capabilities: {},
};

type Call = { method: string; path: string; answer: (res: Response) => void };

/** A fetch whose answers the test hands out one by one; the session is answered at once. */
function fakeServer() {
  const calls: Call[] = [];
  const fetchFn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/api/webmail/session") return Promise.resolve(Response.json(SESSION));
    return new Promise<Response>((answer) => {
      calls.push({ method: init?.method ?? "GET", path: url.pathname, answer });
    });
  });
  const sent = () => calls.map((c) => `${c.method} ${c.path}`);
  const answer = (path: string, res: Response) => {
    const i = calls.findIndex((c) => c.path === path);
    const call = calls[i];
    if (!call) throw new Error(`no request to ${path}`);
    calls.splice(i, 1);
    call.answer(res);
  };
  return { fetchFn, sent, answer };
}

/** Lets every queued promise callback run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const folders = () => Response.json({ methodResponses: [["Mailbox/get", { list: [] }, "m"]] });
const mailboxes = () => Response.json({ data: { active: "sam@example.test", others: ["pat@example.test"] } });

describe("changing the active mailbox", () => {
  let server: ReturnType<typeof fakeServer>;
  beforeEach(() => {
    server = fakeServer();
    vi.stubGlobal("fetch", server.fetchFn);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("waits for the requests in flight, then holds every new one for good once it succeeds", async () => {
    const client = createMailClient(ORIGIN);
    const list = client.folders();
    await settle();
    expect(server.sent()).toEqual(["POST /api/webmail/jmap"]);

    const switched = client.switchMailbox("sam@example.test");
    void client.contacts();
    await settle();
    // Not sent while the list request is still being answered for the old mailbox; the new request waits too.
    expect(server.sent()).toEqual(["POST /api/webmail/jmap"]);

    server.answer("/api/webmail/jmap", folders());
    await expect(list).resolves.toEqual([]);
    await settle();
    expect(server.sent()).toEqual(["PUT /api/webmail/mailboxes/active"]);

    server.answer("/api/webmail/mailboxes/active", mailboxes());
    await expect(switched).resolves.toEqual({ active: "sam@example.test", others: ["pat@example.test"] });
    void client.folders();
    await settle();
    // The page reloads next: nothing more goes out with the old mailbox's account and ids.
    expect(server.sent()).toEqual([]);
  });

  it("adds a mailbox the same way", async () => {
    const client = createMailClient(ORIGIN);
    const message = client.message("e1");
    await settle();
    const added = client.addMailbox("sam@example.test", "pw");
    await settle();
    expect(server.sent()).toEqual(["GET /api/webmail/messages/e1"]);
    server.answer("/api/webmail/messages/e1", new Response(null, { status: 404 }));
    await expect(message).resolves.toBeNull();
    await settle();
    expect(server.sent()).toEqual(["POST /api/webmail/mailboxes"]);
    server.answer("/api/webmail/mailboxes", mailboxes());
    await expect(added).resolves.toMatchObject({ active: "sam@example.test" });
  });

  it("lets held requests through when the change is refused", async () => {
    const client = createMailClient(ORIGIN);
    const switched = client.switchMailbox("nobody@example.test");
    const contacts = client.contacts();
    await settle();
    expect(server.sent()).toEqual(["PUT /api/webmail/mailboxes/active"]);
    server.answer(
      "/api/webmail/mailboxes/active",
      Response.json({ error: { code: "bad_request", message: "That mailbox isn't signed in." } }, { status: 400 }),
    );
    await expect(switched).rejects.toBeInstanceOf(RefusedError);
    await settle();
    expect(server.sent()).toEqual(["GET /api/webmail/contacts"]);
    server.answer("/api/webmail/contacts", Response.json({ data: { accountId: "acc1", books: [], contacts: [] } }));
    await expect(contacts).resolves.toMatchObject({ accountId: "acc1" });
  });

  it("runs requests side by side when no change is under way", async () => {
    const client = createMailClient(ORIGIN);
    void client.folders();
    void client.identities();
    await settle();
    expect(server.sent().sort()).toEqual(["GET /api/webmail/identities", "POST /api/webmail/jmap"]);
  });
});

describe("changing the mailbox's own password", () => {
  let server: ReturnType<typeof fakeServer>;
  beforeEach(() => {
    server = fakeServer();
    vi.stubGlobal("fetch", server.fetchFn);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const MESSAGE = "Your administrator has set a new password for this mailbox that isn't in use yet.";

  it("shows the server's reason when an administrator's password is still waiting (409 password_change_pending)", async () => {
    const client = createMailClient(ORIGIN);
    const changed = client.changePassword("acc1", "old one", "new one");
    await settle();
    server.answer(
      "/api/webmail/settings/password",
      Response.json({ error: { code: "password_change_pending", message: MESSAGE } }, { status: 409 }),
    );
    await expect(changed).rejects.toMatchObject({ name: "RefusedError", message: MESSAGE });
  });

  it("keeps other conflicts generic", async () => {
    const client = createMailClient(ORIGIN);
    const changed = client.changePassword("acc1", "old one", "new one");
    await settle();
    server.answer(
      "/api/webmail/settings/password",
      Response.json({ error: { code: "conflict", message: "Something else." } }, { status: 409 }),
    );
    await expect(changed).rejects.not.toBeInstanceOf(RefusedError);
  });
});
