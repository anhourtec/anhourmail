// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { customerDomainRecords } from "@anhourmail/shared/dns";

import {
  ACCOUNT_A,
  ACCOUNT_B,
  anonymous,
  deps as makeDeps,
  fixedClock,
  req,
  TEST_PLATFORM,
  user,
} from "../__tests__/helpers";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PlanLimitError,
  UnauthenticatedError,
  ValidationError,
} from "../errors";
import {
  checkRecords,
  DKIM_KEY_DIFFERENT,
  DKIM_KEYS_PENDING,
  DKIM_NOT_FOUND,
  type DnsResolver,
  isDkimKey,
  type LookupType,
  matches,
  requiredPass,
  sameDkimKey,
} from "./dns";
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

/** The keys the mail server gave `domain` (as the worker caches them from its zone file). */
const keysFor = (domain: string) => [
  { selector: "v1-ed25519-20261028", value: `v=DKIM1; k=ed25519; h=sha256; p=ed${domain}` },
  { selector: "v1-rsa-20261028", value: `v=DKIM1; k=rsa; h=sha256; p=MIIB${domain}` },
];

/** Publishes every required record for `domain`, exactly as the template says, DKIM keys included. */
function publishAll(z: ReturnType<typeof zone>, domain: string, token: string) {
  for (const r of customerDomainRecords(domain, token, TEST_PLATFORM, keysFor(domain)).filter((x) => x.required)) {
    const fqdn = r.name === "@" ? domain : `${r.name}.${domain}`;
    z.publish(r.type, fqdn, r.type === "MX" ? `${String(r.priority)} ${r.value}` : r.value);
  }
}

/** What the worker's `domain.ensure` leaves behind: the domain on the mail server, its DKIM keys cached. */
function onMailServer(d: ReturnType<typeof setup>, id: string) {
  const row = d.uow.state.domains.find((x) => x.id === id)!;
  row.stalwartId = `dom:${row.name}`;
  row.dkimKeys = keysFor(row.name);
}

function setup() {
  const d = makeDeps(fixedClock("2026-10-21T12:00:00Z"));
  d.uow.state.accounts.push({ id: ACCOUNT_A, name: "A", plan: "plus" }, { id: ACCOUNT_B, name: "B", plan: "free" });
  return d;
}

describe("normaliseDomain", () => {
  it("lowercases, trims, drops the trailing dot and converts IDNs", () => {
    expect(normaliseDomain("  Family.CA. ", TEST_PLATFORM.domain)).toBe("family.ca");
    expect(normaliseDomain("bücher.example.ca", TEST_PLATFORM.domain)).toBe("xn--bcher-kva.example.ca");
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
      expect(() => normaliseDomain(bad, TEST_PLATFORM.domain)).toThrow(ValidationError);
    }
  });

  it("refuses the deployment's own platform domain and its subdomains", () => {
    expect(normaliseDomain(TEST_PLATFORM.domain, "other-platform.test")).toBe("platform-mail.test");
    expect(() => normaliseDomain(TEST_PLATFORM.domain, TEST_PLATFORM.domain)).toThrow(ValidationError);
    expect(() => normaliseDomain(`mx1.${TEST_PLATFORM.domain}`, TEST_PLATFORM.domain)).toThrow(ValidationError);
    expect(normaliseDomain("other-mail.test", TEST_PLATFORM.domain)).toBe("other-mail.test");
  });
});

describe("record matching", () => {
  it("accepts our SPF include merged into the customer's own record, and any DMARC policy", () => {
    const [spf, dmarc] = ["spf", "dmarc"].map((p) =>
      customerDomainRecords("x.org", "t", TEST_PLATFORM).find((r) => r.purpose === p)!,
    );
    expect(matches(spf!, `v=spf1 include:_spf.google.com include:${TEST_PLATFORM.spfInclude} -all`)).toBe(true);
    // The product's include doesn't count for a deployment on its own domain.
    expect(matches(spf!, "v=spf1 include:_spf.anhourmail.com -all")).toBe(false);
    expect(matches(spf!, "v=spf1 include:_spf.google.com -all")).toBe(false);
    expect(matches(dmarc!, "v=DMARC1; p=reject")).toBe(true);
  });

  it("ignores MX priority and SRV weight but not hosts or ports", () => {
    const records = customerDomainRecords("x.org", "t", TEST_PLATFORM);
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
    const graded = await checkRecords(z, "x.org", "t", TEST_PLATFORM);
    expect(graded.find((r) => r.purpose === "inbound")?.state).toBe("wrong");
    expect(graded.find((r) => r.purpose === "ownership")?.state).toBe("missing");
    z.fail = true;
    // Every lookup fails; only the DKIM placeholder (nothing to look up yet) isn't an error.
    const failed = await checkRecords(z, "x.org", "t", TEST_PLATFORM);
    expect(failed.filter((r) => !r.placeholder).every((r) => r.state === "error")).toBe(true);
  });
});

