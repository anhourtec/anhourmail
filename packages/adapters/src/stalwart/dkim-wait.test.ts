// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from "vitest";

import type { StalwartManagement } from "@anhourmail/stalwart-client";

import { stalwartMailServer } from ".";

const ED = { selector: "v1-ed25519-20261028", value: "v=DKIM1; k=ed25519; h=sha256; p=ed" };
const RSA = { selector: "v1-rsa-20261028", value: "v=DKIM1; k=rsa; h=sha256; p=MIIB" };

/** A management client whose zone file lists `answers` in turn (the last one repeats), for domain `dom-1`. */
function fake(answers: (typeof ED)[][], exists = true) {
  let reads = 0;
  const mgmt = {
    domainDkimRecords: async () => answers[Math.min(reads++, answers.length - 1)] ?? [],
    listDomains: async () => (exists ? [{ id: "dom-1", name: "new.example.ca" }] : []),
  };
  return { mail: stalwartMailServer(mgmt as unknown as StalwartManagement), reads: () => reads };
}

describe("reading a new domain's DKIM keys", () => {
  it("waits for the RSA key even while the zone file lists no key yet", async () => {
    const f = fake([[], [ED], [ED, RSA]]);
    expect(await f.mail.domainDkimKeys("dom-1")).toEqual([ED, RSA]);
    expect(f.reads()).toBe(3);
  });

  it("answers at once for a domain that is gone", async () => {
    const f = fake([[]], false);
    expect(await f.mail.domainDkimKeys("dom-1")).toEqual([]);
    expect(f.reads()).toBe(1);
  });

  it("returns what it has once the wait is over (the job retries)", async () => {
    vi.useFakeTimers();
    try {
      const f = fake([[ED]]);
      const keys = f.mail.domainDkimKeys("dom-1");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await keys).toEqual([ED]);
      expect(f.reads()).toBe(21);
    } finally {
      vi.useRealTimers();
    }
  });
});
