// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ACCOUNT_A, ACCOUNT_B, deps, user } from "../__tests__/helpers";
import { ForbiddenError, NotFoundError } from "../errors";
import { AUDIT_ACTIONS, isAuditAction } from "./catalogue";
import { canonicalJson, GENESIS_HASH, hashEntry, verifyChain } from "./hash";
import { auditActor, maskEmail, redactMeta, requestFields } from "./record";
import { actionLabel, areaLabel, AUDIT_AREAS, describeActor, isAuditArea, partialIp } from "./labels";
import {
  accountAuditPage,
  clampLimit,
  listAccountAudit,
  listPlatformAudit,
  parseAuditFilters,
  platformAuditPage,
  verifyAuditScope,
} from "./service";
import type { AuditEntryInput } from "./types";

const input = (scope: AuditEntryInput["scope"]): AuditEntryInput => ({
  scope,
  action: "domain.added",
  actor: { type: "user", userId: "u", email: "u@example.test", role: "owner", accountId: ACCOUNT_A },
  onBehalfOf: null,
  target: { type: "domain", id: "d1", label: "example.test" },
  result: "success",
  errorCode: null,
  requestId: "r",
  ip: null,
  userAgent: null,
  meta: {},
});

describe("audit hash chain", () => {
  it("canonical JSON sorts keys at every depth and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}',
    );
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson("x")).toBe('"x"');
  });

  it("detects a tampered entry, a broken link and a gap", async () => {
    const d = deps();
    for (let i = 0; i < 3; i++) await d.uow.run((r) => r.audit.append(input(`account:${ACCOUNT_A}`), new Date()));
    const chain = await d.uow.run((r) => r.audit.chain(`account:${ACCOUNT_A}`));
    expect(verifyChain(chain)).toBeNull();
    expect(chain[0]?.prevHash).toBe(GENESIS_HASH);

    const [first, second, third] = chain;
    if (!first || !second || !third) throw new Error("chain too short");
    expect(verifyChain([{ ...first, meta: { forged: true } }, second, third])).toEqual({
      seq: 1,
      reason: "hash_mismatch",
    });
    const relinked = { ...second, prevHash: GENESIS_HASH };
    expect(verifyChain([first, { ...relinked, hash: hashEntry({ ...relinked }) }, third])).toEqual({
      seq: 2,
      reason: "prev_mismatch",
    });
    expect(verifyChain([first, third])).toEqual({ seq: 3, reason: "seq_gap" });
  });

  it("verifyAuditScope reports an intact chain", async () => {
    const d = deps();
    await d.uow.run((r) => r.audit.append(input("platform"), new Date()));
    expect(await verifyAuditScope(d, "platform")).toBeNull();
  });
});

describe("audit records", () => {
  it("catalogue has unique dotted names", () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    for (const a of AUDIT_ACTIONS) expect(a).toMatch(/^[a-z_]+\.[a-z_]+$/);
    expect(isAuditAction("domain.added")).toBe(true);
    expect(isAuditAction("nope.nope")).toBe(false);
  });

  it("redacts secrets and mail content from meta", () => {
    const out = redactMeta({ password: "p", subject: "hi", body: "x", nested: { token: "t", ok: 1 }, to: ["a@b"] });
    expect(out).toEqual({
      password: "[redacted]",
      subject: "[redacted]",
      body: "[redacted]",
      nested: { token: "[redacted]", ok: 1 },
      to: "[redacted]",
    });
  });

  it("masks emails and trims user agents", () => {
    expect(maskEmail("walter@example.com")).toBe("w***@example.com");
    expect(requestFields({ requestId: "r", ip: null, userAgent: "x".repeat(300) }).userAgent).toHaveLength(200);
    expect(requestFields({ requestId: "r", ip: "1.2.3.4", userAgent: null })).toEqual({
      requestId: "r",
      ip: "1.2.3.4",
      userAgent: null,
    });
  });

  it("attributes actors: anonymous, system, member, staff and act-as", () => {
    expect(auditActor({ kind: "anonymous" }, null).actor.type).toBe("anonymous");
    expect(auditActor({ kind: "system", name: "worker" }, null).actor).toMatchObject({
      type: "system",
      email: "worker",
    });
    const member = auditActor(user({ account: [[ACCOUNT_A, "user_admin"]] }), ACCOUNT_A);
    expect(member.actor).toMatchObject({ type: "user", role: "user_admin", accountId: ACCOUNT_A });
    const staff = auditActor(user({ platform: ["support_admin"] }), null);
    expect(staff.actor).toMatchObject({ type: "staff", role: "support_admin", accountId: null });
    const plain = auditActor(user(), null);
    expect(plain.actor).toMatchObject({ type: "user", role: null });
    const actingAs = auditActor(
      {
        ...user({ account: [[ACCOUNT_A, "owner"]] }),
        actingAs: { staffUserId: "s1", staffEmail: "s@anhourtec.test", staffRole: "support_admin", reason: "ticket" },
      },
      ACCOUNT_A,
    );
    expect(actingAs.onBehalfOf).toEqual({ userId: "s1", email: "s@anhourtec.test" });
    // A staff path records staff as staff even for a member of the account; a plain member is unaffected.
    const staffMember = user({ platform: ["support_admin"], account: [[ACCOUNT_A, "owner"]] });
    expect(auditActor(staffMember, ACCOUNT_A).actor).toMatchObject({ type: "user", role: "owner" });
    expect(auditActor(staffMember, ACCOUNT_A, true).actor).toMatchObject({
      type: "staff",
      role: "support_admin",
      accountId: null,
    });
    expect(auditActor(user({ account: [[ACCOUNT_A, "user_admin"]] }), ACCOUNT_A, true).actor).toMatchObject({
      type: "user",
      role: "user_admin",
    });
  });
});

