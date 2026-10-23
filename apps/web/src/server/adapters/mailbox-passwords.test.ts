// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { verifyMailboxPasswordGrant } from "@anhourmail/stalwart-client";

import { breachedPasswordsOff } from "@anhourmail/adapters/breached-passwords";

import { breachedPasswords } from "./breached-passwords";
import { mailboxPasswords } from "./mailbox-passwords";

describe("mailbox passwords adapter", () => {
  it("hashes to argon2id and signs a grant only when the key is configured", async () => {
    const key = "g".repeat(40);
    const p = mailboxPasswords(key, breachedPasswordsOff);
    const phc = await p.hash("correct horse battery staple");
    expect(phc).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    const grant = p.grant?.({ externalId: "abc", passwordHash: phc }) ?? "";
    expect(verifyMailboxPasswordGrant(key, grant, "abc", phc)).toBe(true);
    expect(verifyMailboxPasswordGrant(key, grant, "other", phc)).toBe(false);
    expect(
      mailboxPasswords(undefined, breachedPasswordsOff).grant?.({ externalId: "abc", passwordHash: phc }),
    ).toBeNull();
    expect(mailboxPasswords("  ", breachedPasswordsOff).grant?.({ externalId: "abc", passwordHash: phc })).toBeNull();
    expect(p.breaches).toBe(breachedPasswordsOff);
  });
});

describe("breached-password check by mode", () => {
  it("off accepts everything, fake answers from its list without the network", async () => {
    expect(await breachedPasswords("off").check("password1234")).toBe("unknown");
    const fake = breachedPasswords("fake");
    expect(await fake.check("password1234")).toBe("breached");
    expect(await fake.check("a-fresh-unlisted-passphrase")).toBe("clean");
  });

  it("on builds the range API adapter (not called here)", () => {
    const on = breachedPasswords("on");
    expect(on).not.toBe(breachedPasswordsOff);
    expect(typeof on.check).toBe("function");
  });
});
