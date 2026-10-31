// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  bootstrapUrl,
  type Folder,
  hasPinnedSection,
  hiddenFolders,
  listKey,
  mainFilter,
  pageCalls,
  pageRows,
  pinnedFilter,
  startView,
} from "./list-query";

const folder = (id: string, role: string | null): Folder => ({
  id,
  name: id,
  role,
  parentId: null,
  sortOrder: 0,
  totalEmails: 0,
  unreadEmails: 0,
  totalThreads: 0,
  unreadThreads: 0,
});
const FOLDERS = [
  folder("f0", null),
  folder("in", "inbox"),
  folder("tr", "trash"),
  folder("jk", "junk"),
  folder("se", "sent"),
];

describe("the view the app opens in", () => {
  it("follows the start preference, then a tab's named folder, then the Inbox, then the first folder", () => {
    expect(startView(FOLDERS, "priority")).toEqual({ kind: "priority" });
    expect(startView(FOLDERS, "folder:se")).toEqual({ kind: "folder", id: "se" });
    expect(startView(FOLDERS, "inbox", "sent")).toEqual({ kind: "folder", id: "se" });
    expect(startView(FOLDERS, "inbox", "f0")).toEqual({ kind: "folder", id: "f0" });
    expect(startView(FOLDERS, "folder:gone")).toEqual({ kind: "folder", id: "in" });
    expect(startView(FOLDERS, "inbox", "archive")).toEqual({ kind: "folder", id: "in" });
    expect(startView([folder("x", null)], "inbox")).toEqual({ kind: "folder", id: "x" });
    expect(startView([], "inbox")).toBeNull();
  });

  it("hides Trash and Junk and gives folder views their pinned section", () => {
    expect(hiddenFolders(FOLDERS)).toEqual(["tr", "jk"]);
    const shown = { view: { kind: "folder" as const, id: "in" }, narrow: {}, search: null };
    expect(hasPinnedSection(shown)).toBe(true);
    expect(hasPinnedSection({ ...shown, search: { text: "x" } })).toBe(false);
    expect(hasPinnedSection({ view: { kind: "priority" }, narrow: {}, search: null })).toBe(false);
    expect(pinnedFilter(shown, [])).toEqual({
      operator: "AND",
      conditions: [{ inMailbox: "in" }, { hasKeyword: "$pinned" }],
    });
    expect(mainFilter(shown, [])).toEqual({
      operator: "AND",
      conditions: [{ inMailbox: "in" }, { notKeyword: "$pinned" }],
    });
    expect(listKey(shown, { grouping: "conversations", attachmentChips: false })).not.toBe(
      listKey(shown, { grouping: "messages", attachmentChips: false }),
    );
  });
});

describe("a list window", () => {
  it("chains query, get and thread sizes under one prefix and reads them back in order", () => {
    const calls = pageCalls("acc", { inMailbox: "in" }, 50, 25, { grouping: "conversations" }, "x-");
    expect(calls.map(([n, , id]) => `${n} ${id}`)).toEqual(["Email/query x-q", "Email/get x-g", "Thread/get x-t"]);
    expect(calls[1]?.[1]["#ids"]).toEqual({ resultOf: "x-q", name: "Email/query", path: "/ids" });
    expect(calls[2]?.[1]["#ids"]).toEqual({ resultOf: "x-g", name: "Email/get", path: "/list/*/threadId" });
    const res = new Map<string, Record<string, unknown>>([
      ["x-q", { ids: ["b", "a", "gone"], total: 3 }],
      [
        "x-g",
        {
          list: [
            { id: "a", threadId: "t" },
            { id: "b", threadId: "u" },
          ],
        },
      ],
      ["x-t", { list: [{ id: "t", emailIds: ["a", "c"] }] }],
    ]);
    const { total, rows } = pageRows(res, "conversations", "x-");
    expect(total).toBe(3);
    expect(rows.map((r) => [r.id, r.threadSize])).toEqual([
      ["b", 1],
      ["a", 2],
    ]);
    expect(pageRows(res, "messages", "x-").rows.every((r) => r.threadSize === 1)).toBe(true);
  });

  it("builds the first-load route URL", () => {
    expect(bootstrapUrl({ start: "inbox", grouping: "conversations", attachments: false })).toBe(
      "/api/webmail/bootstrap?start=inbox&grouping=conversations&chips=0",
    );
  });
});
