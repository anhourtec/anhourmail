// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Sign-up proof-of-work solver (ADR-0031), in a Web Worker so the page stays responsive. Tries proofs 0, 1, 2, … until
 * SHA-256(`<challenge>.<proof>`) has `bits` leading zero bits, hashing with the browser's own Web Crypto (no library,
 * nothing leaves the page). Reports progress as proofs tried.
 */
import { leadingZeroBits, POW_PROOF_MAX_DIGITS, powInput } from "@anhourmail/shared/proof-of-work";

import type { PowRequest, PowResponse } from "./pow-messages";

/** Hashes in flight at once: Web Crypto is asynchronous, so a batch keeps it busy. */
const BATCH = 256;
/** A progress message every this many proofs. */
const REPORT_EVERY = 8192;
const LIMIT = 10 ** POW_PROOF_MAX_DIGITS;

const reply = (m: PowResponse) => {
  globalThis.postMessage(m);
};

async function solve({ challenge, bits }: PowRequest): Promise<void> {
  // Web Crypto's `subtle` exists only in secure contexts (https, localhost).
  const subtle = (globalThis.crypto as Partial<Crypto> | undefined)?.subtle;
  if (!subtle) {
    reply({ type: "failed", reason: "unsupported" });
    return;
  }
  const encoder = new TextEncoder();
  for (let base = 0; base < LIMIT; base += BATCH) {
    const digests = await Promise.all(
      Array.from({ length: BATCH }, (_, i) =>
        subtle.digest("SHA-256", encoder.encode(powInput(challenge, String(base + i)))),
      ),
    );
    const hit = digests.findIndex((d) => leadingZeroBits(new Uint8Array(d)) >= bits);
    if (hit >= 0) {
      reply({ type: "solved", proof: String(base + hit) });
      return;
    }
    if ((base + BATCH) % REPORT_EVERY === 0) reply({ type: "progress", tried: base + BATCH });
  }
  reply({ type: "failed", reason: "error" });
}

globalThis.addEventListener("message", (e: MessageEvent<PowRequest>) => {
  solve(e.data).catch(() => {
    reply({ type: "failed", reason: "error" });
  });
});
