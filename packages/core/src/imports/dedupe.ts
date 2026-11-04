// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

import { IMPORT_MARKER_HEADER } from "@anhourmail/shared/import";

/**
 * De-duplication without storing anything (ADR-0030 §5): before copying into a destination folder the importer reads
 * that folder's Message-IDs (the pinned mail server can't search them) into an in-memory set. The key is the
 * Message-ID without angle brackets and whitespace; for a message without one, a SHA-256 of its raw `Date`, `From` and
 * `Subject` values and its size. Keys live in memory for one slice only and are never logged or stored.
 */

/** The header fields a source message's dedupe key comes from. */
export const SOURCE_HEADER_FIELDS: readonly string[] = ["message-id", "date", "from", "subject"];

/** What the destination index reads: the same, and the marker, so a copy's size can be compared with its original. */
export const DEDUPE_HEADER_FIELDS: readonly string[] = [...SOURCE_HEADER_FIELDS, IMPORT_MARKER_HEADER.toLowerCase()];

/**
 * Header fields of a raw header block (or a whole message: parsing stops at the first empty line), by lower-case name,
 * first occurrence only, folded lines unfolded and the value trimmed. Bytes are read as Latin-1 so any 8-bit value
 * keeps a stable form.
 */
export function headerFields(raw: Uint8Array | string): Map<string, string> {
  const text =
    typeof raw === "string" ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("latin1");
  const out = new Map<string, string>();
  let name: string | null = null;
  let value = "";
  const flush = () => {
    if (name !== null && !out.has(name)) out.set(name, value.trim());
    name = null;
    value = "";
  };
  for (const line of text.split(/\r?\n/)) {
    if (line === "") break;
    if (/^[ \t]/.test(line)) {
      if (name !== null) value += ` ${line.trim()}`;
      continue;
    }
    flush();
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    name = line.slice(0, colon).trim().toLowerCase();
    value = line.slice(colon + 1);
  }
  flush();
  return out;
}

/** A Message-ID as the dedupe key uses it: the part inside the first `<…>` (or the value), without whitespace. */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const inside = /<([^>]*)>/.exec(raw)?.[1] ?? raw;
  const id = inside.replace(/\s+/g, "");
  return id === "" || id.length > 998 ? null : id;
}

/** SHA-256 (hex) of the raw `Date`, `From` and `Subject` values and the size. */
export function messageFingerprint(fields: Map<string, string>, size: number): string {
  return createHash("sha256")
    .update([fields.get("date") ?? "", fields.get("from") ?? "", fields.get("subject") ?? "", String(size)].join("\n"))
    .digest("hex");
}

export const dedupeKey = (m: { messageId: string | null; fingerprint: string }): string =>
  m.messageId !== null ? `id:${m.messageId}` : `fp:${m.fingerprint}`;

/** The one header line the importer prepends to every message it copies. */
export const importMarkerLine = (importId: string): string => `${IMPORT_MARKER_HEADER}: ${importId}\r\n`;

/**
 * The dedupe key of a message already in the destination, from its header fields and stored size. A copy we made
 * carries the marker line, which isn't part of the original: its length is taken off so the fingerprint matches.
 */
export function destinationDedupeKey(fields: Map<string, string>, size: number): string {
  const marker = fields.get(IMPORT_MARKER_HEADER.toLowerCase());
  const original = marker === undefined ? size : size - Buffer.byteLength(importMarkerLine(marker), "latin1");
  return dedupeKey({
    messageId: normalizeMessageId(fields.get("message-id")),
    fingerprint: messageFingerprint(fields, original),
  });
}
