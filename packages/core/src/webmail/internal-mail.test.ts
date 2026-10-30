// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { internalMailMessageId, internalMailTag, isInternalMailTag } from "./internal-mail";
import { onBehalfTag } from "./on-behalf";

const KEY = "0123456789abcdef".repeat(4);
const OTHER = "fedcba9876543210".repeat(4);
const FROM = "alice@example.org";
const MID = "4f1c.2b@mail.example.org";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("internal-mail tag", () => {
  it("is sha256(K | sha256(K | internal-mail-v1 | from | Message-ID)), the formula the mail server computes", () => {
    expect(internalMailTag(KEY, FROM, MID)).toBe(sha(`${KEY}|${sha(`${KEY}|internal-mail-v1|${FROM}|${MID}`)}`));
  });

  it("lowercases the address, keeps the Message-ID's case and drops its angle brackets", () => {
    const tag = internalMailTag(KEY, FROM, MID);
    expect(internalMailTag(KEY, " Alice@EXAMPLE.org ", ` <${MID}> `)).toBe(tag);
    expect(internalMailTag(KEY, FROM, MID.toUpperCase())).not.toBe(tag);
  });

  it("is bound to the key, the address and the Message-ID", () => {
    const tag = internalMailTag(KEY, FROM, MID);
    expect(internalMailTag(OTHER, FROM, MID)).not.toBe(tag);
    expect(internalMailTag(KEY, "bob@example.org", MID)).not.toBe(tag);
    expect(internalMailTag(KEY, FROM, "other@mail.example.org")).not.toBe(tag);
  });

  it("is never an on-behalf tag (different input layout under the same key)", () => {
    const tag = internalMailTag(KEY, FROM, MID);
    expect(onBehalfTag(KEY, FROM, FROM, MID, "2026-10-30T12:00:00Z")).not.toBe(tag);
  });

  it("makes no tag for a Message-ID or address outside the forms the script tags", () => {
    for (const id of ["", "<>", "no-at-sign", "a b@c", "a|b@c", "a@b@c", `${"x".repeat(201)}@c`]) {
      expect(internalMailMessageId(id)).toBeNull();
      expect(internalMailTag(KEY, FROM, id)).toBeNull();
    }
    for (const from of ["", "alice", "a|b@example.org", "a b@example.org", '"a"@example.org', "a@b@c"]) {
      expect(internalMailTag(KEY, from, MID)).toBeNull();
    }
  });

  it("refuses a malformed key", () => {
    expect(() => internalMailTag("short", FROM, MID)).toThrow(/Malformed/);
  });

  it("checks a tag: the right one only, in any surrounding space", () => {
    const tag = internalMailTag(KEY, FROM, MID) ?? "";
    expect(isInternalMailTag(KEY, FROM, `<${MID}>`, ` ${tag} `)).toBe(true);
    expect(isInternalMailTag(KEY, "bob@example.org", MID, tag)).toBe(false);
    expect(isInternalMailTag(OTHER, FROM, MID, tag)).toBe(false);
    expect(isInternalMailTag(KEY, FROM, MID, "")).toBe(false);
    expect(isInternalMailTag(KEY, FROM, MID, tag.toUpperCase())).toBe(false);
    expect(isInternalMailTag(KEY, FROM, MID, `${tag}0`)).toBe(false);
    expect(isInternalMailTag(KEY, FROM, "<>", tag)).toBe(false);
  });
});
