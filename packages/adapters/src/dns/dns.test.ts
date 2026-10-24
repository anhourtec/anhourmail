// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { checkRecords, requiredPass } from "@anhourmail/core/domains";
import { platformFacts } from "@anhourmail/shared/platform";

import { devResolver } from "./index";

const platform = platformFacts("platform-mail.test");
const none = { lookup: () => Promise.resolve([]) };

describe("devResolver", () => {
  it("answers every required record for a .test domain, DKIM keys included", async () => {
    const dns = devResolver(none, () => Promise.resolve(["tok"]), platform);
    const records = await checkRecords(dns, "family.test", "tok", platform);
    expect(requiredPass(records)).toBe(true);
    expect(records.filter((r) => r.purpose === "dkim").every((r) => r.state === "ok")).toBe(true);
  });

  it("answers nothing for unverified- domains", async () => {
    const dns = devResolver(none, () => Promise.resolve(["tok"]), platform);
    const records = await checkRecords(dns, "unverified-x.test", "tok", platform);
    expect(records.filter((r) => r.purpose === "dkim").every((r) => r.state === "missing")).toBe(true);
  });
});
