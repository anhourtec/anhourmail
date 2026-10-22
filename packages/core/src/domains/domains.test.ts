// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { customerDomainRecords, SPF_INCLUDE } from "@anhourmail/shared/dns";

import { ACCOUNT_A, ACCOUNT_B, anonymous, deps as makeDeps, fixedClock, req, user } from "../__tests__/helpers";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PlanLimitError,
  UnauthenticatedError,
  ValidationError,
} from "../errors";
import { checkRecords, type DnsResolver, type LookupType, matches } from "./dns";
import { normaliseDomain } from "./entity";
import {
  AUTO_RECHECK_MS,
  addDomain,
  checkDomain,
  getDomain,
  listDomains,
  recheckPendingDomains,
  removeDomain,
} from "./service";

const owner = user({ id: "owner", account: [[ACCOUNT_A, "owner"]] });
const domainAdmin = user({ id: "dadmin", account: [[ACCOUNT_A, "domain_admin"]] });
const userAdmin = user({ id: "uadmin", account: [[ACCOUNT_A, "user_admin"]] });
const member = user({ id: "member", account: [[ACCOUNT_A, "member"]] });
const ownerB = user({ id: "owner-b", account: [[ACCOUNT_B, "owner"]] });

/** A resolver serving whatever the test publishes. */
function zone(): DnsResolver & { publish(type: LookupType, fqdn: string, ...values: string[]): void; fail: boolean } {
  const records = new Map<string, string[]>();
  return {
    fail: false,
    publish(type, fqdn, ...values) {
      records.set(`${type} ${fqdn}`, values);
    },
    async lookup(type, fqdn) {
      if (this.fail) throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
      return records.get(`${type} ${fqdn}`) ?? [];
    },
  };
}

/** Publishes every required record for `domain`, exactly as the template says. */
function publishAll(z: ReturnType<typeof zone>, domain: string, token: string) {
  for (const r of customerDomainRecords(domain, token).filter((x) => x.required)) {
    const fqdn = r.name === "@" ? domain : `${r.name}.${domain}`;
    z.publish(r.type, fqdn, r.type === "MX" ? `${String(r.priority)} ${r.value}` : r.value);
  }
}

function setup() {
  const d = makeDeps(fixedClock("2026-10-21T12:00:00Z"));
  d.uow.state.accounts.push({ id: ACCOUNT_A, name: "A", plan: "plus" }, { id: ACCOUNT_B, name: "B", plan: "free" });
  return d;
}

describe("normaliseDomain", () => {
  it("lowercases, trims, drops the trailing dot and converts IDNs", () => {
    expect(normaliseDomain("  Family.CA. ")).toBe("family.ca");
    expect(normaliseDomain("bücher.example.ca")).toBe("xn--bcher-kva.example.ca");
  });

  it("refuses junk, IPs, single labels and our own domains", () => {
    for (const bad of [
      undefined,
      "",
      "localhost",
      "foo",
      "1.2.3.4",
      "-bad.org",
      "a..b",
      "anhourmail.com",
      "x.anhourtec.com",
    ]) {
      expect(() => normaliseDomain(bad)).toThrow(ValidationError);
    }
  });
});

describe("record matching", () => {
  it("accepts our SPF include merged into the customer's own record, and any DMARC policy", () => {
    const [spf, dmarc] = ["spf", "dmarc"].map((p) => customerDomainRecords("x.org", "t").find((r) => r.purpose === p)!);
    expect(matches(spf!, `v=spf1 include:_spf.google.com include:${SPF_INCLUDE} -all`)).toBe(true);
    expect(matches(spf!, "v=spf1 include:_spf.google.com -all")).toBe(false);
    expect(matches(dmarc!, "v=DMARC1; p=reject")).toBe(true);
  });

  it("ignores MX priority and SRV weight but not hosts or ports", () => {
    const records = customerDomainRecords("x.org", "t");
    const mx = records.find((r) => r.purpose === "inbound")!;
    const srv = records.find((r) => r.name === "_imaps._tcp")!;
    expect(matches(mx, `20 ${mx.value.toUpperCase()}`)).toBe(true);
    expect(matches(mx, "10 mx.elsewhere.example.")).toBe(false);
    const [, , port, target] = srv.value.split(" ");
    expect(matches(srv, `5 50 ${port ?? ""} ${target ?? ""}`)).toBe(true);
    expect(matches(srv, `0 1 143 ${target ?? ""}`)).toBe(false);
  });

  it("grades missing, wrong and failed lookups", async () => {
    const z = zone();
    z.publish("MX", "x.org", "10 mx.elsewhere.example.");
    const graded = await checkRecords(z, "x.org", "t");
    expect(graded.find((r) => r.purpose === "inbound")?.state).toBe("wrong");
    expect(graded.find((r) => r.purpose === "ownership")?.state).toBe("missing");
    z.fail = true;
    expect((await checkRecords(z, "x.org", "t")).every((r) => r.state === "error")).toBe(true);
  });
});

