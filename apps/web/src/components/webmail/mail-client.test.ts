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

type MethodCall = [string, Record<string, unknown>, string];

/**
 * A fetch that answers JMAP requests with `handle` (one response per call) and every other path with `other`
 * (status, body). Records each JMAP request's method names.
 */
function jmapServer(
  handle: (calls: MethodCall[]) => unknown[],
  other: (path: string) => Response = () => Response.json({ data: {} }),
) {
  const requests: string[][] = [];
  const fetchFn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/api/webmail/session") return Promise.resolve(Response.json(SESSION));
    if (url.pathname === "/api/webmail/jmap") {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { methodCalls: MethodCall[] };
      requests.push(body.methodCalls.map((c) => c[0]));
      return Promise.resolve(Response.json({ methodResponses: handle(body.methodCalls) }));
    }
    return Promise.resolve(other(url.pathname));
  });
  return { fetchFn, requests };
}

const setOk = (calls: MethodCall[]) => calls.map(([, , id]) => ["Email/set", { updated: {}, destroyed: [] }, id]);

describe("telling the app about changes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports moves, keyword changes, restores and deletes once each, after they are answered", async () => {
    const server = jmapServer((calls) =>
      calls.map(([name, , id]) =>
        name === "Email/get"
          ? ["Email/get", { list: [{ id: "e1", mailboxIds: { inbox: true } }] }, id]
          : name === "Thread/get"
            ? ["Thread/get", { list: [{ id: "t1", emailIds: ["e1"] }] }, id]
            : ["Email/set", { updated: { e1: null }, destroyed: ["e1"] }, id],
      ),
    );
    vi.stubGlobal("fetch", server.fetchFn);
    const client = createMailClient(ORIGIN);
    const seen = vi.fn();
    client.onChange(seen);
    await client.setKeyword(["e1"], "$seen", true);
    expect(seen).toHaveBeenCalledTimes(1);
    await client.move(["t1"], "inbox", "trash");
    expect(seen).toHaveBeenCalledTimes(2);
    await client.restore({ e1: { inbox: true } });
    expect(seen).toHaveBeenCalledTimes(3);
    await client.destroy(["e1"]);
    expect(seen).toHaveBeenCalledTimes(4);
  });

  it("reports nothing for reads, and stops once unsubscribed", async () => {
    const server = jmapServer((calls) => calls.map(([name, , id]) => [name, { list: [], state: "s" }, id]));
    vi.stubGlobal("fetch", server.fetchFn);
    const client = createMailClient(ORIGIN);
    const seen = vi.fn();
    const off = client.onChange(seen);
    await client.folders();
    await client.thread("t1");
    expect(seen).not.toHaveBeenCalled();
    off();
    vi.stubGlobal("fetch", jmapServer(setOk).fetchFn);
    await client.setKeyword(["e1"], "$flagged", true);
    expect(seen).not.toHaveBeenCalled();
  });

  it("reports a failed batch (part of it may have landed) but not a refusal", async () => {
    vi.stubGlobal(
      "fetch",
      jmapServer((calls) => calls.map(([, , id]) => ["Email/set", { notUpdated: { e1: { type: "notFound" } } }, id]))
        .fetchFn,
    );
    const client = createMailClient(ORIGIN);
    const seen = vi.fn();
    client.onChange(seen);
    await expect(client.setKeyword(["e1"], "$seen", true)).rejects.toThrow("not updated");
    expect(seen).toHaveBeenCalledTimes(1);

    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.pathname === "/api/webmail/session") return Promise.resolve(Response.json(SESSION));
        return Promise.resolve(new Response(null, { status: 400 }));
      }),
    );
    await expect(client.setKeyword(["e1"], "$seen", true)).rejects.toBeInstanceOf(RefusedError);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("reports a new draft, a send and an undone send, but not saving over a draft", async () => {
    vi.stubGlobal(
      "fetch",
      jmapServer(setOk, (path) =>
        Response.json({
          data: path.endsWith("/undo")
            ? { draftId: "d1" }
            : path.endsWith("/send")
              ? { submissionId: "s1", sendAt: "", holdSeconds: 0 }
              : { id: "d1" },
        }),
      ).fetchFn,
    );
    const client = createMailClient(ORIGIN);
    const seen = vi.fn();
    client.onChange(seen);
    const draft = { identityId: "i1", to: [], cc: [], bcc: [], subject: "Hi", text: "", attachments: [] };
    await client.saveDraft(draft);
    expect(seen).toHaveBeenCalledTimes(1);
    await client.saveDraft({ ...draft, replaces: "d1" });
    expect(seen).toHaveBeenCalledTimes(1);
    await client.send("d1", "i1");
    expect(seen).toHaveBeenCalledTimes(2);
    await client.undoSend("s1");
    expect(seen).toHaveBeenCalledTimes(3);
  });

  it("keeps the change even when a listener throws", async () => {
    vi.stubGlobal("fetch", jmapServer(setOk).fetchFn);
    const client = createMailClient(ORIGIN);
    const after = vi.fn();
    client.onChange(() => {
      throw new Error("listener");
    });
    client.onChange(after);
    await expect(client.setKeyword(["e1"], "$seen", true)).resolves.toBeUndefined();
    expect(after).toHaveBeenCalledTimes(1);
  });
});

