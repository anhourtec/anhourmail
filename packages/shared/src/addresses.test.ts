// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  isReservedPlatformLocalPart,
  isSystemLocalPart,
  PLATFORM_ADDRESS,
  platformLocalPartProblem,
  SYSTEM_MAILBOX_LOCAL_PARTS,
} from "./addresses";
import { PLANS } from "./plans";

describe("platformLocalPartProblem", () => {
  it("accepts 4 to 32 lowercase letters, digits, dots, hyphens and underscores", () => {
    for (const ok of ["jane", "jane.doe", "j-d_2026", "a1b2", "x".repeat(32), "9lives", "Jane.Doe", "  pat.lee  "]) {
      expect(platformLocalPartProblem(ok)).toBeNull();
    }
  });

  it("holds back 1 to 3 characters and refuses more than 32", () => {
    expect(PLATFORM_ADDRESS).toEqual({ min: 4, max: 32 });
    for (const short of ["", "a", "ab", "abc", "   ab  "]) {
      expect(platformLocalPartProblem(short)).toMatch(/at least 4/);
    }
    expect(platformLocalPartProblem("x".repeat(33))).toMatch(/at most 32/);
  });

  it("refuses other characters, edge punctuation and doubled dots", () => {
    for (const bad of ["jane+doe", "jane doe", "jané", "jane@doe", "j/ane", "jäne"]) {
      expect(platformLocalPartProblem(bad)).toMatch(/lowercase letters/);
    }
    for (const bad of [".jane", "jane.", "-jane", "jane-", "_jane", "jane_"]) {
      expect(platformLocalPartProblem(bad)).toMatch(/Start and end/);
    }
    expect(platformLocalPartProblem("jane..doe")).toMatch(/two dots/);
  });

  it("refuses reserved names, any case, and the svc- prefix", () => {
    for (const name of [
      "admin",
      "Administrator",
      "root",
      "postmaster",
      "hostmaster",
      "webmaster",
      "abuse",
      "security",
      "support",
      "help",
      "info",
      "billing",
      "sales",
      "privacy",
      "legal",
      "noreply",
      "no-reply",
      "mailer-daemon",
      "staff",
      "team",
      "anhourmail",
      "anhourtec",
      "system",
      "svc-provision",
      "svc-anything",
      "dmarc-reports",
      "tls-reports",
    ]) {
      expect(isReservedPlatformLocalPart(name)).toBe(true);
    }
    expect(platformLocalPartProblem("Administrator")).toBe("That name is reserved.");
    expect(platformLocalPartProblem("postmaster")).toBe("That name is reserved.");
    expect(platformLocalPartProblem("svc-anything")).toBe("That name is reserved.");
    // Reserved names under 4 characters are refused by length first.
    expect(platformLocalPartProblem("abc")).toMatch(/at least 4/);
    expect(isReservedPlatformLocalPart("helpful")).toBe(false);
    expect(platformLocalPartProblem("helpful")).toBeNull();
  });
});

describe("system mailboxes", () => {
  it("are svc-* and the published system addresses, and are all reserved", () => {
    for (const l of [...SYSTEM_MAILBOX_LOCAL_PARTS, "svc-ops", "SVC-Audit", "svc-mgmt"]) {
      expect(isSystemLocalPart(l)).toBe(true);
      expect(isReservedPlatformLocalPart(l)).toBe(true);
    }
    for (const l of ["jane", "admin", "service", "svcops"]) expect(isSystemLocalPart(l)).toBe(false);
  });
});

describe("platform mailboxes per plan", () => {
  it("Free has one free address; paid plans count them toward the mailbox ceiling", () => {
    expect(PLANS.free.platformMailboxes).toBe(1);
    expect(PLANS.plus.platformMailboxes).toBeNull();
    expect(PLANS.supporter.platformMailboxes).toBeNull();
  });
});

