// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { hasKnownTag, KNOWN_COOKIE, knownTag, knownTags, MAX_KNOWN, rememberKnown } from "./known-mailboxes";

const SECRET = "s".repeat(40);

describe("mailboxes this browser signed in to", () => {
  it("tags a normalised address under the server secret, never revealing the address", () => {
    const tag = knownTag(SECRET, " Kid@Family.ca ");
    expect(tag).toBe(knownTag(SECRET, "kid@family.ca"));
    expect(tag).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(tag).not.toContain("family");
    expect(knownTag(SECRET, "mum@family.ca")).not.toBe(tag);
    // Another secret gives another tag: a tag can't be made without the server's secret.
    expect(knownTag("t".repeat(40), "kid@family.ca")).not.toBe(tag);
  });

  it("reads only well-formed tags from the cookie", () => {
    const a = knownTag(SECRET, "a@x.test");
    const b = knownTag(SECRET, "b@x.test");
    expect(knownTags(`other=1; ${KNOWN_COOKIE}=${a}.${b}; x=y`)).toEqual([a, b]);
    expect(knownTags(`${KNOWN_COOKIE}=${a}.not-a-tag.<script>`)).toEqual([a]);
    expect(knownTags(null)).toEqual([]);
    expect(knownTags("am.webmail_knownx=abc")).toEqual([]);
  });

  it("matches a tag only when the browser holds it", () => {
    const a = knownTag(SECRET, "a@x.test");
    expect(hasKnownTag([knownTag(SECRET, "b@x.test"), a], a)).toBe(true);
    expect(hasKnownTag([knownTag(SECRET, "b@x.test")], a)).toBe(false);
    expect(hasKnownTag([], a)).toBe(false);
  });

  it("remembers the newest first, without duplicates, at most MAX_KNOWN, for the sign-in endpoint only", () => {
    const tags = Array.from({ length: MAX_KNOWN }, (_, i) => knownTag(SECRET, `m${String(i)}@x.test`));
    const again = tags[2] ?? "";
    const cookie = rememberKnown(tags, again, true);
    const value = /^am\.webmail_known=([^;]+)/.exec(cookie)?.[1]?.split(".") ?? [];
    expect(value).toHaveLength(MAX_KNOWN);
    expect(value[0]).toBe(again);
    expect(new Set(value).size).toBe(MAX_KNOWN);
    const fresh = knownTag(SECRET, "new@x.test");
    const next = /^am\.webmail_known=([^;]+)/.exec(rememberKnown(value, fresh, false))?.[1]?.split(".") ?? [];
    expect(next).toEqual([fresh, ...value.slice(0, MAX_KNOWN - 1)]);
    expect(cookie).toContain("Path=/api/webmail/auth");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(rememberKnown([], fresh, false)).not.toContain("Secure");
  });
});
