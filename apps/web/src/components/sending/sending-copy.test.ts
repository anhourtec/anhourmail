// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { SUPPORT_EMAIL } from "@anhourmail/shared/platform";
import { TRUST_TIER_ORDER, TRUST_TIERS } from "@anhourmail/shared/sending";

import { limitRows, NEW_ACCOUNTS_DOCS_PATH, sendingCopy } from "./sending-copy";

describe("Sending card copy (ADR-0034 §5)", () => {
  it("new: hosted addresses now, outside and mail apps once established, with the docs link", () => {
    const c = sendingCopy("new", { subject: "account" });
    expect(c.label).toBe("New");
    expect(c.summary).toMatch(/hosted on AnhourMail/);
    expect(c.summary).toMatch(/opens automatically once your account is established/);
    expect(c.notes.join(" ")).toMatch(/Mail apps can't send yet/);
    expect(c.linkNewAccounts).toBe(true);
    expect(c.showLimits).toBe(true);
    expect(c.appeal).toBeNull();
  });

  it("new in the webmail also says what it pauses in Forwarding, and keeps automatic replies", () => {
    const notes = sendingCopy("new", { subject: "mailbox", settings: true }).notes.join(" ");
    expect(notes).toMatch(/Forwarding to an address outside AnhourMail waits/);
    expect(notes).toMatch(/Automatic replies keep working/);
  });

  it("restricted: paused, no limits, the reason in plain words and the appeal address", () => {
    const c = sendingCopy("restricted", { subject: "account", reason: "Sending spam" });
    expect(c.summary).toMatch(/^Sending from your account is paused/);
    expect(c.showLimits).toBe(false);
    expect(c.notes).toContain("Reason: Sending spam.");
    expect(c.appeal).toBe(SUPPORT_EMAIL);
    expect(c.tone).toBe("danger");
    const m = sendingCopy("restricted", { subject: "mailbox", settings: true });
    expect(m.summary).toMatch(/^Sending from this mailbox is paused/);
    expect(m.notes).toEqual(["Forwarding and automatic replies are paused too."]);
  });

  it("standard and trusted: anyone, within the limits; nothing held", () => {
    for (const tier of ["standard", "trusted"] as const) {
      const c = sendingCopy(tier, { subject: "account" });
      expect(c.summary).toMatch(/Send to anyone/);
      expect(c.notes).toEqual([]);
      expect(c.linkNewAccounts).toBe(false);
    }
  });

  it("never says anything but published facts: no numbers other than the limits, no dates (rule 33)", () => {
    for (const tier of TRUST_TIER_ORDER) {
      const c = sendingCopy(tier, { subject: "account", settings: true, reason: "Sending spam" });
      const words = [c.summary, ...c.notes].join(" ");
      expect(words).not.toMatch(/\d/);
      expect(words).not.toMatch(/\b(days?|weeks?|hours?)\b/i);
    }
  });

  it("limit rows follow the published table", () => {
    expect(limitRows(TRUST_TIERS.new.limits)).toEqual([
      { label: "Per day", value: TRUST_TIERS.new.limits.messagesPerDay },
      { label: "Per hour", value: TRUST_TIERS.new.limits.messagesPerHour },
      { label: "Recipients per message", value: TRUST_TIERS.new.limits.recipientsPerMessage },
    ]);
    expect(NEW_ACCOUNTS_DOCS_PATH).toBe("/docs/sending-limits#new-accounts");
  });
});
