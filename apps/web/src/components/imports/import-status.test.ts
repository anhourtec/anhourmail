// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import type { ImportFolderView } from "@anhourmail/core/imports";

import { folderRows } from "./import-detail";
import { importPercent, importStatus } from "./import-status";

const base = { phase: null, pauseRequested: false, blockedReason: null, errorCode: null } as const;
const folder = (o: Partial<ImportFolderView>): ImportFolderView => ({
  id: "f",
  role: null,
  name: null,
  status: "done",
  messagesTotal: 1,
  messagesDone: 1,
  duplicates: 0,
  tooLarge: 0,
  failed: 0,
  ...o,
});

describe("import status labels", () => {
  it("names each state, the phase, a pause asked for and why it waits", () => {
    expect(importStatus({ ...base, status: "queued" })).toEqual({ label: "Waiting to start", tone: "info" });
    expect(importStatus({ ...base, status: "running", phase: "verifying" }).label).toBe("Checking the old mailbox");
    expect(importStatus({ ...base, status: "running", phase: "copying" }).label).toBe("Copying");
    expect(importStatus({ ...base, status: "running", pauseRequested: true }).label).toBe("Pausing…");
    expect(importStatus({ ...base, status: "blocked", blockedReason: "quota_full" })).toEqual({
      label: "Needs you: the mailbox is full",
      tone: "warning",
    });
    expect(importStatus({ ...base, status: "syncing" }).label).toBe("Copying new mail");
    expect(importStatus({ ...base, status: "completed" })).toEqual({ label: "Finished", tone: "success" });
    expect(importStatus({ ...base, status: "completed", errorCode: "message_cap" }).label).toBe("Finished early");
    expect(importStatus({ ...base, status: "cancelled", pauseRequested: true }).label).toBe("Cancelled");
    expect(importStatus({ ...base, status: "failed" }).tone).toBe("danger");
  });

  it("counts skipped and refused messages as handled, and is unknown before the total", () => {
    const p = { messagesTotal: 10, messagesDone: 4, duplicates: 1, tooLarge: 0, failed: 0, status: "running" as const };
    expect(importPercent(p)).toBe(50);
    expect(importPercent({ ...p, messagesTotal: 0 })).toBeNull();
    expect(importPercent({ ...p, messagesTotal: 0, status: "blocked" })).toBe(0);
    expect(importPercent({ ...p, status: "syncing" })).toBe(100);
    expect(importPercent({ ...p, status: "completed", messagesTotal: 0 })).toBe(100);
  });
});

describe("folderRows", () => {
  it("sums custom folders without names into one row and drops empty parents", () => {
    const rows = folderRows([
      folder({ id: "i", role: "inbox", messagesTotal: 5, messagesDone: 4, duplicates: 1 }),
      folder({ id: "p", messagesTotal: 0, messagesDone: 0 }),
      folder({ id: "a", messagesTotal: 2, messagesDone: 2 }),
      folder({ id: "b", messagesTotal: 1, messagesDone: 0, tooLarge: 1 }),
      folder({ id: "j", role: "junk", status: "skipped", messagesTotal: 0, messagesDone: 0 }),
      folder({ id: "n", name: "Projects/Q1" }),
    ]);
    expect(rows.map((r) => [r.id, r.messagesDone, r.tooLarge])).toEqual([
      ["i", 4, 0],
      ["j", 0, 0],
      ["n", 1, 0],
      ["other", 2, 1],
    ]);
  });
});
