// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { asciiDomain, fromAddress, matchSafeSender, MAX_SENDER_ENTRIES, senderEntry, senderSets } from "./senders";

describe("sender list entries", () => {
  it("keeps addresses, turns @domain and bare domains into domains, lower-cased", () => {
    expect(senderEntry(" Bob@Example.COM ")).toBe("bob@example.com");
    expect(senderEntry("@Spam.Example")).toBe("spam.example");
    expect(senderEntry("spam.example")).toBe("spam.example");
    expect(MAX_SENDER_ENTRIES).toBe(300);
  });

  it("refuses anything that isn't an address or a domain (no quotes, spaces or Sieve syntax)", () => {
    for (const bad of [
      'a"@b.c',
      "x@y",
      "evil.example; stop",
      "a b@c.d",
      "",
      "@",
      "-x.y",
      'test"]; redirect "x@y.z',
      "bücher.example/path",
      "bücher.example?x",
      "jane@bü cher.example",
      "a@",
      "x".repeat(255),
    ]) {
      expect(senderEntry(bad)).toBeNull();
    }
  });

  it("stores an internationalised domain as its A-label, typed either way", () => {
    expect(asciiDomain("Bücher.Example")).toBe("xn--bcher-kva.example");
    expect(senderEntry("bücher.example")).toBe("xn--bcher-kva.example");
    expect(senderEntry("@BÜCHER.example")).toBe("xn--bcher-kva.example");
    expect(senderEntry("xn--bcher-kva.example")).toBe("xn--bcher-kva.example");
    expect(senderEntry("Jane@bücher.example")).toBe("jane@xn--bcher-kva.example");
    expect(asciiDomain("")).toBeNull();
    expect(asciiDomain("a/b.example")).toBe("a/b.example");
    expect(asciiDomain("bü/cher.example")).toBeNull();
  });
});

describe("matchSafeSender", () => {
  const safe = ["jane@example.com", "partner.example", "xn--bcher-kva.example"];

  it("matches the whole address exactly, or the domain exactly", () => {
    expect(matchSafeSender("jane@example.com", safe)).toEqual({ kind: "address", value: "jane@example.com" });
    expect(matchSafeSender("bob@partner.example", safe)).toEqual({ kind: "domain", value: "partner.example" });
    expect(matchSafeSender("bob@example.com", safe)).toBeNull();
    expect(matchSafeSender("jane@example.co", safe)).toBeNull();
    expect(matchSafeSender("xjane@example.com", safe)).toBeNull();
  });

  it("never covers a subdomain or a parent domain", () => {
    expect(matchSafeSender("news@mail.partner.example", safe)).toBeNull();
    expect(matchSafeSender("jane@mail.example.com", safe)).toBeNull();
    expect(matchSafeSender("a@example", ["example.com"])).toBeNull();
    expect(matchSafeSender("a@notpartner.example", safe)).toBeNull();
  });

  it("ignores case and surrounding space", () => {
    expect(matchSafeSender("  JANE@Example.COM ", safe)).toEqual({ kind: "address", value: "jane@example.com" });
    expect(matchSafeSender("Bob@PARTNER.example", safe)).toEqual({ kind: "domain", value: "partner.example" });
  });

  it("prefers an address entry over a domain entry", () => {
    expect(matchSafeSender("jane@partner.example", ["partner.example", "jane@partner.example"])).toEqual({
      kind: "address",
      value: "jane@partner.example",
    });
  });

  it("matches an internationalised From domain only in the A-label form verification checked", () => {
    expect(matchSafeSender("info@xn--bcher-kva.example", safe)).toEqual({
      kind: "domain",
      value: "xn--bcher-kva.example",
    });
    // A U-label From isn't mapped onto the entry: the domain that was verified must be the one matched.
    expect(matchSafeSender("info@bücher.example", safe)).toBeNull();
  });

  it("never maps lookalike characters in the From domain onto an entry", () => {
    const list = ["example.com", "kim@example.com"];
    for (const from of [
      "news@ｅxample.com", // fullwidth e
      "news@example。com", // ideographic full stop U+3002
      "news@example．com", // fullwidth full stop
      "news@\u212Aexample.com", // Kelvin sign
      "news@example.co\u006D\u0301", // combining mark
    ]) {
      expect({ from, address: fromAddress(from) }).toEqual({ from, address: null });
      expect(matchSafeSender(from, list)).toBeNull();
    }
    // Only A–Z are lower-cased: a Kelvin sign in the local part stays itself.
    expect(matchSafeSender("\u212Aim@example.com", ["kim@example.com"])).toBeNull();
    expect(fromAddress("Kim@Example.COM")).toBe("kim@example.com");
  });

  it("refuses control characters and direction or zero-width marks in an address", () => {
    for (const bad of [
      "ki\u202Em@example.com",
      "kim\u200B@example.com",
      "k\u0007im@example.com",
      "kim\u2066@example.com",
    ]) {
      expect({ bad, address: fromAddress(bad) }).toEqual({ bad, address: null });
      expect(senderEntry(bad)).toBeNull();
    }
  });

  it("matches nothing for an empty list or a From with no usable address", () => {
    expect(matchSafeSender("jane@example.com", [])).toBeNull();
    for (const from of ["", "jane", "@example.com", "jane@", "jane@bü cher.example"]) {
      expect(matchSafeSender(from, safe)).toBeNull();
    }
  });

  it("takes pre-split sets as well as a list", () => {
    const sets = senderSets(safe);
    expect([...sets.addresses]).toEqual(["jane@example.com"]);
    expect([...sets.domains]).toEqual(["partner.example", "xn--bcher-kva.example"]);
    expect(matchSafeSender("bob@partner.example", sets)).toEqual({ kind: "domain", value: "partner.example" });
  });
});
