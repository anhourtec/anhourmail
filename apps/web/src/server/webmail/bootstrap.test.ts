// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  BootstrapUnavailableError,
  firstLoad,
  jmapCaller,
  type JmapCall,
  loadFirstView,
  MailboxChangedError,
  parseBootstrapQuery,
} from "./bootstrap";
import { writesEmail } from "./jmap-policy";
import type { WebmailSession } from "./session-store";

type Call = [string, Record<string, unknown>, string];

const FOLDERS = [
  { id: "in", name: "Inbox", role: "inbox" },
  { id: "tr", name: "Trash", role: "trash" },
  { id: "jk", name: "Junk", role: "junk" },
  { id: "se", name: "Sent", role: "sent" },
  { id: "f1", name: "Projects", role: null },
].map((f) => ({
  parentId: null,
  sortOrder: 0,
  totalEmails: 1,
  unreadEmails: 0,
  totalThreads: 1,
  unreadThreads: 0,
  ...f,
}));

const email = (id: string, threadId = `t-${id}`) => ({
  id,
  threadId,
  mailboxIds: { in: true },
  keywords: {},
  from: null,
  to: null,
  subject: null,
  receivedAt: "2026-10-31T00:00:00Z",
  preview: "",
  hasAttachment: false,
});

/** A fake mail server: answers the two first-load requests and records what was asked. */
function server(opts: { accountId?: string } = {}) {
  const asked: Call[][] = [];
  const call: JmapCall = async (calls) => {
    asked.push(calls);
    const out = new Map<string, Record<string, unknown>>();
    for (const [name, args, id] of calls) {
      if (name === "Mailbox/get")
        out.set(id, { accountId: opts.accountId ?? args.accountId, state: "ms", list: FOLDERS });
      else if (name === "Email/get" && Array.isArray(args.ids)) out.set(id, { state: "es", list: [] });
      else if (name === "Email/query" && args.limit === 0) out.set(id, { total: 3, ids: [] });
      else if (name === "Email/query") {
        const pinned = JSON.stringify(args.filter).includes('"hasKeyword":"$pinned"');
        out.set(id, { ids: pinned ? ["p1"] : ["e1", "e2"], total: pinned ? 1 : 120 });
      } else if (name === "Email/get") {
        const pinned = id.startsWith("pin-");
        out.set(id, { list: pinned ? [email("p1")] : [email("e1", "t1"), email("e2", "t1")] });
      } else if (name === "Thread/get") out.set(id, { list: [{ id: "t1", emailIds: ["e1", "e2", "e3"] }] });
    }
    return out;
  };
  return { call, asked };
}

describe("first load", () => {
  it("opens the Inbox with its pinned section, the Priority count and the sync states, in two requests", async () => {
    const s = server();
    const r = await loadFirstView(s.call, "acc", { start: "inbox", grouping: "conversations", attachments: false });
    expect(s.asked).toHaveLength(2);
    expect(r.view).toEqual({ kind: "folder", id: "in" });
    expect(r.state).toEqual({ email: "es", mailbox: "ms" });
    expect(r.priorityCount).toBe(3);
    expect(r.list?.pinned.map((x) => x.id)).toEqual(["p1"]);
    expect(r.list?.rows.map((x) => [x.id, x.threadSize])).toEqual([
      ["e1", 3],
      ["e2", 3],
    ]);
    expect(r.list?.total).toBe(120);
    // Priority hides Trash and Junk; the list is the Inbox without pinned mail, thread-collapsed, 50 rows.
    const second = s.asked[1] ?? [];
    expect(second.length).toBeLessThanOrEqual(16);
    expect(JSON.stringify(second[0]?.[1].filter)).toContain('"inMailboxOtherThan":["tr","jk"]');
    const main = second.find(([n, , id]) => n === "Email/query" && id === "main-q")?.[1];
    expect(main).toMatchObject({ collapseThreads: true, position: 0, limit: 50 });
    expect(JSON.stringify(main?.filter)).toContain('"notKeyword":"$pinned"');
    expect(second.every(([, a]) => a.accountId === "acc")).toBe(true);
  });

  it("opens Priority without a pinned section, a chosen folder, or the folder a tab's URL names", async () => {
    const pri = await loadFirstView(server().call, "acc", {
      start: "priority",
      grouping: "messages",
      attachments: true,
    });
    expect(pri.view).toEqual({ kind: "priority" });
    expect(pri.list?.pinned).toEqual([]);
    expect(pri.list?.rows.every((x) => x.threadSize === 1)).toBe(true);
    const s = server();
    await loadFirstView(s.call, "acc", { start: "priority", grouping: "messages", attachments: true });
    const get = s.asked[1]?.find(([n, , id]) => n === "Email/get" && id === "main-g")?.[1];
    expect(get).toMatchObject({ bodyProperties: ["name", "type"] });
    expect(get?.properties).toContain("attachments");

    const chosen = await loadFirstView(server().call, "acc", {
      start: "folder:f1",
      grouping: "conversations",
      attachments: false,
    });
    expect(chosen.view).toEqual({ kind: "folder", id: "f1" });
    const named = await loadFirstView(server().call, "acc", {
      start: "inbox",
      grouping: "conversations",
      attachments: false,
      folder: "sent",
    });
    expect(named.view).toEqual({ kind: "folder", id: "se" });
    // A folder that isn't this mailbox's opens the Inbox: nothing of another mailbox is ever asked for.
    const unknown = await loadFirstView(server().call, "acc", {
      start: "folder:other-account-folder",
      grouping: "conversations",
      attachments: false,
    });
    expect(unknown.view).toEqual({ kind: "folder", id: "in" });
  });

  it("refuses an answer for another mailbox (the active one changed meanwhile)", async () => {
    await expect(
      loadFirstView(server({ accountId: "other" }).call, "acc", {
        start: "inbox",
        grouping: "conversations",
        attachments: false,
      }),
    ).rejects.toBeInstanceOf(BootstrapUnavailableError);
  });

  it("answers with the session document of the session it read, or null when signed out", async () => {
    const s = server();
    const session = { accountId: "acc", username: "a@x.test" } as WebmailSession;
    const asked: unknown[] = [];
    const svc = {
      session: async () => session,
      jmap: async (_id: string, body: { methodCalls: Call[] }) => {
        asked.push(body);
        const res = await s.call(body.methodCalls);
        return { status: 200, body: { methodResponses: [...res].map(([id, args]) => ["x", args, id]) } };
      },
    };
    const b = await firstLoad(svc, "sid", { start: "inbox", grouping: "conversations", attachments: false });
    expect(b?.session.primaryAccounts["urn:ietf:params:jmap:mail"]).toBe("acc");
    expect(b?.session.apiUrl).toBe("/api/webmail/jmap");
    expect(JSON.stringify(b?.session)).not.toMatch(/token|Bearer/i);
    expect(asked).toHaveLength(2);
    expect(
      await firstLoad({ ...svc, session: async () => null }, "sid", {
        start: "inbox",
        grouping: "conversations",
        attachments: false,
      }),
    ).toBeNull();
  });
});

