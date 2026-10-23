// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  accountStorage,
  defaultShareBytes,
  formatBytes,
  minQuotaBytes,
  poolFullMessage,
  poolSummary,
  storageCheckedAgo,
  storagePool,
  storageSummary,
} from "./storage";

const GB = 1024 ** 3;

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [-5, "0 B"],
    [Number.NaN, "0 B"],
    [512, "512 B"],
    [1023, "1023 B"],
    [1024, "1 KB"],
    [1500, "1 KB"],
    [12 * 1024, "12 KB"],
    [1024 ** 2, "1 MB"],
    [3.44 * 1024 ** 2, "3.4 MB"],
    [250 * 1024 ** 2, "250 MB"],
    [1023.9 * 1024 ** 2, "1023 MB"],
    [GB, "1 GB"],
    [1.2 * GB, "1.2 GB"],
    [30 * GB, "30 GB"],
    [1536 * GB, "1536 GB"],
  ])("%s bytes → %s", (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});

describe("storageSummary", () => {
  it("unknown when never measured: no numbers, no colour", () => {
    expect(storageSummary(null, 10 * GB)).toEqual({
      level: "unknown",
      used: null,
      quota: "10 GB",
      fraction: null,
      percent: null,
      label: null,
    });
  });

  it("empty mailbox: 0 B, 0%", () => {
    expect(storageSummary(0, 10 * GB)).toMatchObject({ level: "ok", used: "0 B", fraction: 0, percent: "0%" });
  });

  it("a little mail reads <1%, not 0%", () => {
    expect(storageSummary(4096, 10 * GB)).toMatchObject({ level: "ok", used: "4 KB", percent: "<1%" });
  });

  it("rounds the percentage down, and the levels follow the thresholds (with words, not only colour)", () => {
    expect(storageSummary(0.796 * 10 * GB, 10 * GB)).toMatchObject({ level: "ok", percent: "79%", label: null });
    expect(storageSummary(8 * GB, 10 * GB)).toMatchObject({ level: "warning", percent: "80%", label: "Getting full" });
    expect(storageSummary(9.5 * GB, 10 * GB)).toMatchObject({
      level: "critical",
      percent: "95%",
      label: "Almost full",
    });
    expect(storageSummary(1.2 * GB, 10 * GB)).toMatchObject({ used: "1.2 GB", quota: "10 GB", percent: "12%" });
  });

  it("at or over the quota: full, capped at 100%", () => {
    expect(storageSummary(10 * GB, 10 * GB)).toMatchObject({
      level: "full",
      percent: "100%",
      fraction: 1,
      label: "Full",
    });
    expect(storageSummary(12 * GB, 10 * GB)).toMatchObject({
      level: "full",
      used: "12 GB",
      percent: "100%",
      fraction: 1,
    });
  });

  it("a zero quota never divides by zero", () => {
    expect(storageSummary(0, 0)).toMatchObject({ level: "ok", fraction: 0, percent: "0%" });
    expect(storageSummary(5, 0)).toMatchObject({ level: "full", fraction: 1 });
  });
});

describe("storageCheckedAgo", () => {
  const now = new Date("2026-10-23T12:00:00Z");
  const ago = (ms: number) => storageCheckedAgo(new Date(now.getTime() - ms), now);
  it("says how long ago, in plain words", () => {
    expect(storageCheckedAgo(null, now)).toBeNull();
    expect(ago(0)).toBe("Updated just now");
    expect(ago(-60_000)).toBe("Updated just now"); // clock skew
    expect(ago(60_000)).toBe("Updated 1 minute ago");
    expect(ago(5 * 60_000)).toBe("Updated 5 minutes ago");
    expect(ago(60 * 60_000)).toBe("Updated 1 hour ago");
    expect(ago(47 * 3600_000)).toBe("Updated 47 hours ago");
    expect(ago(3 * 86_400_000)).toBe("Updated 3 days ago");
  });
});

describe("accountStorage", () => {
  it("adds up what has been measured; null until anything has", () => {
    expect(accountStorage([])).toEqual({ usedBytes: null, quotaBytes: 0, measured: 0, mailboxes: 0 });
    expect(
      accountStorage([
        { quotaBytes: 10 * GB, storageUsedBytes: null },
        { quotaBytes: 10 * GB, storageUsedBytes: null },
      ]),
    ).toEqual({ usedBytes: null, quotaBytes: 20 * GB, measured: 0, mailboxes: 2 });
    expect(
      accountStorage([
        { quotaBytes: 10 * GB, storageUsedBytes: 0 },
        { quotaBytes: 10 * GB, storageUsedBytes: GB },
        { quotaBytes: 1 * GB, storageUsedBytes: null },
      ]),
    ).toEqual({ usedBytes: GB, quotaBytes: 21 * GB, measured: 2, mailboxes: 3 });
  });
});

describe("storage pool", () => {
  it("adds up what is assigned and what is left (never negative)", () => {
    const boxes = [
      { quotaBytes: 4 * GB, storageUsedBytes: 2 * GB },
      { quotaBytes: 3 * GB, storageUsedBytes: null },
    ];
    expect(storagePool(10 * GB, boxes)).toEqual({
      poolBytes: 10 * GB,
      assignedBytes: 7 * GB,
      unassignedBytes: 3 * GB,
      usedBytes: 2 * GB,
    });
    expect(storagePool(1 * GB, boxes).unassignedBytes).toBe(0);
    expect(poolSummary(storagePool(10 * GB, [{ quotaBytes: 10 * GB, storageUsedBytes: 8.5 * GB }])).level).toBe(
      "warning",
    );
  });

  it("defaults a new mailbox to an even share of what is left over the remaining slots (whole GB, at least 1)", () => {
    expect(defaultShareBytes(10 * GB, 0, 10)).toBe(1 * GB);
    expect(defaultShareBytes(10 * GB, 8, 10)).toBe(5 * GB);
    expect(defaultShareBytes(10 * GB, 9, 10)).toBe(10 * GB);
    expect(defaultShareBytes(2 * GB, 2, 10)).toBe(1 * GB);
    expect(defaultShareBytes(3 * GB, 12, 10)).toBe(3 * GB); // beyond the included mailboxes: one slot
    expect(defaultShareBytes(1 * GB, 0, 1)).toBe(1 * GB);
    expect(defaultShareBytes(0.5 * GB, 0, 10)).toBe(0);
    expect(defaultShareBytes(-5, 0, 10)).toBe(0);
  });

  it("the least a quota can be: usage rounded up to the next GB, at least 1 GB", () => {
    expect(minQuotaBytes(null)).toBe(GB);
    expect(minQuotaBytes(0)).toBe(GB);
    expect(minQuotaBytes(5.3 * GB)).toBe(6 * GB);
    expect(minQuotaBytes(6 * GB)).toBe(6 * GB);
    expect(minQuotaBytes(Number.NaN)).toBe(GB);
  });

  it("says the pool is full in words", () => {
    expect(poolFullMessage(10 * GB)).toBe(
      "All 10 GB of this account's storage is assigned. Lower another mailbox's storage or add more.",
    );
  });
});
