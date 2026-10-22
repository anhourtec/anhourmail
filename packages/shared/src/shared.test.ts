// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { customerDomainRecords, DKIM_SELECTORS, dkimTarget, VERIFY_PREFIX } from "./dns";
import { ADDONS, BILLING, formatPrice, PLAN_ORDER, PLANS } from "./plans";
import {
  CARDDAV,
  CLIENT_ENDPOINTS,
  DEFAULT_PLATFORM_DOMAIN,
  HOSTS,
  isHostDirectlyUnder,
  isPlatformDomain,
  parsePlatformDomain,
  platformFacts,
  PRODUCT_DOMAIN,
  productionPlatformProblems,
  PUBLIC_PLATFORM,
} from "./platform";
import { isSignInPolicy, RECOVERY_CODES, SIGN_IN_POLICIES, SIGN_IN_POLICY_LABELS } from "./security";
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

  it("advertises only the published client ports: no cleartext 143 or 110", () => {
    expect(CLIENT_ENDPOINTS.map((e) => `${e.protocol}:${String(e.port)}:${e.security}`)).toEqual([
      "IMAP:993:SSL/TLS",
      "POP3:995:SSL/TLS",
      "SMTP:465:SSL/TLS",
      "SMTP:587:STARTTLS",
      "JMAP:443:SSL/TLS",
    ]);
    expect(CLIENT_ENDPOINTS.some((e) => e.port === 143 || e.port === 110)).toBe(false);
  });

  it("customer records include ownership, MX, SPF and both DKIM selectors", () => {
    const records = customerDomainRecords("example.org", "tok123", PUBLIC_PLATFORM);
    expect(records.find((r) => r.purpose === "ownership")?.value).toBe(`${VERIFY_PREFIX}tok123`);
    expect(records.find((r) => r.type === "MX")?.value).toBe(`${HOSTS.mx[0]}.`);
    expect(records.filter((r) => r.purpose === "dkim").map((r) => r.name)).toEqual(
      DKIM_SELECTORS.map((s) => `${s}._domainkey`),
    );
    expect(dkimTarget("am1", "example.org", PUBLIC_PLATFORM)).toBe(`am1.example.org.dkim.${PRODUCT_DOMAIN}`);
    expect(records.filter((r) => r.required).length).toBe(5);
  });
});

describe("configured platform domain", () => {
  const staging = platformFacts("staging-mail.example.net");

  it("builds every host, client setting and DNS target under that domain", () => {
    expect(staging.hosts.mx).toEqual(["mx1.staging-mail.example.net"]);
    // Free addresses live on the platform domain itself (documented on `Platform.freeAddressDomain`).
    expect(staging.freeAddressDomain).toBe("staging-mail.example.net");
    expect(staging.hosts.imap).toBe("imap.staging-mail.example.net");
    expect(staging.spfInclude).toBe("_spf.staging-mail.example.net");
    expect(staging.carddav.url).toBe("https://imap.staging-mail.example.net/dav/card/");
    for (const e of staging.clientEndpoints) expect(e.host.endsWith(".staging-mail.example.net")).toBe(true);
  });

  it("renders customer DNS records that never mention the product domain", () => {
    const records = customerDomainRecords("customer.org", "tok", staging);
    const byPurpose = (p: string) => records.filter((r) => r.purpose === p).map((r) => r.value);
    expect(byPurpose("inbound")).toEqual(["mx1.staging-mail.example.net."]);
    expect(byPurpose("spf")).toEqual(["v=spf1 include:_spf.staging-mail.example.net ~all"]);
    expect(byPurpose("dkim")).toEqual(DKIM_SELECTORS.map((s) => `${s}.customer.org.dkim.staging-mail.example.net.`));
    expect(byPurpose("autoconfig")).toEqual(["autoconfig.staging-mail.example.net."]);
    expect(byPurpose("autodiscover")).toEqual(["autodiscover.staging-mail.example.net."]);
    expect(byPurpose("client-srv")).toEqual([
      "0 1 465 smtp.staging-mail.example.net.",
      "0 1 993 imap.staging-mail.example.net.",
      "0 1 443 imap.staging-mail.example.net.",
    ]);
    for (const r of records) expect(r.value).not.toContain(PRODUCT_DOMAIN);
  });

  it("defaults to the product domain and refuses unusable values", () => {
    expect(parsePlatformDomain(undefined)).toBe(DEFAULT_PLATFORM_DOMAIN);
    expect(parsePlatformDomain("  ")).toBe(DEFAULT_PLATFORM_DOMAIN);
    expect(parsePlatformDomain(" Staging.Example.NET ")).toBe("staging.example.net");
    for (const bad of ["https://example.org", "example.org.", "localhost", "10.0.0.1", "-x.org", "a b.org"]) {
      expect(isPlatformDomain(bad)).toBe(false);
      expect(() => parsePlatformDomain(bad)).toThrow(/PLATFORM_DOMAIN/);
    }
    expect(() => platformFacts("not a domain")).toThrow();
  });

  it("checks production hosts are directly under the platform domain", () => {
    expect(isHostDirectlyUnder("app.example.org", "example.org")).toBe(true);
    expect(isHostDirectlyUnder("APP.Example.org", "example.org")).toBe(true);
    expect(isHostDirectlyUnder("app.staging.example.org", "example.org")).toBe(false);
    expect(isHostDirectlyUnder("example.org", "example.org")).toBe(false);
    expect(isHostDirectlyUnder("app.badexample.org", "example.org")).toBe(false);
    const ok = { platformDomainSetting: "example.org", domain: "example.org" };
    expect(productionPlatformProblems({ ...ok, urls: { APP_URL: "https://app.example.org" } })).toEqual([]);
    expect(
      productionPlatformProblems({ ...ok, platformDomainSetting: " ", urls: { APP_URL: "https://app.example.org" } }),
    ).toEqual(["PLATFORM_DOMAIN must be set explicitly in production"]);
    expect(productionPlatformProblems({ ...ok, urls: { WEBMAIL_URL: "::not a url" } })[0]).toMatch(/^WEBMAIL_URL/);
  });

  it("keeps the published facts on the product domain", () => {
    expect(PUBLIC_PLATFORM.domain).toBe(PRODUCT_DOMAIN);
    expect(CARDDAV.host).toBe(`imap.${PRODUCT_DOMAIN}`);
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

describe("sign-in security", () => {
  it("lists the policies with labels, and recognises only them", () => {
    expect(SIGN_IN_POLICIES).toEqual(["none", "two_factor", "passkey"]);
    for (const p of SIGN_IN_POLICIES) expect(SIGN_IN_POLICY_LABELS[p]).toBeTruthy();
    expect(isSignInPolicy("passkey")).toBe(true);
    expect(isSignInPolicy("sms")).toBe(false);
    expect(isSignInPolicy(1)).toBe(false);
    expect(RECOVERY_CODES.warnAtOrBelow).toBeLessThan(RECOVERY_CODES.count);
  });
});
