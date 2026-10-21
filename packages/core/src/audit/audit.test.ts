// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ACCOUNT_A, ACCOUNT_B, deps, user } from "../__tests__/helpers";
import { ForbiddenError, NotFoundError } from "../errors";
import { AUDIT_ACTIONS, isAuditAction } from "./catalogue";
import { canonicalJson, GENESIS_HASH, hashEntry, verifyChain } from "./hash";
import { auditActor, maskEmail, redactMeta, requestFields } from "./record";
import { clampLimit, listAccountAudit, listPlatformAudit, verifyAuditScope } from "./service";
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
});
