// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { customerDomainRecords, DKIM_SELECTORS, dkimTarget, VERIFY_PREFIX } from "./dns";
import { ADDONS, BILLING, formatPrice, PLAN_ORDER, PLANS } from "./plans";
import { CLIENT_ENDPOINTS, HOSTS, PRODUCT_DOMAIN } from "./platform";
import { WaitlistSignupSchema } from "./schemas";
import { BULK_MAIL, TRUST_TIERS } from "./sending";

describe("plans", () => {
  it("are ordered, priced in both currencies and consistent", () => {
    expect(PLAN_ORDER).toEqual(["free", "plus", "supporter"]);
    expect(PLANS.free.price).toBeNull();
    for (const id of ["plus", "supporter"] as const) {
      const p = PLANS[id].price;
      expect(p?.USD).toBeGreaterThan(0);
      expect(p?.CAD).toBeGreaterThan(0);
    }
    expect(PLANS.supporter.payWhatYouWant).toBe(true);
    expect(BILLING.trialDays).toBe(0);
  });

  it("formats prices per currency", () => {
    expect(formatPrice(1200, "USD")).toBe("$12");
    expect(formatPrice(1250, "USD")).toBe("$12.50");
    expect(formatPrice(1500, "CAD")).toMatch(/15/);
  });
});

describe("platform and DNS", () => {
  it("hosts live on the product domain, never the company domain", () => {
    for (const h of [HOSTS.app, HOSTS.webmail, HOSTS.smtp, HOSTS.imap, ...HOSTS.mx])
      expect(h.endsWith(PRODUCT_DOMAIN)).toBe(true);
    expect(
      CLIENT_ENDPOINTS.filter((e) => e.recommended)
        .map((e) => e.port)
        .sort(),
    ).toEqual([465, 993]);
  });

  it("customer records include ownership, MX, SPF and both DKIM selectors", () => {
    const records = customerDomainRecords("example.org", "tok123");
    expect(records.find((r) => r.purpose === "ownership")?.value).toBe(`${VERIFY_PREFIX}tok123`);
    expect(records.find((r) => r.type === "MX")?.value).toBe(`${HOSTS.mx[0]}.`);
    expect(records.filter((r) => r.purpose === "dkim").map((r) => r.name)).toEqual(
      DKIM_SELECTORS.map((s) => `${s}._domainkey`),
    );
    expect(dkimTarget("am1", "example.org")).toBe(`am1.example.org.dkim.${PRODUCT_DOMAIN}`);
    expect(records.filter((r) => r.required).length).toBe(5);
  });
});

describe("bulk sending add-on", () => {
  it("is the only way to send bulk mail and needs a paid base plan", () => {
    expect(BULK_MAIL.allowedOnBasePlans).toBe(false);
    const addOn = ADDONS[BULK_MAIL.addOnId];
    expect(addOn.requires).not.toContain("free");
    expect([...addOn.monthlyRecipientTiers].sort((a, b) => a - b)).toEqual([...addOn.monthlyRecipientTiers]);
  });
});

describe("sending tiers", () => {
  it("tighten from trusted to restricted", () => {
    expect(TRUST_TIERS.restricted.limits.messagesPerDay).toBe(0);
    expect(TRUST_TIERS.new.limits.messagesPerDay).toBeLessThan(TRUST_TIERS.standard.limits.messagesPerDay);
    expect(TRUST_TIERS.standard.limits.messagesPerDay).toBeLessThan(TRUST_TIERS.trusted.limits.messagesPerDay);
  });
});

describe("waitlist schema", () => {
  it("normalises email, lets the honeypot through (checked by the service) and rejects a bad ref", () => {
    const ok = WaitlistSignupSchema.parse({ email: " A@Example.com ", startedAt: 1 });
    expect(ok.email).toBe("a@example.com");
    expect(WaitlistSignupSchema.safeParse({ email: "a@example.com", startedAt: 1, website: "x" }).success).toBe(true);
    expect(WaitlistSignupSchema.safeParse({ email: "not-an-email", startedAt: 1 }).success).toBe(false);
    expect(WaitlistSignupSchema.safeParse({ email: "a@example.com", startedAt: 1, ref: "!!" }).success).toBe(false);
  });
});