describe("the mailbox the app shows", () => {
  it("is refused when another one is active, before the mail server is asked", async () => {
    let asked = 0;
    const svc = {
      session: async () => ({ accountId: "acc", username: "Sam@X.test" }) as WebmailSession,
      jmap: async () => {
        asked += 1;
        return { status: 500, body: null };
      },
    };
    await expect(
      firstLoad(svc, "sid", { start: "inbox", grouping: "conversations", attachments: false, expect: "pat@x.test" }),
    ).rejects.toBeInstanceOf(MailboxChangedError);
    expect(asked).toBe(0);
  });
});

describe("jmapCaller", () => {
  const body = (status: number, b: unknown) => async () => ({ status, body: b });
  it("returns responses by call id, the first per id", async () => {
    const r = await jmapCaller(
      body(200, {
        methodResponses: [
          ["Mailbox/get", { a: 1 }, "m"],
          ["Mailbox/get", { a: 2 }, "m"],
        ],
      }),
    )([]);
    expect(r.get("m")).toEqual({ a: 1 });
  });
  it("throws on an HTTP failure, a method error or a malformed answer", async () => {
    await expect(jmapCaller(body(401, null))([])).rejects.toBeInstanceOf(BootstrapUnavailableError);
    await expect(
      jmapCaller(body(200, { methodResponses: [["error", { type: "forbidden" }, "m"]] }))([]),
    ).rejects.toBeInstanceOf(BootstrapUnavailableError);
    await expect(jmapCaller(body(200, { methodResponses: [["x"]] }))([])).rejects.toBeInstanceOf(
      BootstrapUnavailableError,
    );
    await expect(jmapCaller(body(200, {}))([])).rejects.toBeInstanceOf(BootstrapUnavailableError);
  });
});

describe("parseBootstrapQuery", () => {
  const q = (s: string) => parseBootstrapQuery(new URLSearchParams(s));
  it("reads the preferences and a tab's folder, with defaults", () => {
    expect(q("")).toEqual({ start: "inbox", grouping: "conversations", attachments: false });
    expect(q("expect=Pat@Example.test")).toMatchObject({ expect: "pat@example.test" });
    expect(q("start=folder:Ab_1&grouping=messages&chips=1&folder=sent")).toEqual({
      start: "folder:Ab_1",
      grouping: "messages",
      attachments: true,
      folder: "sent",
    });
  });
  it("refuses anything malformed", () => {
    for (const bad of [
      "start=elsewhere",
      "start=folder:",
      "grouping=threads",
      "chips=yes",
      "folder=a%20b",
      "expect=not-an-address",
      `folder=${"x".repeat(256)}`,
    ]) {
      expect(q(bad)).toBeNull();
    }
  });
});

describe("writesEmail", () => {
  it("is true for an Email/set call or anything malformed, false for reads", () => {
    expect(writesEmail({ methodCalls: [["Mailbox/get", {}, "m"]] })).toBe(false);
    expect(
      writesEmail({
        methodCalls: [
          ["Email/get", {}, "g"],
          ["Email/set", {}, "s"],
        ],
      }),
    ).toBe(true);
    expect(writesEmail({ methodCalls: [[1, {}, "s"]] })).toBe(true);
    expect(writesEmail({ methodCalls: "x" })).toBe(true);
    expect(writesEmail(null)).toBe(true);
  });
});
