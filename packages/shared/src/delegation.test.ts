// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  convertToSharedSchema,
  DELEGATION_BATCH_MAX,
  DELEGATION_RIGHT_LABELS,
  DELEGATION_RIGHTS,
  delegationUpdateSchema,
  firstIssue,
  isDelegationRight,
  memberRemovalSchema,
} from "./delegation";
import { DELEGATED_MAILBOXES_PER_PERSON, DELEGATES_PER_MAILBOX, PLAN_ORDER, PLANS } from "./plans";

describe("delegation facts", () => {
  it("is a paid-plan feature (Free has one person, so nobody to grant to)", () => {
    expect(PLAN_ORDER.filter((p) => PLANS[p].delegation)).toEqual(["plus", "supporter"]);
    for (const p of PLAN_ORDER) expect(PLANS[p].delegation).toBe(PLANS[p].addPeople);
  });

  it("has positive ceilings per mailbox and per person", () => {
    expect(DELEGATES_PER_MAILBOX).toBe(25);
    expect(DELEGATED_MAILBOXES_PER_PERSON).toBe(20);
  });

  it("names the three rights with a sentence-case label each", () => {
    expect(DELEGATION_RIGHTS).toEqual(["full_access", "send_as", "send_on_behalf"]);
    for (const r of DELEGATION_RIGHTS) {
      expect(isDelegationRight(r)).toBe(true);
      expect(DELEGATION_RIGHT_LABELS[r]).toMatch(/^[A-Z][a-z ]+$/);
    }
    for (const bad of ["FULL_ACCESS", "owner", "", null, 3]) expect(isDelegationRight(bad)).toBe(false);
  });
});

/** The sentence a 400 would show for `value`, or null when it parses. */
function issue(value: unknown): string | null {
  const out = delegationUpdateSchema.safeParse(value);
  return out.success ? null : firstIssue(out.error);
}

describe("delegation request schemas", () => {
  it("parses a batch of adds and removes, trimming ids and defaulting the missing list", () => {
    expect(delegationUpdateSchema.parse({ add: [{ userId: " u1 ", right: "send_as" }] })).toEqual({
      add: [{ userId: "u1", right: "send_as" }],
      remove: [],
    });
    expect(delegationUpdateSchema.parse({ remove: [{ userId: "u2", right: "full_access" }] }).add).toEqual([]);
  });

  it("refuses an empty batch, unknown rights, extra keys and oversized batches", () => {
    expect(issue({ add: [], remove: [] })).toBe("Choose at least one change.");
    for (const bad of [
      { add: [{ userId: "u1", right: "owner" }] },
      { add: [{ userId: "", right: "send_as" }] },
      { add: [{ userId: "x".repeat(201), right: "send_as" }] },
      { add: [{ userId: "u1", right: "send_as", accountId: "other" }] },
      { add: [], remove: [], extra: true },
      { add: "everyone" },
      null,
    ]) {
      expect(issue(bad)).toBe("Check the request and try again.");
    }
    const half = Array.from({ length: DELEGATION_BATCH_MAX / 2 + 1 }, (_, i) => ({
      userId: `u${String(i)}`,
      right: "full_access" as const,
    }));
    expect(issue({ add: half, remove: half })).toMatch(/Make up to 50 changes/);
    const one = Array.from({ length: DELEGATION_BATCH_MAX + 1 }, (_, i) => ({
      userId: `u${String(i)}`,
      right: "send_as" as const,
    }));
    expect(delegationUpdateSchema.safeParse({ add: one }).success).toBe(false);
    expect(issue({ add: [{ userId: "u1", right: "send_as" }], remove: [{ userId: "u1", right: "send_as" }] })).toMatch(
      /add and remove the same/,
    );
    // The same person on different lists is fine.
    expect(
      delegationUpdateSchema.safeParse({
        add: [{ userId: "u1", right: "send_as" }],
        remove: [{ userId: "u1", right: "send_on_behalf" }],
      }).success,
    ).toBe(true);
  });

  it("parses a conversion to shared with optional members", () => {
    expect(convertToSharedSchema.parse({})).toEqual({ fullAccessTo: [], sendAs: false });
    expect(convertToSharedSchema.parse({ fullAccessTo: ["u1"], sendAs: true })).toEqual({
      fullAccessTo: ["u1"],
      sendAs: true,
    });
    expect(convertToSharedSchema.safeParse({ fullAccessTo: "u1" }).success).toBe(false);
    expect(
      convertToSharedSchema.safeParse({ fullAccessTo: Array.from({ length: DELEGATES_PER_MAILBOX + 1 }, String) })
        .success,
    ).toBe(false);
  });

  it("parses a removal with an optional hand-over", () => {
    expect(memberRemovalSchema.parse({})).toEqual({});
    expect(memberRemovalSchema.parse({ delegateTo: { userId: "boss" } })).toEqual({
      delegateTo: { userId: "boss", sendAs: false },
    });
    expect(memberRemovalSchema.safeParse({ delegateTo: { userId: "boss", sendAs: "yes" } }).success).toBe(false);
    expect(memberRemovalSchema.safeParse({ delegateTo: "boss" }).success).toBe(false);
  });

  it("explains an issue-less error plainly", () => {
    expect(firstIssue(new z.ZodError([]))).toBe("Check the request and try again.");
  });
});
