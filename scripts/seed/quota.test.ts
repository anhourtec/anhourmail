// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { PLANS } from "@anhourmail/shared";

import { type AccountKey, ACCOUNTS, demoPeople } from "./people";
import { demoQuotaBytes, FAMILY_LIFECYCLE_MAILBOXES } from "./quota";

const GiB = 1024 ** 3;

describe("demo mailbox quotas", () => {
  it("give every demo mailbox a share that fits its account's pool", () => {
    const people = demoPeople("admin@anhourtec.test");
    for (const key of Object.keys(ACCOUNTS) as AccountKey[]) {
      const plan = ACCOUNTS[key].plan;
      const boxes =
        people.filter((p) => p.mailbox && p.account?.key === key).length +
        (key === "family" ? FAMILY_LIFECYCLE_MAILBOXES : 0);
      expect(boxes * demoQuotaBytes(plan)).toBeLessThanOrEqual(PLANS[plan].storagePoolGb * GiB);
    }
  });

  it("are small whole-GB shares, never the whole pool", () => {
    for (const plan of ["free", "supporter", "plus"] as const) {
      const share = demoQuotaBytes(plan);
      expect(share % GiB).toBe(0);
      expect(share).toBeGreaterThanOrEqual(GiB);
      expect(share).toBeLessThanOrEqual(2 * GiB);
    }
  });
});