describe("domains service", () => {
  it("adds a domain (audited) and shows it with its records to readers", async () => {
    const d = setup();
    const added = await addDomain(d, domainAdmin, ACCOUNT_A, { name: "Family.example.ca" }, req);
    expect(added).toMatchObject({ name: "family.example.ca", status: "pending_dns", provisioned: false });
    expect(added.records.find((r) => r.purpose === "ownership")?.value).toMatch(/^anhourmail-verify=[0-9a-f]{32}$/);
    expect(d.uow.state.audit.at(-1)).toMatchObject({ action: "domain.added", result: "success" });
    expect(await listDomains(d, userAdmin, ACCOUNT_A)).toHaveLength(1);
    expect((await getDomain(d, userAdmin, ACCOUNT_A, added.id)).records.length).toBeGreaterThan(5);
  });

  it("refuses free plans, duplicates and the 21st domain", async () => {
    const d = setup();
    await expect(addDomain(d, ownerB, ACCOUNT_B, { name: "b.example.ca" }, req)).rejects.toThrow(PlanLimitError);
    await addDomain(d, owner, ACCOUNT_A, { name: "a.example.ca" }, req);
    await expect(addDomain(d, owner, ACCOUNT_A, { name: "A.example.ca." }, req)).rejects.toThrow(ConflictError);
    for (let i = 0; i < 19; i++) await addDomain(d, owner, ACCOUNT_A, { name: `n${String(i)}.example.ca` }, req);
    await expect(addDomain(d, owner, ACCOUNT_A, { name: "one-more.example.ca" }, req)).rejects.toThrow(PlanLimitError);
  });

  it("enforces permission and account scope (403 inside, 404 outside, 401 signed out) and audits refusals", async () => {
    const d = setup();
    const { id } = await addDomain(d, owner, ACCOUNT_A, { name: "a.example.ca" }, req);
    await expect(addDomain(d, member, ACCOUNT_A, { name: "m.example.ca" }, req)).rejects.toThrow(ForbiddenError);
    await expect(addDomain(d, userAdmin, ACCOUNT_A, { name: "m.example.ca" }, req)).rejects.toThrow(ForbiddenError);
    await expect(listDomains(d, member, ACCOUNT_A)).rejects.toThrow(ForbiddenError);
    await expect(listDomains(d, ownerB, ACCOUNT_A)).rejects.toThrow(NotFoundError);
    await expect(getDomain(d, ownerB, ACCOUNT_A, id)).rejects.toThrow(NotFoundError);
    await expect(getDomain(d, owner, ACCOUNT_A, "not-an-id")).rejects.toThrow(NotFoundError);
    await expect(removeDomain(d, ownerB, ACCOUNT_B, id, req)).rejects.toThrow(NotFoundError);
    await expect(checkDomain(d, zone(), anonymous, ACCOUNT_A, id, req)).rejects.toThrow(UnauthenticatedError);
    await expect(checkDomain(d, zone(), userAdmin, ACCOUNT_A, id, req)).rejects.toThrow(ForbiddenError);
    const denied = d.uow.state.audit.filter((e) => e.result === "denied").map((e) => e.action);
    expect(denied).toEqual(expect.arrayContaining(["domain.added", "domain.verified"]));
    // Another account's domain id inside your own account: not found, audited as a failed removal.
    expect(d.uow.state.audit.filter((e) => e.action === "domain.removed").map((e) => e.result)).toEqual(["failed"]);
  });

  it("activates once every required record passes, queues provisioning, and audits failed checks", async () => {
    const d = setup();
    const z = zone();
    const added = await addDomain(d, owner, ACCOUNT_A, { name: "a.example.ca" }, req);
    const token = d.uow.state.domains[0]!.verifyToken;

    const first = await checkDomain(d, z, owner, ACCOUNT_A, added.id, req);
    expect(first.activated).toBe(false);
    expect(d.uow.state.audit.at(-1)).toMatchObject({ action: "domain.verify_failed" });

    publishAll(z, "a.example.ca", token);
    const second = await checkDomain(d, z, owner, ACCOUNT_A, added.id, req);
    expect(second).toMatchObject({ activated: true, domain: { status: "active" } });
    expect(second.records.filter((r) => !r.required).every((r) => r.state === "missing")).toBe(true);
    expect(d.uow.state.jobs).toEqual([expect.objectContaining({ kind: "domain.ensure", subjectId: added.id })]);
    expect(d.uow.state.audit.at(-1)).toMatchObject({ action: "domain.verified", result: "success" });

    // Checking an active domain reports the records and changes nothing.
    expect((await checkDomain(d, z, owner, ACCOUNT_A, added.id, req)).activated).toBe(false);
    expect(d.uow.state.jobs).toHaveLength(1);
  });

  it("lets two accounts add the same unverified domain; the verified owner wins and blocks later claims", async () => {
    const d = setup();
    d.uow.state.accounts.find((a) => a.id === ACCOUNT_B)!.plan = "plus";
    const z = zone();
    const mine = await addDomain(d, owner, ACCOUNT_A, { name: "shared.example.ca" }, req);
    const squat = await addDomain(d, ownerB, ACCOUNT_B, { name: "shared.example.ca" }, req);
    publishAll(z, "shared.example.ca", d.uow.state.domains.find((x) => x.id === mine.id)!.verifyToken);
    expect((await checkDomain(d, z, ownerB, ACCOUNT_B, squat.id, req)).activated).toBe(false);
    expect((await checkDomain(d, z, owner, ACCOUNT_A, mine.id, req)).activated).toBe(true);
    const later = user({ id: "c", account: [[ACCOUNT_B, "owner"]] });
    await removeDomain(d, later, ACCOUNT_B, squat.id, req);
    await expect(addDomain(d, later, ACCOUNT_B, { name: "shared.example.ca" }, req)).rejects.toThrow(ConflictError);
  });

  it("removes a pending domain at once, marks an active one for the worker, and refuses while addresses use it", async () => {
    const d = setup();
    const z = zone();
    const pending = await addDomain(d, owner, ACCOUNT_A, { name: "p.example.ca" }, req);
    expect(await removeDomain(d, owner, ACCOUNT_A, pending.id, req)).toEqual({ status: "removed" });
    expect(d.uow.state.domains).toHaveLength(0);

    const active = await addDomain(d, owner, ACCOUNT_A, { name: "a.example.ca" }, req);
    publishAll(z, "a.example.ca", d.uow.state.domains[0]!.verifyToken);
    await checkDomain(d, z, owner, ACCOUNT_A, active.id, req);
    d.uow.state.mailboxes.push({
      id: "m1",
      accountId: "a1",
      userId: null,
      createdAt: new Date(0),
      address: "me@a.example.ca",
      quotaBytes: 1,
      status: "active",
      stalwartId: null,
      lastError: null,
      purgeAfter: null,
    });
    await expect(removeDomain(d, owner, ACCOUNT_A, active.id, req)).rejects.toThrow(ConflictError);
    d.uow.state.mailboxes = [];
    expect(await removeDomain(d, owner, ACCOUNT_A, active.id, req)).toEqual({ status: "removing" });
    expect(d.uow.state.jobs.at(-1)).toMatchObject({ kind: "domain.remove", subjectId: active.id });
    await expect(removeDomain(d, owner, ACCOUNT_A, active.id, req)).rejects.toThrow(ConflictError);
  });

  it("re-checks recent pending domains on a schedule and activates fixed ones without auditing failures", async () => {
    const d = setup();
    const clock = fixedClock("2026-10-21T12:00:00Z");
    d.clock = clock;
    const z = zone();
    const old = await addDomain(d, owner, ACCOUNT_A, { name: "old.example.ca" }, req);
    clock.set(new Date(clock.now().getTime() + AUTO_RECHECK_MS + 1000));
    const fresh = await addDomain(d, owner, ACCOUNT_A, { name: "fresh.example.ca" }, req);
    const tokenOf = (id: string) => d.uow.state.domains.find((x) => x.id === id)!.verifyToken;
    publishAll(z, "old.example.ca", tokenOf(old.id));
    const auditBefore = d.uow.state.audit.length;

    expect(await recheckPendingDomains(d, z)).toBe(0);
    expect(d.uow.state.audit.length).toBe(auditBefore);

    publishAll(z, "fresh.example.ca", tokenOf(fresh.id));
    expect(await recheckPendingDomains(d, z)).toBe(1);
    expect(d.uow.state.domains.find((x) => x.id === fresh.id)?.status).toBe("active");
    expect(d.uow.state.domains.find((x) => x.id === old.id)?.status).toBe("pending_dns");
    expect(d.uow.state.audit.at(-1)).toMatchObject({ action: "domain.verified", actor: { type: "system" } });
  });
});

