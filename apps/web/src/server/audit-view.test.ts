// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import type { AuditEntry } from "@anhourmail/core/audit";

import { AREA_OPTIONS, readAuditParams } from "./audit-page";
import { auditRows } from "./audit-rows";

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  id: "e1",
  scope: "account:a",
  seq: 7,
  at: "2026-10-22T09:05:00.000Z",
  action: "account.role_changed",
  actor: { type: "user", userId: "u", email: "owner@a.test", role: "owner", accountId: "a" },
  onBehalfOf: null,
  target: { type: "person", id: "u2", label: "kid@a.test" },
  result: "success",
  errorCode: null,
  requestId: "req-1",
  ip: "203.0.113.x",
  userAgent: null,
  meta: { previousRole: "member", newRole: "user_admin" },
  prevHash: "0".repeat(64),
  hash: "a".repeat(64),
  ...over,
});

describe("audit rows", () => {
  it("labels the action and actor, formats UTC times and serialises the redacted meta", () => {
    const [row] = auditRows([entry()]);
    expect(row).toMatchObject({
      seq: 7,
      actionLabel: "Role changed",
      areaLabel: "Account and people",
      actor: { kind: "user", label: "owner@a.test", detail: "Owner" },
      reason: null,
      ip: "203.0.113.x",
    });
    expect(row?.at).toMatch(/UTC$/);
    expect(row?.atFull).toContain("2026");
    expect(JSON.parse(row?.meta ?? "{}")).toEqual({ previousRole: "member", newRole: "user_admin" });
  });

  it("shows act-as staff and their reason, and no meta block when empty", () => {
    const [row] = auditRows([
      entry({ onBehalfOf: { userId: "s", email: "s@anhourtec.test" }, meta: { reason: "ticket 42" } }),
    ]);
    expect(row?.actor).toMatchObject({ kind: "staff", label: "Anhourtec staff" });
    expect(row?.reason).toBe("ticket 42");
    expect(auditRows([entry({ meta: {} })])[0]?.meta).toBeNull();
  });
});

describe("audit search params", () => {
  it("keeps only values that pass validation, for the form and paging links", () => {
    const out = readAuditParams({
      area: "mailbox",
      actor: "staff",
      result: "nope",
      from: "2026-10-01",
      to: ["2026-10-02", "x"],
      before: "12",
    });
    expect(out.current).toEqual({ area: "mailbox", actor: "staff", from: "2026-10-01" });
    expect(out.filters).toMatchObject({ area: "mailbox", actor: "staff", beforeSeq: 12, limit: 50 });
    expect(out.paged).toBe(true);
    expect(readAuditParams({}).paged).toBe(false);
    expect(AREA_OPTIONS.find((o) => o.value === "account")?.label).toBe("Account and people");
  });
});
