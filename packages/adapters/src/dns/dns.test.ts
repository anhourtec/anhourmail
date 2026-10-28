// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { checkRecords, requiredPass } from "@anhourmail/core/domains";
import { platformFacts } from "@anhourmail/shared/platform";

import { devResolver } from "./index";

const platform = platformFacts("platform-mail.test");
const none = { lookup: () => Promise.resolve([]) };
const keys = [
  {
    selector: "v1-ed25519-20261028",
    value: "v=DKIM1; k=ed25519; h=sha256; p=T5HnScT90Bl3e6wOsAR2tTVmRw1MPWtI1rTOoxMB4dY=",
  },
  {
    selector: "v1-rsa-20261028",
    value: "v=DKIM1; k=rsa; h=sha256; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxXpp",
  },
];

describe("devResolver", () => {
  it("answers every required record for a .test domain, its DKIM keys included", async () => {
    const dns = devResolver(none, () => Promise.resolve([{ verifyToken: "tok", dkimKeys: keys }]), platform);
    const records = await checkRecords(dns, "family.test", "tok", platform, keys);
    expect(requiredPass(records)).toBe(true);
    expect(records.filter((r) => r.purpose === "dkim").map((r) => r.state)).toEqual(["ok", "ok"]);
  });

  it("can't pass DKIM before the mail server has made the keys", async () => {
    const dns = devResolver(none, () => Promise.resolve([{ verifyToken: "tok", dkimKeys: null }]), platform);
    const records = await checkRecords(dns, "family.test", "tok", platform, null);
    expect(records.filter((r) => r.purpose !== "dkim" && r.required).every((r) => r.state === "ok")).toBe(true);
    expect(records.filter((r) => r.purpose === "dkim")).toMatchObject([{ placeholder: true, state: "missing" }]);
    expect(requiredPass(records)).toBe(false);
  });

  it("answers nothing for unverified- domains", async () => {
    const dns = devResolver(none, () => Promise.resolve([{ verifyToken: "tok", dkimKeys: keys }]), platform);
    const records = await checkRecords(dns, "unverified-x.test", "tok", platform, keys);
    expect(records.filter((r) => r.purpose === "dkim").every((r) => r.state === "missing")).toBe(true);
  });

  it("sends other names to the real resolver", async () => {
    const asked: string[] = [];
    const fallback = { lookup: (_t: string, fqdn: string) => (asked.push(fqdn), Promise.resolve(["x"])) };
    const dns = devResolver(fallback, () => Promise.resolve([]), platform);
    expect(await dns.lookup("TXT", "example.org")).toEqual(["x"]);
    expect(asked).toEqual(["example.org"]);
  });
});
