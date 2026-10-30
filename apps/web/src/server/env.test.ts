// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { onBehalfTag } from "@anhourmail/core/webmail";

import { breachedPasswordMode, env, resetEnvForTests, senderDelegationKey } from "./env";
import { platform } from "./platform";

/** A production configuration that passes every check, on the product domain. */
function production(overrides: Record<string, string | undefined> = {}) {
  const base: Record<string, string | undefined> = {
    NODE_ENV: "production",
    APP_URL: "https://app.anhourmail.com",
    WEBMAIL_URL: "https://mail.anhourmail.com",
    SITE_URL: "https://anhourmail.com",
    BETTER_AUTH_SECRET: "p".repeat(48),
    DATABASE_URL: "postgres://unused",
    REDIS_URL: "redis://unused",
    MAIL_TRANSPORT_URL: "smtp://unused",
    MAIL_FROM: "AnhourMail <no-reply@anhourmail.com>",
    TRUST_PROXY: "true",
    SECRETS_KEYRING: `k1:${Buffer.alloc(32, 1).toString("base64")}`,
    MAILBOX_PASSWORD_GRANT_KEY: "g".repeat(48),
    SENDER_DELEGATION_KEY: "d".repeat(64),
    PLATFORM_DOMAIN: undefined,
    STALWART_OPERATIONS_KEY: "operations-key",
    STALWART_PROVISIONING_KEY: undefined,
    STALWART_AUDIT_KEY: undefined,
    STALWART_API_KEY: undefined,
    STALWART_DEV_ADMIN_USER: undefined,
    STALWART_DEV_ADMIN_PASSWORD: undefined,
    BREACHED_PASSWORD_CHECK: undefined,
    MAIL_AUTHSERV_ID: undefined,
    ...overrides,
  };
  for (const [k, v] of Object.entries(base)) vi.stubEnv(k, v);
  resetEnvForTests();
}

beforeEach(() => {
  resetEnvForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvForTests();
});

describe("PLATFORM_DOMAIN", () => {
  it("uses the product domain when set to it", () => {
    production({ PLATFORM_DOMAIN: "anhourmail.com" });
    expect(env().PLATFORM_DOMAIN).toBe("anhourmail.com");
    expect(platform().hosts.mx).toEqual(["mx1.anhourmail.com"]);
  });

  it("must be set explicitly in production", () => {
    production();
    expect(() => env()).toThrow(/PLATFORM_DOMAIN must be set explicitly in production/);
  });

  it("builds every customer-facing host under a configured domain", () => {
    production({
      PLATFORM_DOMAIN: " Staging.Example.NET ",
      APP_URL: "https://app.staging.example.net",
      WEBMAIL_URL: "https://mail.staging.example.net",
    });
    expect(env().PLATFORM_DOMAIN).toBe("staging.example.net");
    const p = platform();
    expect(p.hosts.mx).toEqual(["mx1.staging.example.net"]);
    expect(p.spfInclude).toBe("_spf.staging.example.net");
    expect(p.carddav.url).toBe("https://imap.staging.example.net/dav/card/");
    expect(p.clientEndpoints.every((e) => e.host.endsWith(".staging.example.net"))).toBe(true);
  });

  it("refuses a value that isn't a domain name", () => {
    production({ PLATFORM_DOMAIN: "https://example.net/" });
    expect(() => env()).toThrow(/PLATFORM_DOMAIN/);
  });

  it("refuses to start in production when the console isn't on the platform domain", () => {
    // A staging box that forgot PLATFORM_DOMAIN would tell customers to use production's mail hosts.
    production({
      PLATFORM_DOMAIN: "anhourmail.com",
      APP_URL: "https://app.staging.anhourmail.com",
      WEBMAIL_URL: "https://mail.staging.anhourmail.com",
    });
    expect(() => env()).toThrow(/APP_URL must be a host directly under PLATFORM_DOMAIN/);
    production({ PLATFORM_DOMAIN: "anhourmail.com", WEBMAIL_URL: "https://webmail.example.org" });
    expect(() => env()).toThrow(/WEBMAIL_URL must be a host directly under PLATFORM_DOMAIN/);
  });

  it("doesn't tie development URLs to the platform domain", () => {
    production({
      NODE_ENV: "development",
      APP_URL: "http://localhost:43200",
      WEBMAIL_URL: "http://localhost:43300",
      SITE_URL: "http://localhost:43100",
      TRUST_PROXY: "true",
    });
    expect(env().PLATFORM_DOMAIN).toBe("anhourmail.com");
  });
});

