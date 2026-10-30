// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  isSenderDelegationKey,
  ON_BEHALF_EXPIRES_HEADER,
  ON_BEHALF_HEADER,
  ON_BEHALF_TTL_MS,
  onBehalfExpires,
  onBehalfTag as tagWithExpiry,
  OnBehalfTagError,
  resolveSenderDelegationKey,
  SenderDelegationKeyError,
} from "./on-behalf";

// A dummy 64-hex key, built in code so secret scanners don't take it for a real one.
const KEY = Array.from({ length: 64 }, (_, i) => (i % 16).toString(16)).join("");
const OWNER = "owner@example.org";
const DELEGATE = "delegate@example.org";
const MID = "4f1c.9a@mail.example.org";
const EXP = "2026-10-30T09:31:37Z";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** The tag with this file's fixed expiry (cases about addresses, ids and keys). */
const onBehalfTag = (key: string, mailbox: string, delegate: string, id: string) =>
  tagWithExpiry(key, mailbox, delegate, id, EXP);

describe("on-behalf tag", () => {
  it("is sha256(K | sha256(K | mailbox | delegate | Message-ID | expiry)), the formula the mail server recomputes", () => {
    const expected = sha(`${KEY}|${sha(`${KEY}|${OWNER}|${DELEGATE}|${MID}|${EXP}`)}`);
    expect(onBehalfTag(KEY, OWNER, DELEGATE, MID)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it("binds the expiry, and refuses one not in the server's UTC form", () => {
    const tag = onBehalfTag(KEY, OWNER, DELEGATE, MID);
    expect(tagWithExpiry(KEY, OWNER, DELEGATE, MID, "2026-10-30T09:31:38Z")).not.toBe(tag);
    for (const bad of [
      "",
      "2026-10-30T09:31:37.000Z",
      "2026-10-30T09:31:37+00:00",
      "2026-10-30 09:31:37Z",
      `${EXP}\n`,
    ]) {
      expect(() => tagWithExpiry(KEY, OWNER, DELEGATE, MID, bad)).toThrow(OnBehalfTagError);
    }
  });

  it("makes expiries a few minutes ahead, in UTC whole seconds", () => {
    const now = Date.parse("2026-10-30T09:26:37.912Z");
    expect(onBehalfExpires(now)).toBe("2026-10-30T09:31:37Z");
    expect(onBehalfExpires(now, 1000)).toBe("2026-10-30T09:26:38Z");
    expect(ON_BEHALF_TTL_MS).toBeLessThanOrEqual(10 * 60_000);
    expect(ON_BEHALF_EXPIRES_HEADER).toBe("X-AnhourMail-On-Behalf-Expires");
  });

  it("lowercases and trims the addresses, keeps the Message-ID's case and drops its angle brackets", () => {
    const tag = onBehalfTag(KEY, OWNER, DELEGATE, MID);
    expect(onBehalfTag(KEY, " Owner@Example.ORG", "DELEGATE@example.org ", MID)).toBe(tag);
    expect(onBehalfTag(KEY, OWNER, DELEGATE, `<${MID}>`)).toBe(tag);
    expect(onBehalfTag(KEY, OWNER, DELEGATE, MID.toUpperCase())).not.toBe(tag);
  });

  it("binds the message, the pair and its order, and the key", () => {
    const tag = onBehalfTag(KEY, OWNER, DELEGATE, MID);
    expect(onBehalfTag(KEY, OWNER, DELEGATE, "other@mail.example.org")).not.toBe(tag);
    expect(onBehalfTag(KEY, DELEGATE, OWNER, MID)).not.toBe(tag);
    expect(onBehalfTag(KEY, OWNER, "other@example.org", MID)).not.toBe(tag);
    expect(onBehalfTag("f".repeat(64), OWNER, DELEGATE, MID)).not.toBe(tag);
  });

  it("refuses a malformed key", () => {
    for (const bad of ["", "abc", KEY.toUpperCase(), `${KEY}0`, `${KEY.slice(0, 63)}'`, `${KEY.slice(0, 63)}g`]) {
      expect(isSenderDelegationKey(bad)).toBe(false);
      expect(() => onBehalfTag(bad, OWNER, DELEGATE, MID)).toThrow(SenderDelegationKeyError);
    }
    expect(isSenderDelegationKey(KEY)).toBe(true);
  });

  it("refuses addresses and ids with framing, quoting, whitespace or control characters", () => {
    for (const bad of [
      "",
      "a|b@example.org",
      '"a"@example.org',
      "a b@example.org",
      "a\tb@example.org",
      "a\u0000@x.org",
    ]) {
      expect(() => onBehalfTag(KEY, bad, DELEGATE, MID)).toThrow(OnBehalfTagError);
      expect(() => onBehalfTag(KEY, OWNER, bad, MID)).toThrow(OnBehalfTagError);
    }
    // Only `local@host` in letters, digits and `._%+=-`: what the script accepts before it hashes.
    for (const bad of [
      "",
      "<>",
      "a|b@h",
      "a b@h",
      "<a@h> <b@h>",
      "a\r\n@h",
      "a<b@h",
      "garbage",
      "a@b@c",
      "a'b@h",
      "ä@h",
    ]) {
      expect(() => onBehalfTag(KEY, OWNER, DELEGATE, bad)).toThrow(OnBehalfTagError);
    }
  });

  it("names the header the script checks and removes", () => {
    expect(ON_BEHALF_HEADER).toBe("X-AnhourMail-On-Behalf");
  });
});

describe("resolveSenderDelegationKey", () => {
  it("uses the configured key when set", () => {
    expect(resolveSenderDelegationKey({ NODE_ENV: "production", SENDER_DELEGATION_KEY: ` ${KEY} ` })).toBe(KEY);
    expect(resolveSenderDelegationKey({ SENDER_DELEGATION_KEY: KEY, BETTER_AUTH_SECRET: "x".repeat(40) })).toBe(KEY);
  });

  it("refuses a malformed configured key in every mode", () => {
    for (const NODE_ENV of ["development", "production"]) {
      expect(() => resolveSenderDelegationKey({ NODE_ENV, SENDER_DELEGATION_KEY: "short" })).toThrow(
        /64 lowercase hex/,
      );
    }
  });

  it("requires the key in production (no derived fallback)", () => {
    expect(() => resolveSenderDelegationKey({ NODE_ENV: "production", BETTER_AUTH_SECRET: "x".repeat(40) })).toThrow(
      /in production/,
    );
  });

  it("derives a stable, well-formed dev key from BETTER_AUTH_SECRET outside production", () => {
    const a = resolveSenderDelegationKey({ NODE_ENV: "development", BETTER_AUTH_SECRET: "s".repeat(40) });
    expect(isSenderDelegationKey(a)).toBe(true);
    expect(resolveSenderDelegationKey({ BETTER_AUTH_SECRET: "s".repeat(40) })).toBe(a);
    expect(resolveSenderDelegationKey({ BETTER_AUTH_SECRET: "t".repeat(40) })).not.toBe(a);
    expect(a).not.toBe(sha("s".repeat(40)));
  });

  it("needs something to derive from", () => {
    expect(() => resolveSenderDelegationKey({ NODE_ENV: "test" })).toThrow(SenderDelegationKeyError);
  });
});