describe("DKIM verification", () => {
  it("recognises a published key and refuses revoked or foreign TXT records", () => {
    expect(isDkimKey("v=DKIM1; k=rsa; p=MIIBIjANBgkq")).toBe(true);
    expect(isDkimKey("k=ed25519; p=11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=")).toBe(true);
    expect(isDkimKey("v=DKIM1; k=rsa; p=")).toBe(false);
    expect(isDkimKey("v=spf1 -all")).toBe(false);
    expect(isDkimKey("v=DKIM2; p=abc")).toBe(false);
  });

  it("compares the public key only, whatever the spacing, quoting or other tags", () => {
    const want = "v=DKIM1; k=rsa; h=sha256; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxXpp";
    expect(sameDkimKey(want, want)).toBe(true);
    expect(sameDkimKey('v=DKIM1;k=rsa;p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A" "MIIBCgKCAQEAxXpp', want)).toBe(true);
    expect(sameDkimKey("v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A MIIBCgKCAQEAxXpp", want)).toBe(true);
    expect(sameDkimKey("v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAother", want)).toBe(false);
    expect(sameDkimKey("v=DKIM1; k=rsa; p=", "v=DKIM1; k=rsa; p=")).toBe(false);
  });

  it("passes DKIM only when every key is published with its own value, and says what's wrong", async () => {
    const z = zone();
    const keys = keysFor("x.org");
    publishAll(z, "x.org", "t");
    const dkim = customerDomainRecords("x.org", "t", TEST_PLATFORM, keys).filter((r) => r.purpose === "dkim");
    expect(dkim.map((r) => [r.type, r.name])).toEqual(keys.map((k) => ["TXT", `${k.selector}._domainkey`]));
    expect(requiredPass(await checkRecords(z, "x.org", "t", TEST_PLATFORM, keys))).toBe(true);

    // Nothing published for the second key; a different key for the first.
    z.publish("TXT", `${dkim[1]!.name}.x.org`);
    z.publish("TXT", `${dkim[0]!.name}.x.org`, "v=DKIM1; k=ed25519; p=someoneelse");
    const graded = await checkRecords(z, "x.org", "t", TEST_PLATFORM, keys);
    expect(graded.find((r) => r.name === dkim[1]!.name)).toMatchObject({ state: "missing", problem: DKIM_NOT_FOUND });
    expect(graded.find((r) => r.name === dkim[0]!.name)).toMatchObject({
      state: "wrong",
      problem: DKIM_KEY_DIFFERENT,
      found: ["v=DKIM1; k=ed25519; p=someoneelse"],
    });
    expect(requiredPass(graded)).toBe(false);
  });

  it("shows a placeholder that can't pass until the mail server has made the keys", async () => {
    const z = zone();
    publishAll(z, "x.org", "t");
    const graded = await checkRecords(z, "x.org", "t", TEST_PLATFORM, null);
    expect(graded.filter((r) => r.purpose === "dkim")).toEqual([
      expect.objectContaining({ placeholder: true, state: "missing", problem: DKIM_KEYS_PENDING, found: [] }),
    ]);
    expect(requiredPass(graded)).toBe(false);
  });

  it("does not verify a domain whose DKIM keys are missing", async () => {
    const d = setup();
    const z = zone();
    const added = await addDomain(d, domainAdmin, ACCOUNT_A, { name: "nokey.example.ca" }, req);
    onMailServer(d, added.id);
    publishAll(z, added.name, d.uow.state.domains.find((x) => x.id === added.id)!.verifyToken);
    for (const k of keysFor(added.name)) z.publish("TXT", `${k.selector}._domainkey.${added.name}`);
    const checked = await checkDomain(d, z, domainAdmin, ACCOUNT_A, added.id, req);
    expect(checked.domain.status).not.toBe("active");
  });
});

