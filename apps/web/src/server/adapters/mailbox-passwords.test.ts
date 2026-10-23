// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { verifyMailboxPasswordGrant } from "@anhourmail/stalwart-client";

import { mailboxPasswords } from "./mailbox-passwords";

describe("mailbox passwords adapter", () => {
  it("hashes to argon2id and signs a grant only when the key is configured", async () => {
    const key = "g".repeat(40);
    const p = mailboxPasswords(key);
    const phc = await p.hash("correct horse battery staple");
    expect(phc).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    const grant = p.grant?.({ externalId: "abc", passwordHash: phc }) ?? "";
    expect(verifyMailboxPasswordGrant(key, grant, "abc", phc)).toBe(true);
    expect(verifyMailboxPasswordGrant(key, grant, "other", phc)).toBe(false);
    expect(mailboxPasswords(undefined).grant?.({ externalId: "abc", passwordHash: phc })).toBeNull();
    expect(mailboxPasswords("  ").grant?.({ externalId: "abc", passwordHash: phc })).toBeNull();
  });
});