describe("Stalwart credentials (ADR-0020 credential split)", () => {
  const onDomain = { PLATFORM_DOMAIN: "anhourmail.com" };

  it("starts with the operations key only", () => {
    production(onDomain);
    expect(env().NODE_ENV).toBe("production");
  });

  it("refuses to start without it, or with a key that can create accounts or read scripts", () => {
    production({ ...onDomain, STALWART_OPERATIONS_KEY: undefined });
    expect(() => env()).toThrow(/STALWART_OPERATIONS_KEY must be set in production/);
    production({ ...onDomain, STALWART_PROVISIONING_KEY: "p" });
    expect(() => env()).toThrow(/STALWART_PROVISIONING_KEY must not be given to this process/);
    production({ ...onDomain, STALWART_AUDIT_KEY: "a" });
    expect(() => env()).toThrow(/STALWART_AUDIT_KEY must not be given to this process/);
    production({ ...onDomain, STALWART_DEV_ADMIN_USER: "admin" });
    expect(() => env()).toThrow(/STALWART_DEV_ADMIN_USER is for development only/);
  });

  it("requires the mailbox password grant key (32+ characters) in production", () => {
    for (const key of [undefined, "", "short"]) {
      production({ ...onDomain, MAILBOX_PASSWORD_GRANT_KEY: key });
      expect(() => env()).toThrow(/MAILBOX_PASSWORD_GRANT_KEY/);
    }
  });

  it("requires a well-formed sender delegation key in production", () => {
    for (const key of [undefined, "", "short", "D".repeat(64), "d".repeat(63)]) {
      production({ ...onDomain, SENDER_DELEGATION_KEY: key });
      expect(() => env()).toThrow(/SENDER_DELEGATION_KEY/);
    }
    production({ ...onDomain, SENDER_DELEGATION_KEY: "e".repeat(64) });
    expect(senderDelegationKey()).toBe("e".repeat(64));
    expect(
      onBehalfTag(
        senderDelegationKey(),
        "box@example.org",
        "me@example.org",
        "id.1@example.org",
        "2026-10-30T09:31:37Z",
      ),
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  it("derives the dev sender delegation key when unset outside production, and checks a set one", () => {
    production({ NODE_ENV: "development", APP_URL: "http://localhost:43200", SENDER_DELEGATION_KEY: undefined });
    expect(senderDelegationKey()).toMatch(/^[0-9a-f]{64}$/);
    production({ NODE_ENV: "development", APP_URL: "http://localhost:43200", SENDER_DELEGATION_KEY: "nope" });
    expect(() => env()).toThrow(/SENDER_DELEGATION_KEY must be 64 lowercase hex/);
  });

  it("needs usable authserv-ids: configured ones must be hostnames, and production falls back to the MX host", () => {
    production({ ...onDomain });
    expect(() => env()).not.toThrow();
    production({ ...onDomain, MAIL_AUTHSERV_ID: "mx1.anhourmail.com, mx2.anhourmail.com" });
    expect(() => env()).not.toThrow();
    for (const bad of ["*", "mx1.anhourmail.com,bad*id", 'a"b.example', "nodot"]) {
      production({ ...onDomain, MAIL_AUTHSERV_ID: bad });
      expect(() => env()).toThrow(/MAIL_AUTHSERV_ID/);
    }
    production({ NODE_ENV: "development", APP_URL: "http://localhost:43200", MAIL_AUTHSERV_ID: "bad*id" });
    expect(() => env()).toThrow(/MAIL_AUTHSERV_ID/);
  });

  it("refuses the legacy single key in any mode", () => {
    production({ ...onDomain, STALWART_API_KEY: "old" });
    expect(() => env()).toThrow(/STALWART_API_KEY is no longer used/);
    production({ NODE_ENV: "development", APP_URL: "http://localhost:43200", STALWART_API_KEY: "old" });
    expect(() => env()).toThrow(/STALWART_API_KEY is no longer used/);
  });
});

describe("BREACHED_PASSWORD_CHECK", () => {
  it("defaults to on, except under NODE_ENV=test", () => {
    expect(breachedPasswordMode({ NODE_ENV: "production", BREACHED_PASSWORD_CHECK: undefined })).toBe("on");
    expect(breachedPasswordMode({ NODE_ENV: "development", BREACHED_PASSWORD_CHECK: undefined })).toBe("on");
    expect(breachedPasswordMode({ NODE_ENV: "test", BREACHED_PASSWORD_CHECK: undefined })).toBe("off");
    expect(breachedPasswordMode({ NODE_ENV: "development", BREACHED_PASSWORD_CHECK: "fake" })).toBe("fake");
    expect(breachedPasswordMode({ NODE_ENV: "production", BREACHED_PASSWORD_CHECK: "off" })).toBe("off");
  });

  it("production accepts on and off, and refuses the fake", () => {
    production({ PLATFORM_DOMAIN: "anhourmail.com", BREACHED_PASSWORD_CHECK: "on" });
    expect(env().BREACHED_PASSWORD_CHECK).toBe("on");
    production({ PLATFORM_DOMAIN: "anhourmail.com", BREACHED_PASSWORD_CHECK: "off" });
    expect(env().BREACHED_PASSWORD_CHECK).toBe("off");
    production({ PLATFORM_DOMAIN: "anhourmail.com", BREACHED_PASSWORD_CHECK: "fake" });
    expect(() => env()).toThrow(/BREACHED_PASSWORD_CHECK/);
    production({ PLATFORM_DOMAIN: "anhourmail.com", BREACHED_PASSWORD_CHECK: "maybe" });
    expect(() => env()).toThrow();
  });
});
