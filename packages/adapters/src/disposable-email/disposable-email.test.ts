// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from "vitest";

import { DISPOSABLE_DOMAINS, DISPOSABLE_MAIL_SERVERS } from "./data.generated";
import {
  DISPOSABLE_SOURCE,
  disposableEmailCheck,
  domainAndParents,
  domainOf,
  fakeDisposableEmailCheck,
  isSharedMailHost,
  isSharedOrReservedIp,
  listedDomain,
  privateName,
  type MailServerLookup,
  type VerdictCache,
} from "./index";

const log = () => ({ warn: vi.fn() });
const aServer = DISPOSABLE_MAIL_SERVERS.split("\n").find(Boolean) ?? "";

/** DNS answers from a table; a host or domain missing from it has none. */
const lookupFrom = (
  mx: Record<string, string[]>,
  a: Record<string, string[]>,
): MailServerLookup & { calls: number } => {
  const l = {
    calls: 0,
    mx(d: string) {
      l.calls++;
      return Promise.resolve(mx[d] ?? []);
    },
    ipv4(h: string) {
      l.calls++;
      return Promise.resolve(a[h] ?? []);
    },
  };
  return l;
};

const memoryCache = (): VerdictCache & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    get: (k) => Promise.resolve(data.get(k) ?? null),
    set: (k, v) => {
      data.set(k, v);
      return Promise.resolve();
    },
  };
};

