// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  DEDUPE_HEADER_FIELDS,
  dedupeKey,
  destinationDedupeKey,
  headerFields,
  importMarkerLine,
  messageFingerprint,
  normalizeMessageId,
  SOURCE_HEADER_FIELDS,
} from ".";

const RAW = [
  "Message-ID:",
  "  <abc@example.org>",
  "From: Someone <someone@example.org>",
  "Subject: a long",
  "\tsubject",
  "Date: Tue, 3 Feb 2015 10:00:00 +0000",
  "Subject: second subject is ignored",
  "not a header line",
  "",
  "Subject: in the body",
].join("\r\n");

describe("header fields", () => {
  it("unfolds, lower-cases names, keeps the first occurrence and stops at the body", () => {
    const f = headerFields(RAW);
    expect(f.get("message-id")).toBe("<abc@example.org>");
    expect(f.get("subject")).toBe("a long subject");
    expect(f.get("date")).toBe("Tue, 3 Feb 2015 10:00:00 +0000");
    expect(f.size).toBe(4);
    expect(headerFields(new TextEncoder().encode("From: a\nSubject: b\n\nx")).get("subject")).toBe("b");
    // 8-bit bytes keep a stable Latin-1 form.
    expect(
      headerFields(new Uint8Array([0x53, 0x75, 0x62, 0x6a, 0x65, 0x63, 0x74, 0x3a, 0x20, 0xe9])).get("subject"),
    ).toBe("é");
  });

  it("asks the source for the dedupe fields and the destination for the marker too", () => {
    expect(SOURCE_HEADER_FIELDS).toEqual(["message-id", "date", "from", "subject"]);
    expect(DEDUPE_HEADER_FIELDS).toEqual([...SOURCE_HEADER_FIELDS, "x-anhourmail-imported"]);
  });
});

describe("dedupe keys", () => {
  it("uses the Message-ID without brackets or whitespace", () => {
    expect(normalizeMessageId("<abc@example.org>")).toBe("abc@example.org");
    expect(normalizeMessageId("  < abc @example.org > (comment)")).toBe("abc@example.org");
    expect(normalizeMessageId("bare@example.org")).toBe("bare@example.org");
    expect(normalizeMessageId("<>")).toBeNull();
    expect(normalizeMessageId("")).toBeNull();
    expect(normalizeMessageId(null)).toBeNull();
    expect(normalizeMessageId(undefined)).toBeNull();
    expect(normalizeMessageId(`<${"a".repeat(999)}>`)).toBeNull();
    expect(dedupeKey({ messageId: "abc@example.org", fingerprint: "f" })).toBe("id:abc@example.org");
    expect(dedupeKey({ messageId: null, fingerprint: "f" })).toBe("fp:f");
  });

  it("falls back to a fingerprint of Date, From, Subject and size", () => {
    const f = headerFields(RAW);
    const a = messageFingerprint(f, 100);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(messageFingerprint(f, 101)).not.toBe(a);
    expect(messageFingerprint(headerFields(RAW.replace("a long", "another")), 100)).not.toBe(a);
    expect(messageFingerprint(new Map(), 0)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches a copy we made to its original: the marker line's length is taken off", () => {
    const original = "From: x\r\nSubject: s\r\nDate: d\r\n\r\nbody\r\n";
    const id = "6a9f4c1e-2b7d-4e8a-9c3f-1d2e3f4a5b6c";
    const copy = importMarkerLine(id) + original;
    expect(importMarkerLine(id)).toBe(`X-AnhourMail-Imported: ${id}\r\n`);
    const source = dedupeKey({
      messageId: null,
      fingerprint: messageFingerprint(headerFields(original), Buffer.byteLength(original)),
    });
    expect(destinationDedupeKey(headerFields(copy), Buffer.byteLength(copy))).toBe(source);
    // A message that arrived some other way (no marker) is compared as it is.
    expect(destinationDedupeKey(headerFields(original), Buffer.byteLength(original))).toBe(source);
    expect(destinationDedupeKey(headerFields(`Message-ID: <m@x>\r\n${original}`), 1)).toBe("id:m@x");
  });
});
