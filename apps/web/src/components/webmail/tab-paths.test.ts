// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { mailboxTabHref } from "./tab-paths";

describe("the address-scoped page of a shared mailbox", () => {
  it("keeps the @, lowercases the address and adds the folder when given", () => {
    expect(mailboxTabHref("", " Desk@Family.test ")).toBe("/mailbox/desk@family.test");
    expect(mailboxTabHref("/webmail", "desk@family.test", "sent")).toBe("/webmail/mailbox/desk@family.test/sent");
  });

  it("encodes anything else that could change the path", () => {
    expect(mailboxTabHref("", "a/b?c#d@x.test")).toBe("/mailbox/a%2Fb%3Fc%23d@x.test");
  });
});
