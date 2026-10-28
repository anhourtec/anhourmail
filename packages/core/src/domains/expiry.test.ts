// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { customerDomainRecords } from "@anhourmail/shared/dns";
import { PENDING_DOMAIN } from "@anhourmail/shared/plans";

import { ACCOUNT_A, deps as makeDeps, fixedClock, TEST_PLATFORM } from "../__tests__/helpers";
import type { DnsResolver } from "./dns";
import type { CustomerDomain } from "./entity";
import { expirePendingDomains } from "./expiry";

const DAY = 86_400_000;
const NOW = new Date("2026-10-21T12:00:00Z");

/** A resolver answering the ownership and MX records of the names listed, and failing for those in `failing`. */
function resolver(published: CustomerDomain[], failing: string[] = []): DnsResolver {
  return {
    async lookup(type, fqdn) {
      const d = published.find((x) => fqdn === x.name || fqdn.endsWith(`.${x.name}`));
      if (failing.some((n) => fqdn === n || fqdn.endsWith(`.${n}`))) throw new Error("SERVFAIL");
      if (!d) return [];
      return customerDomainRecords(d.name, d.verifyToken, TEST_PLATFORM)
        .filter((r) => r.type === type && (r.name === "@" ? d.name : `${r.name}.${d.name}`) === fqdn)
        .map((r) => (r.type === "MX" ? `${String(r.priority)} ${r.value}` : r.value));
    },
  };
}

function setup() {
  const d = makeDeps(fixedClock(NOW.toISOString()));
  d.uow.state.accounts.push({ id: ACCOUNT_A, name: "A", plan: "plus" });
  let n = 0;
  const add = (
    name: string,
    ageDays: number,
    onMailServer: boolean,
    status: CustomerDomain["status"] = "pending_dns",
  ) => {
    n += 1;
    const row: CustomerDomain = {
      id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      accountId: ACCOUNT_A,
      name,
      status,
      verifyToken: `token${String(n)}`,
      stalwartId: onMailServer ? `dom:${name}` : null,
      lastError: null,
      dkimKeys: null,
      createdAt: new Date(NOW.getTime() - ageDays * DAY),
    };
    d.uow.state.domains.push(row);
    return row;
  };
  const row = (id: string) => d.uow.state.domains.find((x) => x.id === id);
  return { d, add, row };
}

