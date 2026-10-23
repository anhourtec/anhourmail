// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { customerDomainRecords, DKIM_SELECTORS, dkimTarget, VERIFY_PREFIX } from "./dns";
import { ADDONS, BILLING, fairUseText, formatPrice, MAX_MAILBOXES, PLAN_ORDER, PLANS } from "./plans";
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
import {
  GENERATED_MAILBOX_PASSWORD,
  generateMailboxPassword,
  isSignInPolicy,
  MAILBOX_PASSWORD,
  MAILBOX_PASSWORD_RULES,
  mailboxPasswordProblem,
  RECOVERY_CODES,
  SIGN_IN_POLICIES,
  SIGN_IN_POLICY_LABELS,
} from "./security";
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

  it("match the 2026-10-23 pricing decision: storage per mailbox, prices, fair use and extras", () => {
    expect(PLAN_ORDER.map((id) => PLANS[id].storageGb)).toEqual([1, 10, 10]);
    expect(PLANS.plus.price).toEqual({ USD: 900, CAD: 1200 });
    expect(PLANS.supporter.price).toEqual({ USD: 2000, CAD: 2700 });
    expect(PLANS.free).toMatchObject({
      includedMailboxes: 1,
      platformMailboxes: 1,
      extraMailboxPrice: null,
      fairUseStorageGb: null,
      extraStoragePricePerGb: null,
    });
    for (const id of ["plus", "supporter"] as const) {
      expect(PLANS[id]).toMatchObject({
        includedMailboxes: 10,
        extraMailboxPrice: { USD: 100, CAD: 140 },
        fairUseStorageGb: 30,
        extraStoragePricePerGb: { USD: 100, CAD: 140 },
      });
    }
    // Until billing can sell extra mailboxes, the creation ceiling is exactly what paid plans include.
    expect(MAX_MAILBOXES).toBe(PLANS.plus.includedMailboxes);
  });

  it("renders the fair-use line from the facts (none for Free)", () => {
    expect(fairUseText(PLANS.plus)).toBe(
      "No hard limits — fair use 30 GB per account, then $1/GB/year; extra mailboxes $1/year each",
    );
    expect(fairUseText(PLANS.supporter, "CAD")).toMatch(
      /^No hard limits — fair use 30 GB per account, then .*1\.40\/GB\/year; extra mailboxes .*1\.40\/year each$/,
    );
    expect(fairUseText(PLANS.free)).toBeNull();
    expect(fairUseText({ ...PLANS.plus, extraMailboxPrice: null })).toBe(
      "No hard limits — fair use 30 GB per account, then $1/GB/year",
    );
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

describe("mailbox passwords", () => {
  it("accepts a passphrase and explains every refusal in one sentence", () => {
    expect(mailboxPasswordProblem("correct horse battery staple", "kid@family.ca")).toBeNull();
    expect(mailboxPasswordProblem("p\u00e4ssw\u00f6rd-\u00fcn\u00efcode", "kid@family.ca")).toBeNull();
    expect(mailboxPasswordProblem("x".repeat(MAILBOX_PASSWORD.max), "kid@family.ca")).toBeNull();
    const cases: [string, RegExp][] = [
      ["short", /at least 12/],
      ["x".repeat(MAILBOX_PASSWORD.max + 1), /at most 128/],
      [" leading-space-pw", /spaces at the start or end/],
      ["trailing-space-pw ", /spaces at the start or end/],
      ["tab\tinside-password", /control characters/],
      ["App_something-long", /app_/],
      ["KID@family.ca", /isn't the mailbox address/],
    ];
    for (const [pw, why] of cases) expect(mailboxPasswordProblem(pw, "kid@family.ca")).toMatch(why);
    expect(mailboxPasswordProblem("kidkidkidkid", "kidkidkidkid@family.ca")).toMatch(/isn't the mailbox address/);
    expect(MAILBOX_PASSWORD_RULES).toHaveLength(3);
  });

  it("generates passwords of the set length from the alphabet, without bias, that pass the rules", () => {
    const a = generateMailboxPassword();
    expect(a).toHaveLength(GENERATED_MAILBOX_PASSWORD.length);
    expect(a).toMatch(new RegExp(`^[${GENERATED_MAILBOX_PASSWORD.alphabet}]+$`));
    expect(generateMailboxPassword()).not.toBe(a);
    expect(mailboxPasswordProblem(a, "kid@family.ca")).toBeNull();
    // Bytes at or above the last full multiple of the alphabet size are drawn again, never folded in.
    let call = 0;
    const out = generateMailboxPassword((b) => {
      b.fill(call++ === 0 ? 255 : 1);
      return b;
    });
    expect(out).toBe(GENERATED_MAILBOX_PASSWORD.alphabet.charAt(1).repeat(GENERATED_MAILBOX_PASSWORD.length));
  });
});
