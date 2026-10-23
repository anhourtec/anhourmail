// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import {
  ARGON2ID_PHC,
  MAILBOX_PASSWORD_GRANT_MAX_SEC,
  mailboxPasswordGrant,
  verifyMailboxPasswordGrant,
} from "./management";

const KEY = "k".repeat(48);
const PHC = `$argon2id$v=19$m=19456,t=2,p=1$${"s".repeat(22)}$${"h".repeat(43)}`;
const NOW = Date.UTC(2026, 9, 23, 12);

describe("mailbox password grants", () => {
  it("binds the account, the exact hash and an expiry at most an hour ahead", () => {
    const g = mailboxPasswordGrant(KEY, "abc", PHC, NOW);
    expect(g).toMatch(/^\d+\.[0-9a-f]{64}$/);
    expect(Number(g.split(".")[0])).toBe(NOW / 1000 + MAILBOX_PASSWORD_GRANT_MAX_SEC);
    expect(verifyMailboxPasswordGrant(KEY, g, "abc", PHC, NOW)).toBe(true);
    expect(verifyMailboxPasswordGrant(KEY, g, "abd", PHC, NOW)).toBe(false);
    expect(verifyMailboxPasswordGrant(KEY, g, "abc", `${PHC}x`, NOW)).toBe(false);
    expect(verifyMailboxPasswordGrant("other".repeat(10), g, "abc", PHC, NOW)).toBe(false);
    expect(verifyMailboxPasswordGrant(KEY, g, "abc", PHC, NOW + 3601_000)).toBe(false);
    // A far-future expiry (made with the key, but not by us) is refused too.
    const [, mac] = g.split(".");
    expect(verifyMailboxPasswordGrant(KEY, `${String(NOW / 1000 + 7200)}.${mac ?? ""}`, "abc", PHC, NOW)).toBe(false);
    for (const bad of ["", "x.y", `${String(NOW / 1000)}.${"0".repeat(63)}`]) {
      expect(verifyMailboxPasswordGrant(KEY, bad, "abc", PHC, NOW)).toBe(false);
    }
  });

  it("accepts only argon2id at the pinned parameters with bounded salt and hash", () => {
    expect(ARGON2ID_PHC.test(PHC)).toBe(true);
    for (const bad of [
      PHC.replace("m=19456", "m=1024"),
      PHC.replace("t=2", "t=1"),
      PHC.replace("argon2id", "argon2i"),
      `$argon2id$v=19$m=19456,t=2,p=1$${"s".repeat(8)}$${"h".repeat(43)}`,
      `$argon2id$v=19$m=19456,t=2,p=1$${"s".repeat(22)}$${"h".repeat(129)}`,
      "plaintext-password",
    ]) {
      expect(ARGON2ID_PHC.test(bad)).toBe(false);
    }
  });
});
