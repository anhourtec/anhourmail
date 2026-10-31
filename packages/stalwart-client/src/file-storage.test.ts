// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { StalwartTransport } from "./client";
import { clearFileStorage } from "./file-storage";
import { StalwartManagement } from "./management";

type Node = { id: string; parentId: string | null; shareWith: Record<string, unknown> | null };

/** A fake Stalwart holding file nodes per account; `#ids` back-references resolve to the account's whole list. */
function server(
  files: Record<string, Node[]>,
  opts: { refuse?: string[]; stuck?: string[]; keepShared?: string[] } = {},
) {
  const sets: { accountId: string; args: Record<string, unknown> }[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      methodCalls: [string, Record<string, unknown>, string][];
    };
    const methodResponses = body.methodCalls.map(([name, args, id]) => {
      const accountId = typeof args.accountId === "string" ? args.accountId : "";
      if (name === "x:Account/get") {
        return [name, { list: Object.keys(files).map((a) => ({ id: a, name: a, domainId: "d" })) }, id];
      }
      if (name === "x:Domain/get") return [name, { list: [{ id: "d", name: "x.test" }] }, id];
      if (opts.refuse?.includes(accountId)) return ["error", { type: "accountNotFound" }, id];
      const list = files[accountId] ?? [];
      if (name === "FileNode/query") return [name, { ids: list.map((n) => n.id) }, id];
      if (name === "FileNode/get") return [name, { list: list.map((n) => ({ ...n })) }, id];
      if (name === "FileNode/set") {
        sets.push({ accountId, args });
        const updated: Record<string, null> = {};
        const notUpdated: Record<string, { type: string }> = {};
        for (const [nid, patch] of Object.entries((args.update ?? {}) as Record<string, Partial<Node>>)) {
          const n = list.find((x) => x.id === nid);
          if (!n || opts.keepShared?.includes(nid)) {
            notUpdated[nid] = { type: "forbidden" };
            continue;
          }
          Object.assign(n, patch);
          updated[nid] = null;
        }
        const gone = ((args.destroy ?? []) as string[]).filter((d) => !opts.stuck?.includes(d));
        files[accountId] = list.filter((n) => !gone.includes(n.id));
        return [name, { updated, notUpdated, destroyed: gone }, id];
      }
      return ["error", { type: "unknownMethod" }, id];
    });
    return Response.json({ methodResponses });
  }) as typeof fetch;
  const mgmt = new StalwartManagement(
    new StalwartTransport({
      baseUrl: "http://s",
      auth: { type: "basic", username: "a", password: "p" },
      fetch: fetchImpl,
    }),
  );
  return { mgmt, sets, files };
}

const tree = (): Node[] => [
  { id: "dir", parentId: null, shareWith: { other: { mayRead: true } } },
  { id: "f1", parentId: "dir", shareWith: null },
  { id: "f2", parentId: null, shareWith: { other: { mayRead: true } } },
];

describe("clearFileStorage", () => {
  it("removes every share and leaves the files when not destroying", async () => {
    const s = server({ a: tree(), b: [] });
    expect(await clearFileStorage(s.mgmt, { destroy: false })).toEqual({
      accounts: 2,
      accountsWithFiles: 1,
      sharesCleared: 2,
      sharesRefused: 0,
      destroyed: 0,
      remaining: 0,
      skipped: 0,
    });
    expect(s.sets).toEqual([
      { accountId: "a", args: { accountId: "a", update: { dir: { shareWith: null }, f2: { shareWith: null } } } },
    ]);
    expect(s.files.a?.every((n) => n.shareWith === null)).toBe(true);
    expect(s.files.a).toHaveLength(3);
  });

  it("destroys contents before their folders, skips refused and excluded accounts, and is idempotent", async () => {
    const s = server({ a: tree(), svc: tree(), gone: tree() }, { refuse: ["gone"] });
    const first = await clearFileStorage(s.mgmt, { destroy: true, skipAccountIds: ["svc"] });
    expect(first).toMatchObject({ accounts: 2, accountsWithFiles: 1, sharesCleared: 2, destroyed: 3, skipped: 1 });
    expect(s.files.a).toEqual([]);
    // A folder is never in the same destroy as something inside it.
    expect(s.sets.filter((x) => x.args.destroy).map((x) => x.args.destroy)).toEqual([["f1", "f2"], ["dir"]]);
    expect(s.files.svc).toHaveLength(3);
    expect(await clearFileStorage(s.mgmt, { destroy: true, accountIds: ["a"] })).toMatchObject({
      accountsWithFiles: 0,
      destroyed: 0,
    });
  });

  it("counts only the shares the server removed; a refused one is reported, not counted as cleared", async () => {
    const s = server({ a: tree() }, { keepShared: ["f2"] });
    expect(await clearFileStorage(s.mgmt, { destroy: false })).toMatchObject({ sharesCleared: 1, sharesRefused: 1 });
    expect(s.files.a?.find((n) => n.id === "f2")?.shareWith).not.toBeNull();
  });

  it("reports what the server wouldn't destroy instead of looping forever", async () => {
    const s = server({ a: [{ id: "x", parentId: null, shareWith: null }] }, { stuck: ["x"] });
    expect(await clearFileStorage(s.mgmt, { destroy: true })).toMatchObject({ destroyed: 0, remaining: 1 });
  });
});
