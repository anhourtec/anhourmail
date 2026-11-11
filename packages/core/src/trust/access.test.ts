// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { TRUST_TIER_ORDER, type TrustTier } from "@anhourmail/shared/sending";

import type { BillingMailboxAccess } from "../billing/lifecycle";

import {
  MAILBOX_SEND_ACCESS,
  mailboxRelayHold,
  type MailboxSendAccess,
  mailboxSendAccess,
  stricterAccess,
} from "./access";

const BILLING: readonly BillingMailboxAccess[] = ["active", "send_blocked", "receive_blocked"];
const rank = (a: MailboxSendAccess) => MAILBOX_SEND_ACCESS.indexOf(a);

/** Every combination of the four inputs (2 × 3 × 4 × 2 = 48). */
const ALL = [false, true].flatMap((suspended) =>
  BILLING.flatMap((billing) =>
    TRUST_TIER_ORDER.flatMap((accountTier) =>
      [false, true].map((mailboxRestricted) => ({ suspended, billing, accountTier, mailboxRestricted })),
    ),
  ),
);

describe("mailboxSendAccess (ADR-0034 §4)", () => {
  // [suspended, billing, account tier, mailbox restricted, expected]
  const table: [boolean, BillingMailboxAccess, TrustTier, boolean, MailboxSendAccess][] = [
    // Tier alone (billing active, not suspended): new is held from SMTP, standard and trusted send, restricted can't.
    [false, "active", "new", false, "smtp_blocked"],
    [false, "active", "standard", false, "active"],
    [false, "active", "trusted", false, "active"],
    [false, "active", "restricted", false, "send_blocked"],
    // A mailbox restriction makes any tier restricted.
    [false, "active", "new", true, "send_blocked"],
    [false, "active", "standard", true, "send_blocked"],
    [false, "active", "trusted", true, "send_blocked"],
    [false, "active", "restricted", true, "send_blocked"],
    // Billing beats the tier; a receive-blocked hold is applied as send-blocked (backscatter, ADR-0029).
    [false, "send_blocked", "standard", false, "send_blocked"],
    [false, "send_blocked", "new", false, "send_blocked"],
    [false, "receive_blocked", "trusted", false, "send_blocked"],
    [false, "receive_blocked", "new", false, "send_blocked"],
    // Suspension beats everything.
    [true, "active", "standard", false, "suspended"],
    [true, "active", "new", false, "suspended"],
    [true, "receive_blocked", "restricted", true, "suspended"],
    [true, "send_blocked", "trusted", false, "suspended"],
  ];
  it.each(table)(
    "suspended %s, billing %s, tier %s, mailbox restricted %s → %s",
    (suspended, billing, accountTier, mailboxRestricted, expected) => {
      expect(mailboxSendAccess({ suspended, billing, accountTier, mailboxRestricted })).toBe(expected);
    },
  );

  it("a suspended mailbox is suspended whatever else holds (all 24 combinations)", () => {
    for (const i of ALL.filter((x) => x.suspended)) expect(mailboxSendAccess(i)).toBe("suspended");
  });

  it("any billing block sends-blocks a mailbox that isn't suspended, whatever its tier (all 16)", () => {
    for (const i of ALL.filter((x) => !x.suspended && x.billing !== "active")) {
      expect(mailboxSendAccess(i)).toBe("send_blocked");
    }
  });

  it("is never laxer than any one source, and never stricter than the strictest (all 48)", () => {
    for (const i of ALL) {
      const got = rank(mailboxSendAccess(i));
      const alone = [
        mailboxSendAccess({ ...i, billing: "active", accountTier: "trusted", mailboxRestricted: false }),
        mailboxSendAccess({ ...i, suspended: false, accountTier: "trusted", mailboxRestricted: false }),
        mailboxSendAccess({ ...i, suspended: false, billing: "active" }),
      ].map(rank);
      expect(got).toBe(Math.max(...alone));
    }
  });

  it("making any input stricter never makes the access laxer (all 48)", () => {
    const tierRank = (t: TrustTier) => TRUST_TIER_ORDER.length - 1 - TRUST_TIER_ORDER.indexOf(t);
    const laxer: string[] = [];
    let pairs = 0;
    for (const a of ALL) {
      for (const b of ALL) {
        const stricter =
          (b.suspended || !a.suspended) &&
          BILLING.indexOf(b.billing) >= BILLING.indexOf(a.billing) &&
          tierRank(b.accountTier) >= tierRank(a.accountTier) &&
          (b.mailboxRestricted || !a.mailboxRestricted);
        if (!stricter) continue;
        pairs += 1;
        if (rank(mailboxSendAccess(b)) < rank(mailboxSendAccess(a))) laxer.push(JSON.stringify({ a, b }));
      }
    }
    expect(pairs).toBeGreaterThan(ALL.length);
    expect(laxer).toEqual([]);
  });

  it("reaches every access state", () => {
    expect(new Set(ALL.map(mailboxSendAccess))).toEqual(new Set(MAILBOX_SEND_ACCESS));
  });
});

describe("stricterAccess", () => {
  it("picks the more restrictive of two states, in either order", () => {
    for (const a of MAILBOX_SEND_ACCESS) {
      for (const b of MAILBOX_SEND_ACCESS) {
        const s = stricterAccess(a, b);
        expect(s).toBe(stricterAccess(b, a));
        expect(rank(s)).toBe(Math.max(rank(a), rank(b)));
      }
    }
  });
});

describe('mailboxRelayHold (ADR-0034 update "relay hold")', () => {
  it("holds new and restricted, and any tier of a restricted mailbox; never standard or trusted on their own", () => {
    expect(TRUST_TIER_ORDER.map((t) => [t, mailboxRelayHold(t, false)])).toEqual(
      TRUST_TIER_ORDER.map((t) => [t, t === "new" || t === "restricted"]),
    );
    for (const t of TRUST_TIER_ORDER) expect(mailboxRelayHold(t, true)).toBe(true);
  });

  it("every mailbox the server lets submit over JMAP with a tier that doesn't allow outside recipients is held", () => {
    const cases = ALL.map((input) => ({
      ...input,
      access: mailboxSendAccess(input),
      held: mailboxRelayHold(input.accountTier, input.mailboxRestricted),
    }));
    // `smtp_blocked` (JMAP submission open) only ever comes from tier `new`: always held.
    expect(cases.filter((c) => c.access === "smtp_blocked" && !c.held)).toEqual([]);
    expect(cases.some((c) => c.held && c.access === "smtp_blocked")).toBe(true);
    // Not held: only unrestricted mailboxes of tiers that may send outside.
    expect(
      cases.filter((c) => !c.held && (c.mailboxRestricted || !["standard", "trusted"].includes(c.accountTier))),
    ).toEqual([]);
  });
});
