// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

import type { AuditEntry } from "./types";

/** Hash of the empty chain: the `prevHash` of every scope's first entry. */
export const GENESIS_HASH = "0".repeat(64);

/** Deterministic JSON: object keys sorted at every depth, so the same entry always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** sha256(prevHash ‖ canonical entry without `hash`). */
export function hashEntry(entry: Omit<AuditEntry, "hash">): string {
  return createHash("sha256").update(entry.prevHash).update(canonicalJson(entry)).digest("hex");
}

export type ChainBreak = { seq: number; reason: "hash_mismatch" | "prev_mismatch" | "seq_gap" };

/** Verifies one scope's entries (ordered by seq). Returns the first break, or null when intact. */
export function verifyChain(entries: readonly AuditEntry[]): ChainBreak | null {
  let prev = GENESIS_HASH;
  let expectedSeq = 1;
  for (const e of entries) {
    if (e.seq !== expectedSeq) return { seq: e.seq, reason: "seq_gap" };
    if (e.prevHash !== prev) return { seq: e.seq, reason: "prev_mismatch" };
    const { hash, ...rest } = e;
    if (hashEntry(rest) !== hash) return { seq: e.seq, reason: "hash_mismatch" };
    prev = hash;
    expectedSeq += 1;
  }
  return null;
}