describe("clampLimit", () => {
  it("defaults, clamps and rejects NaN/Infinity/fractions", () => {
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit(Number.NaN)).toBe(50);
    expect(clampLimit(Number.POSITIVE_INFINITY)).toBe(50);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(9999)).toBe(200);
    expect(clampLimit(12.7)).toBe(12);
  });
});

describe("audit visibility", () => {
  it("account admins and auditors read their account; members and outsiders can't", async () => {
    const d = deps();
    await d.uow.run((r) => r.audit.append(input(`account:${ACCOUNT_A}`), new Date()));
    for (const role of ["owner", "user_admin", "auditor"] as const) {
      const list = await listAccountAudit(d, user({ account: [[ACCOUNT_A, role]] }), ACCOUNT_A);
      expect(list).toHaveLength(1);
    }
    await expect(listAccountAudit(d, user({ account: [[ACCOUNT_A, "member"]] }), ACCOUNT_A)).rejects.toThrow(
      ForbiddenError,
    );
    await expect(listAccountAudit(d, user({ account: [[ACCOUNT_B, "owner"]] }), ACCOUNT_A)).rejects.toThrow(
      NotFoundError,
    );
  });

  it("clamps page size and pages by seq", async () => {
    const d = deps();
    for (let i = 0; i < 3; i++) await d.uow.run((r) => r.audit.append(input(`account:${ACCOUNT_A}`), new Date()));
    const owner = user({ account: [[ACCOUNT_A, "owner"]] });
    expect(await listAccountAudit(d, owner, ACCOUNT_A, { limit: 0 })).toHaveLength(1);
    expect((await listAccountAudit(d, owner, ACCOUNT_A, { beforeSeq: 3 })).map((e) => e.seq)).toEqual([2, 1]);
  });

  it("platform audit is Global Admin and Reports Reader only", async () => {
    const d = deps();
    await d.uow.run((r) => r.audit.append(input("platform"), new Date()));
    expect(await listPlatformAudit(d, user({ platform: ["global_admin"] }))).toHaveLength(1);
    expect(await listPlatformAudit(d, user({ platform: ["reports_reader"] }), { limit: 500 })).toHaveLength(1);
    await expect(listPlatformAudit(d, user({ platform: ["support_admin"] }))).rejects.toThrow(ForbiddenError);
  });

  it("IPs: the platform log shows the full address to Global Administrators only; account logs only the network part; never the UA", async () => {
    const d = deps();
    const withIp = (scope: AuditEntryInput["scope"], ip: string): AuditEntryInput => ({
      ...input(scope),
      ip,
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0",
    });
    await d.uow.run((r) => r.audit.append(withIp("platform", "203.0.113.57"), new Date()));
    await d.uow.run((r) => r.audit.append(withIp("platform", "2001:db8:1:2:3:4:5:6"), new Date()));
    await d.uow.run((r) => r.audit.append(withIp(`account:${ACCOUNT_A}`, "198.51.100.23"), new Date()));
    const full = await platformAuditPage(d, user({ platform: ["global_admin"] }));
    expect(full.entries.map((e) => [e.ip, e.userAgent])).toEqual([
      ["2001:db8:1:2:3:4:5:6", null],
      ["203.0.113.57", null],
    ]);
    // A Reports Reader reads the platform log but without `platform.audit.full_ip`: the network part only.
    const partial = await platformAuditPage(d, user({ platform: ["reports_reader"] }));
    expect(partial.entries.map((e) => [e.ip, e.userAgent])).toEqual([
      ["2001:db8:1::/48", null],
      ["203.0.113.x", null],
    ]);
    // Staff without the permission get nothing; a Global Administrator who is also an Owner sees the account log
    // like any Owner: the network part only.
    await expect(platformAuditPage(d, user({ platform: ["support_admin"] }))).rejects.toThrow(ForbiddenError);
    const both = user({ platform: ["global_admin"], account: [[ACCOUNT_A, "owner"]] });
    for (const reader of [both, user({ account: [[ACCOUNT_A, "owner"]] })]) {
      const page = await accountAuditPage(d, reader, ACCOUNT_A);
      expect(page.entries.map((e) => [e.ip, e.userAgent])).toEqual([["198.51.100.x", null]]);
    }
    await expect(accountAuditPage(d, user({ platform: ["global_admin"] }), ACCOUNT_A)).rejects.toThrow(NotFoundError);
    await expect(accountAuditPage(d, user({ account: [[ACCOUNT_B, "owner"]] }), ACCOUNT_A)).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe("audit labels", () => {
  it("every catalogue area has a label and every action a sentence-case one", () => {
    for (const a of AUDIT_ACTIONS) {
      const area = a.split(".")[0] ?? "";
      expect(AUDIT_AREAS).toContain(area);
      const label = actionLabel(a);
      expect(label === a ? a : "labelled").toBe("labelled");
      expect(label.charAt(0)).toBe(label.charAt(0).toUpperCase());
      expect(label).not.toContain("_");
    }
    expect(actionLabel("mailbox.deletion_scheduled")).toBe("Mailbox deletion scheduled");
    expect(actionLabel("account.invite_sent")).toBe("Invite sent");
    expect(actionLabel("nope.thing")).toBe("nope.thing");
    expect(actionLabel("mailbox.not_in_catalogue")).toBe("mailbox.not_in_catalogue");
    expect(areaLabel("domain.added")).toBe("Domains");
    expect(areaLabel("nope.thing")).toBe("nope");
    expect(isAuditArea("mailbox")).toBe(true);
    expect(isAuditArea("constructor")).toBe(false);
  });

  it("names staff plainly, including act-as (rule 49), and the system and signed-out visitors", () => {
    const base = input("platform");
    expect(describeActor(base)).toEqual({ kind: "user", label: "u@example.test", detail: "Owner" });
    expect(describeActor({ ...base, actor: { ...base.actor, email: null, role: null } })).toEqual({
      kind: "user",
      label: "Someone",
      detail: null,
    });
    expect(
      describeActor({
        ...base,
        actor: { ...base.actor, type: "staff", role: "support_admin", email: "s@anhourtec.test" },
      }),
    ).toEqual({ kind: "staff", label: "Anhourtec staff", detail: "Support Administrator · s@anhourtec.test" });
    expect(
      describeActor({ ...base, actor: { ...base.actor, type: "staff", role: null, email: null } }).detail,
    ).toBeNull();
    expect(describeActor({ ...base, onBehalfOf: { userId: "s", email: "s@anhourtec.test" } })).toEqual({
      kind: "staff",
      label: "Anhourtec staff",
      detail: "s@anhourtec.test acting as u@example.test",
    });
    expect(
      describeActor({ ...base, actor: { ...base.actor, email: null }, onBehalfOf: { userId: "s", email: "s@x" } })
        .detail,
    ).toBe("s@x acting as a member");
    expect(describeActor({ ...base, actor: { ...base.actor, type: "system", email: "mailbox-purge" } })).toEqual({
      kind: "system",
      label: "System",
      detail: "mailbox-purge",
    });
    expect(describeActor({ ...base, actor: { ...base.actor, type: "anonymous" } }).label).toBe("Signed-out visitor");
    expect(describeActor({ ...base, actor: { ...base.actor, role: "made_up" as "owner" } }).detail).toBe("made_up");
  });

  it("shows only the network part of an IP", () => {
    expect(partialIp(null)).toBeNull();
    expect(partialIp("203.0.113.57")).toBe("203.0.113.x");
    expect(partialIp("::ffff:198.51.100.7")).toBe("198.51.100.x");
    expect(partialIp("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1::/48");
    expect(partialIp("2001:db8::1")).toBe("2001:db8::/48");
    expect(partialIp("::1")).toBe("0::/48");
    expect(partialIp("garbage")).toBe("hidden");
  });
});

describe("audit filters and pages", () => {
  it("parses untrusted query strings, dropping anything unknown", () => {
    expect(
      parseAuditFilters({
        area: "mailbox",
        actor: " staff ",
        result: "denied",
        from: "2026-10-01",
        to: "2026-10-02",
        before: "40",
        limit: "500",
      }),
    ).toEqual({
      area: "mailbox",
      actor: "staff",
      result: "denied",
      from: new Date("2026-10-01T00:00:00Z"),
      to: new Date("2026-10-02T23:59:59.999Z"),
      beforeSeq: 40,
      limit: 200,
    });
    expect(
      parseAuditFilters({
        area: "nope",
        actor: "x".repeat(201),
        result: "maybe",
        from: "yesterday",
        to: "2026-13-45",
        before: "1",
      }),
    ).toEqual({});
    expect(parseAuditFilters({ limit: "x" })).toEqual({});
  });

  it("pages newest first with a cursor, masks IPs and drops user agents", async () => {
    const d = deps();
    for (let i = 0; i < 5; i++) await d.uow.run((r) => r.audit.append(input(`account:${ACCOUNT_A}`), new Date()));
    const owner = user({ account: [[ACCOUNT_A, "owner"]] });
    const first = await accountAuditPage(d, owner, ACCOUNT_A, { limit: 2 });
    expect(first.entries.map((e) => e.seq)).toEqual([5, 4]);
    expect(first.nextBefore).toBe(4);
    const last = await accountAuditPage(d, owner, ACCOUNT_A, { limit: 2, beforeSeq: 2 });
    expect(last).toMatchObject({ nextBefore: null });
    expect(last.entries.map((e) => e.seq)).toEqual([1]);
    await d.uow.run((r) =>
      r.audit.append({ ...input(`account:${ACCOUNT_A}`), ip: "203.0.113.9", userAgent: "Firefox" }, new Date()),
    );
    const [masked] = await listAccountAudit(d, owner, ACCOUNT_A, { limit: 1 });
    expect(masked).toMatchObject({ ip: "203.0.113.x", userAgent: null });
  });

  it("filters by area, actor kind or person, result and dates", async () => {
    const d = deps();
    const scope = `account:${ACCOUNT_A}` as const;
    const at = (iso: string) => new Date(iso);
    await d.uow.run(async (r) => {
      await r.audit.append(input(scope), at("2026-10-01T10:00:00Z"));
      await r.audit.append(
        { ...input(scope), action: "mailbox.created", actor: { ...input(scope).actor, userId: "other" } },
        at("2026-10-02T10:00:00Z"),
      );
      await r.audit.append(
        { ...input(scope), action: "staff.account_viewed", actor: { ...input(scope).actor, type: "staff" } },
        at("2026-10-03T10:00:00Z"),
      );
      await r.audit.append({ ...input(scope), result: "denied" }, at("2026-10-04T10:00:00Z"));
    });
    const owner = user({ account: [[ACCOUNT_A, "owner"]] });
    const seqs = async (f: Parameters<typeof listAccountAudit>[3]) =>
      (await listAccountAudit(d, owner, ACCOUNT_A, f)).map((e) => e.seq);
    expect(await seqs({ area: "mailbox" })).toEqual([2]);
    expect(await seqs({ actor: "staff" })).toEqual([3]);
    expect(await seqs({ actor: "other" })).toEqual([2]);
    expect(await seqs({ actor: "user" })).toEqual([4, 2, 1]);
    expect(await seqs({ result: "denied" })).toEqual([4]);
    expect(await seqs(parseAuditFilters({ from: "2026-10-02", to: "2026-10-03" }))).toEqual([3, 2]);
    expect((await platformAuditPage(d, user({ platform: ["reports_reader"] }), {})).entries).toEqual([]);
  });
});
