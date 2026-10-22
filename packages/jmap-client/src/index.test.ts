// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { CAPABILITIES, JmapClient, JmapError } from ".";

const SESSION = {
  apiUrl: "http://internal:8080/jmap/",
  uploadUrl: "http://internal:8080/jmap/upload/{accountId}/",
  downloadUrl: "",
  eventSourceUrl: "",
  state: "s",
  username: "a@x.test",
  primaryAccounts: { [CAPABILITIES.mail]: "acc" },
  capabilities: {},
};

function fake(responder: (calls: [string, Record<string, unknown>, string][]) => unknown[]) {
  const seen: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push(url);
    if (url.endsWith("/session")) return Response.json(SESSION);
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      methodCalls: [string, Record<string, unknown>, string][];
    };
    return Response.json({ methodResponses: responder(body.methodCalls) });
  }) as typeof fetch;
  return { f, seen };
}

const MAILBOXES = [
  { id: "in", name: "Inbox", role: "inbox", totalEmails: 1, unreadEmails: 1 },
  { id: "dr", name: "Drafts", role: "drafts", totalEmails: 0, unreadEmails: 0 },
  { id: "se", name: "Sent", role: "sent", totalEmails: 0, unreadEmails: 0 },
];

describe("JmapClient", () => {
  it("rewrites advertised URLs to the origin it was given", async () => {
    const { f, seen } = fake(() => [["Mailbox/get", { list: MAILBOXES }, "m"]]);
    const c = new JmapClient({ sessionUrl: "http://proxy.local/jmap/session", authorization: "Basic x", fetch: f });
    expect((await c.mailboxByRole("inbox"))?.id).toBe("in");
    expect(seen[1]).toBe("http://proxy.local/jmap/");
    expect(await c.accountId()).toBe("acc");
  });

  it("lists summaries and keeps the first response per call id", async () => {
    const { f } = fake(() => [
      ["Email/query", { ids: ["e1"] }, "q"],
      ["Email/get", { list: [{ id: "e1", subject: "hi" }] }, "g"],
      ["Email/get", { list: [] }, "g"],
    ]);
    const c = new JmapClient({ sessionUrl: "http://p/jmap/session", fetch: f, rewriteUrl: (u) => u });
    expect((await c.listEmails("in"))[0]?.subject).toBe("hi");
  });

  it("sends via Email/set + EmailSubmission/set with the matching identity", async () => {
    const { f } = fake((calls) => {
      const name = calls[0]?.[0];
      if (name === "Mailbox/get") return [["Mailbox/get", { list: MAILBOXES }, "m"]];
      if (name === "Identity/get") return [["Identity/get", { list: [{ id: "id1", email: "a@x.test" }] }, "i"]];
      return [
        ["Email/set", { created: { draft: { id: "e1" } } }, "e"],
        ["EmailSubmission/set", { created: { sub: { id: "s1" } } }, "s"],
        ["Email/set", { updated: { e1: null } }, "s"],
      ];
    });
    const c = new JmapClient({ sessionUrl: "http://p/jmap/session", fetch: f });
    expect(await c.sendText({ from: "a@x.test", to: ["b@x.test"], subject: "s", text: "t" })).toBe("s1");
    await expect(c.sendText({ from: "other@x.test", to: [], subject: "", text: "" })).rejects.toMatchObject({
      type: "noIdentity",
    });
  });

  it("surfaces HTTP, method and submission errors", async () => {
    const bad = (async () => new Response("", { status: 401 })) as typeof fetch;
    await expect(new JmapClient({ sessionUrl: "http://p/s", fetch: bad }).session()).rejects.toBeInstanceOf(JmapError);
    const { f } = fake(() => [["error", { type: "serverFail" }, "m"]]);
    await expect(new JmapClient({ sessionUrl: "http://p/session", fetch: f }).mailboxes()).rejects.toMatchObject({
      type: "serverFail",
    });
    const rejected = fake((calls) => {
      const name = calls[0]?.[0];
      if (name === "Mailbox/get") return [["Mailbox/get", { list: MAILBOXES }, "m"]];
      if (name === "Identity/get") return [["Identity/get", { list: [{ id: "id1", email: "a@x.test" }] }, "i"]];
      return [["EmailSubmission/set", { notCreated: { sub: { type: "forbiddenFrom" } } }, "s"]];
    });
    await expect(
      new JmapClient({ sessionUrl: "http://p/session", fetch: rejected.f }).sendText({
        from: "a@x.test",
        to: ["b"],
        subject: "",
        text: "",
      }),
    ).rejects.toMatchObject({ type: "notCreated" });
  });
});

describe("JmapClient.upload", () => {
  it("posts to the rewritten upload URL and returns the blob id", async () => {
    const seen: { url: string; type: string | null }[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/session")) return Response.json(SESSION);
      seen.push({ url, type: new Headers(init?.headers).get("content-type") });
      return Response.json({ blobId: "b1", size: 3 });
    }) as typeof fetch;
    const c = new JmapClient({ sessionUrl: "http://proxy.local/jmap/session", fetch: f });
    expect(await c.upload("abc", "message/rfc822")).toBe("b1");
    expect(await c.upload(new Uint8Array([1, 2]), "application/octet-stream")).toBe("b1");
    expect(seen[0]).toEqual({ url: "http://proxy.local/jmap/upload/acc/", type: "message/rfc822" });
  });

  it("throws on HTTP errors and a missing blob id", async () => {
    const make = (res: () => Response) =>
      new JmapClient({
        sessionUrl: "http://p/jmap/session",
        fetch: async (input: string | URL | Request) =>
          String(input instanceof Request ? input.url : input).endsWith("/session") ? Response.json(SESSION) : res(),
      });
    await expect(make(() => new Response("", { status: 413 })).upload("x", "text/plain")).rejects.toBeInstanceOf(
      JmapError,
    );
    await expect(make(() => Response.json({})).upload("x", "text/plain")).rejects.toThrow(/blobId/);
  });
});