describe("disposable email data", () => {
  it("is the vendored list with a recorded source", () => {
    expect(DISPOSABLE_SOURCE.domains).toBeGreaterThan(5000);
    expect(DISPOSABLE_SOURCE.mailServers).toBeGreaterThan(20);
    expect(DISPOSABLE_SOURCE.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(DISPOSABLE_DOMAINS).toContain("\nmailinator.com\n");
    expect(DISPOSABLE_DOMAINS).toContain("\ntemp-mail.org\n");
  });

  it("never lists the large mailbox providers", () => {
    for (const d of [
      "gmail.com",
      "googlemail.com",
      "outlook.com",
      "hotmail.com",
      "live.com",
      "yahoo.com",
      "icloud.com",
      "me.com",
      "proton.me",
      "protonmail.com",
      "aol.com",
      "gmx.com",
      "gmx.de",
      "zoho.com",
      "fastmail.com",
      "yandex.com",
      "mail.ru",
      "hey.com",
      "tutanota.com",
      "anhourmail.com",
    ]) {
      expect(listedDomain(d) ? d : null).toBeNull();
    }
  });

  it("never lists a reserved, private or shared CDN address as a disposable mail server", () => {
    for (const ip of DISPOSABLE_MAIL_SERVERS.split("\n").filter(Boolean))
      expect(isSharedOrReservedIp(ip) ? ip : null).toBeNull();
  });
});

describe("matching", () => {
  it("takes the domain of an address and its parents, never the bare TLD", () => {
    expect(domainOf("Someone@Mail.Example.COM.")).toBe("mail.example.com");
    expect(domainOf("no-at-sign")).toBeNull();
    expect(domainOf("@example.com")).toBeNull();
    expect(domainOf("a@localhost")).toBeNull();
    expect(domainAndParents("a.b.example.com")).toEqual(["a.b.example.com", "b.example.com", "example.com"]);
  });

  it("matches a listed domain and its subdomains, with extra and allow lists", () => {
    expect(listedDomain("mailinator.com")).toBe(true);
    expect(listedDomain("anything.mailinator.com")).toBe(true);
    expect(listedDomain("example.org")).toBe(false);
    expect(listedDomain("example.org", new Set(["example.org"]))).toBe(true);
    expect(listedDomain("mailinator.com", new Set(), new Set(["mailinator.com"]))).toBe(false);
  });

  it("knows the shared providers by suffix on a label boundary", () => {
    expect(isSharedMailHost("aspmx.l.google.com.")).toBe(true);
    expect(isSharedMailHost("route1.mx.cloudflare.net")).toBe(true);
    expect(isSharedMailHost("notgoogle.com")).toBe(false);
    expect(isSharedOrReservedIp("127.0.0.1")).toBe(true);
    expect(isSharedOrReservedIp("104.20.46.162")).toBe(true);
    expect(isSharedOrReservedIp("not-an-ip")).toBe(true);
  });
});

describe("disposableEmailCheck", () => {
  it("refuses a listed domain without asking DNS", async () => {
    const lookup = lookupFrom({}, {});
    const check = disposableEmailCheck({ log: log(), lookup });
    await expect(check.check("x@sub.mailinator.com")).resolves.toEqual({ disposable: true, via: "listed" });
    expect(lookup.calls).toBe(0);
  });

  it("refuses an unlisted domain whose mail server is a disposable one, and caches the answer", async () => {
    const lookup = lookupFrom(
      { "fresh-temp.example.org": ["mail.fresh-temp.example.org"] },
      { "mail.fresh-temp.example.org": [aServer] },
    );
    const cache = memoryCache();
    const check = disposableEmailCheck({ log: log(), lookup, cache });
    await expect(check.check("me@fresh-temp.example.org")).resolves.toEqual({ disposable: true, via: "mail_server" });
    expect(cache.data.get("am:disposable-mx:fresh-temp.example.org")).toBe("1");
    const calls = lookup.calls;
    await expect(check.check("other@fresh-temp.example.org")).resolves.toEqual({
      disposable: true,
      via: "mail_server",
    });
    expect(lookup.calls).toBe(calls);
  });

  it("uses the domain itself when it has no MX", async () => {
    const lookup = lookupFrom({}, { "bare.example.org": [aServer] });
    const check = disposableEmailCheck({ log: log(), lookup });
    await expect(check.check("me@bare.example.org")).resolves.toEqual({ disposable: true, via: "mail_server" });
  });

  it("accepts a domain on a shared provider even when its address is on the list", async () => {
    const lookup = lookupFrom({ "shop.example.org": ["aspmx.l.google.com"] }, { "aspmx.l.google.com": [aServer] });
    const check = disposableEmailCheck({ log: log(), lookup });
    await expect(check.check("me@shop.example.org")).resolves.toEqual({ disposable: false });
  });

  it("skips a shared provider's MX instead of trusting it: a dummy mx.google.com doesn't hide the real server", async () => {
    const lookup = lookupFrom(
      { "sneaky.example.org": ["aspmx.l.google.com", "mail.sneaky.example.org"] },
      { "mail.sneaky.example.org": [aServer] },
    );
    await expect(disposableEmailCheck({ log: log(), lookup }).check("me@sneaky.example.org")).resolves.toEqual({
      disposable: true,
      via: "mail_server",
    });
  });

  it("never looks up reserved or internal names", async () => {
    const lookup = lookupFrom({ "x.example.org": ["mx.corp.internal"] }, { "mx.corp.internal": [aServer] });
    const check = disposableEmailCheck({ log: log(), lookup });
    await expect(check.check("me@printer.local")).resolves.toEqual({ disposable: false });
    await expect(check.check("me@x.example.org")).resolves.toEqual({ disposable: false });
    // One MX query for x.example.org; nothing for printer.local, and the internal MX host is never resolved.
    expect(lookup.calls).toBe(1);
    expect(privateName("mx.corp.internal")).toBe(true);
    expect(privateName("mail.example.com")).toBe(false);
  });

  it("accepts an ordinary domain and remembers that too", async () => {
    const lookup = lookupFrom(
      { "ordinary.example.org": ["mx.ordinary.example.org"] },
      { "mx.ordinary.example.org": ["203.0.113.7"] },
    );
    const cache = memoryCache();
    const check = disposableEmailCheck({ log: log(), lookup, cache });
    await expect(check.check("me@ordinary.example.org")).resolves.toEqual({ disposable: false });
    expect(cache.data.get("am:disposable-mx:ordinary.example.org")).toBe("0");
  });

  it("fails open on a DNS error or timeout, logging the domain only", async () => {
    const l1 = log();
    const failing: MailServerLookup = {
      mx: () => Promise.reject(Object.assign(new Error("x"), { code: "ESERVFAIL" })),
      ipv4: () => Promise.resolve([]),
    };
    await expect(disposableEmailCheck({ log: l1, lookup: failing }).check("me@broken.example.org")).resolves.toEqual({
      disposable: false,
    });
    expect(l1.warn).toHaveBeenCalledWith("disposable email check failed", {
      component: "disposable-email",
      domain: "broken.example.org",
      reason: "ESERVFAIL",
    });
    const l2 = log();
    const slow: MailServerLookup = { mx: () => new Promise(() => undefined), ipv4: () => Promise.resolve([]) };
    await expect(
      disposableEmailCheck({ log: l2, lookup: slow, timeoutMs: 20 }).check("me@slow.example.org"),
    ).resolves.toEqual({ disposable: false });
    expect(l2.warn).toHaveBeenCalledWith("disposable email check timed out", {
      component: "disposable-email",
      domain: "slow.example.org",
    });
  });

  it("keeps working when the cache fails", async () => {
    const cache: VerdictCache = {
      get: () => Promise.reject(new Error("down")),
      set: () => Promise.reject(new Error("down")),
    };
    const lookup = lookupFrom({ "c.example.org": ["m.c.example.org"] }, { "m.c.example.org": [aServer] });
    await expect(disposableEmailCheck({ log: log(), lookup, cache }).check("me@c.example.org")).resolves.toEqual({
      disposable: true,
      via: "mail_server",
    });
  });

  it("honours the deployment's extra and allow lists, and ignores non-addresses", async () => {
    const check = disposableEmailCheck({
      log: log(),
      extraDomains: "burner.example, other.example",
      allowDomains: "mailinator.com",
    });
    await expect(check.check("a@burner.example")).resolves.toEqual({ disposable: true, via: "listed" });
    await expect(check.check("a@mailinator.com")).resolves.toEqual({ disposable: false });
    await expect(check.check("not an address")).resolves.toEqual({ disposable: false });
  });

  it("the fake answers from its list", async () => {
    const fake = fakeDisposableEmailCheck(["burner.test"]);
    await expect(fake.check("a@x.burner.test")).resolves.toEqual({ disposable: true, via: "listed" });
    await expect(fake.check("a@example.com")).resolves.toEqual({ disposable: false });
  });
});
