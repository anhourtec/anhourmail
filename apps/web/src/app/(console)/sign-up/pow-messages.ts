// SPDX-License-Identifier: AGPL-3.0-only
/** Messages between the sign-up page and its proof-of-work worker (`pow.worker.ts`). */
export type PowRequest = { challenge: string; bits: number };

export type PowResponse =
  | { type: "progress"; tried: number }
  | { type: "solved"; proof: string }
  | { type: "failed"; reason: "unsupported" | "error" };

/**
 * How far along a search of `bits` difficulty probably is after `tried` proofs, 0–99: the chance a proof would have
 * been found by now (1 − e^(−tried / 2^bits)). Never 100 until it is actually found.
 */
export function powProgress(tried: number, bits: number): number {
  const p = 1 - Math.exp(-tried / 2 ** bits);
  return Math.min(99, Math.max(0, Math.floor(p * 100)));
}
