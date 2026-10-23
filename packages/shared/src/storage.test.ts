// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { accountStorage, formatBytes, storageCheckedAgo, storageSummary } from "./storage";

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