describe("automatic refresh", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts from both states in one request", async () => {
    const server = jmapServer((calls) =>
      calls.map(([name, , id]) => [name, { list: [], state: name === "Email/get" ? "e1" : "m1" }, id]),
    );
    vi.stubGlobal("fetch", server.fetchFn);
    const r = await createMailClient(ORIGIN).mailChanges(null);
    expect(r).toMatchObject({ state: { email: "e1", mailbox: "m1" }, changed: false, foldersChanged: false });
    expect(server.requests).toEqual([["Email/get", "Mailbox/get"]]);
  });

  it("asks Email/changes and Mailbox/changes in one request and says which changed", async () => {
    type Changes = { newState: string; created: string[]; updated: string[]; destroyed: string[] };
    let mailbox: Changes = { newState: "m2", updated: ["inbox"], created: [], destroyed: [] };
    let email: Changes = { newState: "e1", created: [], updated: [], destroyed: [] };
    const server = jmapServer((calls) =>
      calls.map(([name, , id]) =>
        name === "Email/changes"
          ? [name, email, id]
          : name === "Mailbox/changes"
            ? [name, mailbox, id]
            : [name, { list: [] }, id],
      ),
    );
    vi.stubGlobal("fetch", server.fetchFn);
    const client = createMailClient(ORIGIN);
    // Counts changed elsewhere (read on another device): only the folders.
    const r = await client.mailChanges({ email: "e1", mailbox: "m1" });
    expect(server.requests).toEqual([["Email/changes", "Email/get", "Mailbox/changes"]]);
    expect(r).toMatchObject({ state: { email: "e1", mailbox: "m2" }, changed: false, foldersChanged: true });

    email = { newState: "e2", created: [], updated: ["x"], destroyed: [] };
    mailbox = { newState: "m2", updated: [], created: [], destroyed: [] };
    const again = await client.mailChanges(r.state);
    expect(again).toMatchObject({ changed: true, foldersChanged: false, touched: ["x"], reset: false });
  });

  it("starts again from fresh states when the server can't calculate the changes", async () => {
    let first = true;
    const server = jmapServer((calls) => {
      if (first) {
        first = false;
        return [["error", { type: "cannotCalculateChanges" }, "b"]];
      }
      return calls.map(([name, , id]) => [name, { list: [], state: name === "Email/get" ? "e9" : "m9" }, id]);
    });
    vi.stubGlobal("fetch", server.fetchFn);
    const r = await createMailClient(ORIGIN).mailChanges({ email: "e1", mailbox: "m1" });
    expect(r).toMatchObject({
      state: { email: "e9", mailbox: "m9" },
      changed: true,
      foldersChanged: true,
      reset: true,
    });
  });
});

describe("a shared mailbox's tab", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const headersSeen = () => {
    const seen: { path: string; shared: string | null; own: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        const h = new Headers(init?.headers);
        seen.push({ path: url.pathname, shared: h.get("X-Webmail-Shared"), own: h.get("X-Webmail-Own") });
        if (url.pathname === "/api/webmail/session") return Promise.resolve(Response.json(SESSION));
        return Promise.resolve(Response.json({ data: { id: "d1" } }));
      }),
    );
    return seen;
  };

  it("pins its shared mailbox on reads, and the person's own mailbox (never both) on its compose requests", async () => {
    const seen = headersSeen();
    const reading = createMailClient(ORIGIN, { shared: "Desk@Example.test" });
    const writing = createMailClient(ORIGIN, { own: "Pat@Example.test" });
    await reading.mailboxes();
    await writing.saveDraft({
      identityId: "i1",
      to: [],
      cc: [],
      bcc: [],
      subject: "",
      text: "",
      attachments: [],
    });
    expect(seen.find((r) => r.path === "/api/webmail/mailboxes")).toMatchObject({
      shared: "desk@example.test",
      own: null,
    });
    // The draft's account check and the draft itself both go to the own mailbox.
    for (const path of ["/api/webmail/session", "/api/webmail/drafts"]) {
      expect(seen.find((r) => r.path === path && r.own !== null)).toMatchObject({
        shared: null,
        own: "pat@example.test",
      });
    }
  });
});