describe("inspectDomain", () => {
  it("shows live record states to readers without changing or auditing anything", async () => {
    const { inspectDomain } = await import("./service");
    const d = setup();
    const z = zone();
    const added = await addDomain(d, owner, ACCOUNT_A, { name: "a.example.ca" }, req);
    publishAll(z, "a.example.ca", d.uow.state.domains[0]!.verifyToken);
    const audit = d.uow.state.audit.length;
    const out = await inspectDomain(d, z, userAdmin, ACCOUNT_A, added.id);
    expect(out.records.filter((r) => r.required).every((r) => r.state === "ok")).toBe(true);
    expect(out.domain.status).toBe("pending_dns");
    expect(d.uow.state.audit.length).toBe(audit);
    await expect(inspectDomain(d, z, member, ACCOUNT_A, added.id)).rejects.toThrow(ForbiddenError);
    await expect(inspectDomain(d, z, ownerB, ACCOUNT_A, added.id)).rejects.toThrow(NotFoundError);
  });
});

describe("domainAllowance", () => {
  it("follows the plan and requires domain.read", async () => {
    const { domainAllowance } = await import("./service");
    const d = setup();
    expect(await domainAllowance(d, userAdmin, ACCOUNT_A)).toEqual({ allowed: true, max: 20 });
    expect((await domainAllowance(d, ownerB, ACCOUNT_B)).allowed).toBe(false);
    await expect(domainAllowance(d, member, ACCOUNT_A)).rejects.toThrow(ForbiddenError);
  });
});

describe("recheck fairness", () => {
  it("takes at most a few domains per account per run, so one account can't starve the others", async () => {
    const { recheckPendingDomains } = await import("./service");
    const d = setup();
    d.uow.state.accounts.find((a) => a.id === ACCOUNT_B)!.plan = "plus";
    const z = zone();
    for (let i = 0; i < 8; i++) await addDomain(d, owner, ACCOUNT_A, { name: `a${String(i)}.example.ca` }, req);
    const b = await addDomain(d, ownerB, ACCOUNT_B, { name: "b.example.ca" }, req);
    for (const x of d.uow.state.domains) publishAll(z, x.name, x.verifyToken);
    expect(await recheckPendingDomains(d, z, { total: 50, perAccount: 5, budgetMs: 60_000 })).toBe(6);
    expect(d.uow.state.domains.find((x) => x.id === b.id)?.status).toBe("active");
    expect(d.uow.state.domains.filter((x) => x.accountId === ACCOUNT_A && x.status === "active")).toHaveLength(5);
  });
});