describe("pending domain expiry", () => {
  it(`deletes unverified domains off the mail server after ${String(PENDING_DOMAIN.unverifiedDays)} days, audited in their account`, async () => {
    const { d, add, row } = setup();
    const old = add("old.example.ca", PENDING_DOMAIN.unverifiedDays + 1, false);
    const young = add("young.example.ca", PENDING_DOMAIN.unverifiedDays - 1, false);
    const active = add("live.example.ca", PENDING_DOMAIN.unverifiedDays + 5, false, "active");
    expect(await expirePendingDomains(d, resolver([]))).toEqual({ expired: 1, released: 0, failed: 0 });
    expect(row(old.id)).toBeUndefined();
    expect(row(young.id)).toBeDefined();
    expect(row(active.id)?.status).toBe("active");
    expect(d.uow.state.jobs).toEqual([]); // never on the mail server: nothing to take off
    expect(d.uow.state.audit).toHaveLength(1);
    expect(d.uow.state.audit[0]).toMatchObject({
      scope: `account:${ACCOUNT_A}`,
      action: "domain.expired",
      result: "success",
      actor: { type: "system", email: "domain-expiry" },
      target: { id: old.id, label: "old.example.ca" },
      meta: { reason: "not_verified_in_time", onMailServer: false },
    });
  });

  it(`takes pending domains off the mail server once ${String(PENDING_DOMAIN.onMailServerDays)} days pass unverified`, async () => {
    const { d, add, row } = setup();
    const late = add("late.example.ca", PENDING_DOMAIN.onMailServerDays + 1, true);
    const fresh = add("fresh.example.ca", PENDING_DOMAIN.onMailServerDays - 1, true);
    // Both still publish their records: only age decides.
    const out = await expirePendingDomains(d, resolver([late, fresh]));
    expect(out).toEqual({ expired: 1, released: 0, failed: 0 });
    expect(row(late.id)?.status).toBe("removing");
    expect(row(fresh.id)?.status).toBe("pending_dns");
    expect(d.uow.state.jobs).toEqual([expect.objectContaining({ kind: "domain.remove", subjectId: late.id })]);
    expect(d.uow.state.audit).toEqual([
      expect.objectContaining({
        action: "domain.expired",
        scope: `account:${ACCOUNT_A}`,
        meta: { reason: "not_verified_in_time", onMailServer: true },
      }),
    ]);
  });

  it("releases a pending domain on the mail server whose ownership or MX record is gone, never on a failed lookup", async () => {
    const { d, add, row } = setup();
    const kept = add("kept.example.ca", 2, true);
    const noTxt = add("notxt.example.ca", 2, true);
    const noMx = add("nomx.example.ca", 2, true);
    const flaky = add("flaky.example.ca", 2, true);
    const dns = resolver([kept, { ...noTxt, verifyToken: "someone-else" }, flaky], ["flaky.example.ca"]);
    // nomx: nothing at all published (MX gone with it).
    const out = await expirePendingDomains(d, dns);
    expect(out).toEqual({ expired: 0, released: 2, failed: 0 });
    expect(row(kept.id)?.status).toBe("pending_dns");
    expect(row(flaky.id)?.status).toBe("pending_dns");
    expect(row(noTxt.id)?.status).toBe("removing");
    expect(row(noMx.id)?.status).toBe("removing");
    expect(d.uow.state.audit.map((e) => [e.action, e.target.label, e.meta])).toEqual([
      ["domain.released", "notxt.example.ca", { reason: "records_not_found", onMailServer: true }],
      ["domain.released", "nomx.example.ca", { reason: "records_not_found", onMailServer: true }],
    ]);
  });

  it("an MX moved elsewhere releases the claim even with the ownership record still there", async () => {
    const { d, add, row } = setup();
    const moved = add("moved.example.ca", 2, true);
    const base = resolver([moved]);
    const dns: DnsResolver = {
      lookup: async (type, fqdn) => (type === "MX" ? ["10 mx.elsewhere.example."] : base.lookup(type, fqdn)),
    };
    expect(await expirePendingDomains(d, dns)).toEqual({ expired: 0, released: 1, failed: 0 });
    expect(row(moved.id)?.status).toBe("removing");
  });

  it("counts a domain that changed meanwhile as failed (audited) and carries on", async () => {
    const { d, add, row } = setup();
    const raced = add("raced.example.ca", PENDING_DOMAIN.unverifiedDays + 1, false);
    const other = add("other.example.ca", PENDING_DOMAIN.onMailServerDays + 1, true);
    // A check moved it onto the mail server between the listing and the deletion.
    const run = d.uow.run.bind(d.uow);
    d.uow.run = (fn) =>
      run((r) =>
        fn({
          ...r,
          domains: {
            ...r.domains,
            deletePending: async (id) => {
              row(id)!.stalwartId = "dom:raced.example.ca";
              return r.domains.deletePending(id);
            },
          },
        }),
      );
    expect(await expirePendingDomains(d, resolver([]))).toEqual({ expired: 1, released: 0, failed: 1 });
    expect(row(raced.id)?.status).toBe("pending_dns");
    expect(row(other.id)?.status).toBe("removing");
    expect(d.uow.state.audit.map((e) => [e.action, e.result])).toEqual([
      ["domain.expired", "failed"],
      ["domain.expired", "success"],
    ]);
  });

  it("stops when the run's time budget is spent", async () => {
    const { d, add } = setup();
    add("a.example.ca", PENDING_DOMAIN.unverifiedDays + 1, false);
    add("b.example.ca", PENDING_DOMAIN.onMailServerDays + 1, true);
    expect(await expirePendingDomains(d, resolver([]), { batch: 10, budgetMs: -1 })).toEqual({
      expired: 0,
      released: 0,
      failed: 0,
    });
  });
});