describe("reserved names can't be imitated", () => {
  it("compares without dots, hyphens, underscores and trailing digits", () => {
    for (const name of [
      "no.reply",
      "no_reply",
      "noreply1",
      "no-reply42",
      "post.master",
      "post_master7",
      "mailerdaemon",
      "mailer.daemon",
      "admin2",
      "a.d.m.i.n",
      "support-1",
      "svc_ops",
      "svc.provision",
      "dmarc.reports",
      "tls_reports9",
    ]) {
      expect(isReservedPlatformLocalPart(name)).toBe(true);
    }
  });

  it("reads digits as the letters they imitate and ignores leading digits", () => {
    for (const name of [
      "n0reply",
      "adm1n",
      "supp0rt",
      "s3curity",
      "p0stmaster",
      "1admin",
      "2support",
      "abu5e",
      "2admin",
    ]) {
      expect(isReservedPlatformLocalPart(name)).toBe(true);
    }
  });

  it("refuses our system mail names anywhere and role words at the start", () => {
    for (const name of [
      "noreplyx",
      "team-noreply",
      "postmasterteam",
      "mailerdaemon-bounces",
      "support-desk",
      "securityteam",
      "admin2go",
      "admins.cats",
      "billing.help",
      "verify-account",
    ]) {
      expect(isReservedPlatformLocalPart(name)).toBe(true);
    }
  });

  it("still allows ordinary names, digits included", () => {
    for (const name of ["mira2024", "jane.doe", "quinn42", "helpful", "the-admiral", "insecure", "superb7"]) {
      expect(isReservedPlatformLocalPart(name)).toBe(false);
    }
  });

  it("refuses any name containing our names, however written", () => {
    for (const name of ["anhourmail-team", "the.anhourtec", "myanhourmail", "anhour.mail", "an_hour_tec.help"]) {
      expect(isReservedPlatformLocalPart(name)).toBe(true);
    }
  });

  it("reserves list and report addresses too", () => {
    for (const name of [
      "marketing",
      "usenet",
      "news",
      "uucp",
      "verify",
      "verification",
      "notifications",
      "accounts",
      "helpdesk",
      "bounce",
      "bounces",
      "dmarc",
      "tlsrpt",
    ]) {
      expect(isReservedPlatformLocalPart(name)).toBe(true);
    }
  });

  it("leaves ordinary names alone, including ones that merely contain a reserved word", () => {
    for (const name of [
      "jane.doe",
      "newsroom.fan",
      "rootbeer",
      "helpful",
      "accountant.jo",
      "carefree",
      "testudo",
      "teamwork.fan",
      "securely.yours",
      "the-admiral",
      "insecure",
      "kim.official.fan",
      "jane.billings",
      "loginov",
      "loginova.k",
      "cats.supporter.fan",
    ]) {
      expect(isReservedPlatformLocalPart(name)).toBe(false);
    }
  });

  it("reserves company role addresses", () => {
    for (const name of [
      "contact",
      "hello",
      "careers",
      "jobs",
      "press",
      "legal",
      "compliance",
      "gdpr",
      "investors",
      "partners",
      "accounting",
      "payroll",
      "invoices",
      "refunds",
      "founders",
      "employees",
      "everyone",
      "customerservice",
      "customer.care",
    ]) {
      expect(isReservedPlatformLocalPart(name)).toBe(true);
    }
  });

  it("reserves infrastructure names and our hostnames", () => {
    for (const name of [
      "webmail",
      "autoconfig",
      "autodiscover",
      "mta-sts",
      "localhost",
      "smtp",
      "imap",
      "pop3",
      "status",
    ]) {
      expect(isReservedPlatformLocalPart(name)).toBe(true);
    }
  });

  it("reserves automated senders and placeholder names", () => {
    for (const name of [
      "donotreply",
      "do-not-reply",
      "notifications",
      "newsletter",
      "mailer",
      "daemon",
      "test1",
      "nobody",
      "undefined",
      "anonymous",
      "user2",
    ]) {
      expect(isReservedPlatformLocalPart(name)).toBe(true);
    }
  });

  it("reserves account-security words a phishing message would use, at the start, the end or anywhere", () => {
    for (const name of [
      "password-reset",
      "your.passwordreset",
      "account-security",
      "trust.and.safety",
      "signin-alert",
      "signin.help",
      "confirm.now",
      "official-news",
      "bank.security",
      "team-support",
      "mail-official",
      "it.helpdesk",
      "site-admin",
      "verified",
      "recovery",
      "wallet",
      "2fa",
      "wallet-verify",
      "bank-alerts",
      "account-notifications",
      "my.accounts",
      "mail-service",
      "adrnin",
      "rnailer-daemon",
    ]) {
      expect(isReservedPlatformLocalPart(name)).toBe(true);
    }
  });

  it("reserves mail report and mailing list conventions", () => {
    for (const name of ["rua", "ruf", "fbl", "unsubscribe", "listserv", "majordomo", "listmaster", "complaints"]) {
      expect(isReservedPlatformLocalPart(name)).toBe(true);
    }
  });
});