describe("DKIM keys from the mail server", () => {
  it("queues the worker once ownership and MX are found, never before", async () => {
    const d = setup();
    const z = zone();
    const added = await addDomain(d, owner, ACCOUNT_A, { name: "k.example.ca" }, req);
    const token = d.uow.state.domains[0]!.verifyToken;
    const ownership = customerDomainRecords(added.name, token, TEST_PLATFORM).find((r) => r.purpose === "ownership")!;

    // Ownership alone isn't enough: the mail server would take the domain's mail from wherever MX points now.
    z.publish("TXT", `${ownership.name}.${added.name}`, ownership.value);
    await checkDomain(d, z, owner, ACCOUNT_A, added.id, req);
    expect(d.uow.state.jobs).toEqual([]);

    publishAll(z, added.name, token);
    const out = await checkDomain(d, z, owner, ACCOUNT_A, added.id, req);
    expect(out.activated).toBe(false);
    expect(out.records.find((r) => r.purpose === "dkim")).toMatchObject({ placeholder: true });
    expect(d.uow.state.jobs).toEqual([expect.objectContaining({ kind: "domain.ensure", subjectId: added.id })]);
    // Audited as the failed check it is (the job rides on it).
    expect(d.uow.state.audit.at(-1)).toMatchObject({ action: "domain.verify_failed", result: "success" });

    // The worker added it and cached the keys: the next check finds them and activates.
    onMailServer(d, added.id);
    const done = await checkDomain(d, z, owner, ACCOUNT_A, added.id, req);
    expect(done).toMatchObject({ activated: true, domain: { status: "active", provisioned: true } });
    const shown = (await getDomain(d, owner, ACCOUNT_A, added.id)).records.filter((r) => r.purpose === "dkim");
    expect(shown.map((r) => [r.type, r.value])).toEqual(keysFor(added.name).map((k) => ["TXT", k.value]));
  });

  it("asks the worker again for a domain on the mail server whose keys weren't read, on a check or on schedule", async () => {
    const { backfillDkimKeys } = await import("./service");
    const d = setup();
    const z = zone();
    const a = await addDomain(d, owner, ACCOUNT_A, { name: "old.example.ca" }, req);
    const b = await addDomain(d, owner, ACCOUNT_A, { name: "broken.example.ca" }, req);
    const c = await addDomain(d, owner, ACCOUNT_A, { name: "fine.example.ca" }, req);
    for (const [x, status] of [
      [a, "active"],
      [b, "active"],
      [c, "active"],
    ] as const) {
      const row = d.uow.state.domains.find((r) => r.id === x.id)!;
      row.status = status;
      row.stalwartId = `dom:${row.name}`;
    }
    d.uow.state.domains.find((r) => r.id === b.id)!.lastError = "Error: DKIM keys not ready yet";
    d.uow.state.domains.find((r) => r.id === c.id)!.dkimKeys = keysFor(c.name);

    expect(await backfillDkimKeys(d)).toBe(1);
    expect(d.uow.state.jobs).toEqual([expect.objectContaining({ kind: "domain.ensure", subjectId: a.id })]);

    // A customer's check of the failed one tries again (no audit entry: checking an active domain changes nothing).
    const audit = d.uow.state.audit.length;
    await checkDomain(d, z, owner, ACCOUNT_A, b.id, req);
    expect(d.uow.state.jobs.map((j) => j.subjectId)).toEqual([a.id, b.id]);
    expect(d.uow.state.audit.length).toBe(audit);
    await checkDomain(d, z, owner, ACCOUNT_A, c.id, req);
    expect(d.uow.state.jobs).toHaveLength(2);
  });

  it("takes a pending domain that is on the mail server off it through the worker", async () => {
    const d = setup();
    const added = await addDomain(d, owner, ACCOUNT_A, { name: "p.example.ca" }, req);
    onMailServer(d, added.id);
    expect(await removeDomain(d, owner, ACCOUNT_A, added.id, req)).toEqual({ status: "removing" });
    expect(d.uow.state.domains[0]?.status).toBe("removing");
    expect(d.uow.state.jobs.at(-1)).toMatchObject({ kind: "domain.remove", subjectId: added.id });
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
    onMailServer(d, added.id);
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
    onMailServer(d, mine.id);
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
    onMailServer(d, active.id);
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
    onMailServer(d, old.id);
    onMailServer(d, fresh.id);
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
    onMailServer(d, added.id);
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
    for (const x of d.uow.state.domains) {
      publishAll(z, x.name, x.verifyToken);
      onMailServer(d, x.id);
    }
    expect(await recheckPendingDomains(d, z, { total: 50, perAccount: 5, budgetMs: 60_000 })).toBe(6);
    expect(d.uow.state.domains.find((x) => x.id === b.id)?.status).toBe("active");
    expect(d.uow.state.domains.filter((x) => x.accountId === ACCOUNT_A && x.status === "active")).toHaveLength(5);
  });
});
