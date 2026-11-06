// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Sign-up proof-of-work (ADR-0031): the facts the browser's solver and the server's check share. The server issues a
 * signed challenge; the browser finds a `proof` (a decimal counter) such that SHA-256 of `<challenge>.<proof>` starts
 * with at least `bits` zero bits; the server checks it once before an account is created. No third party is involved.
 */

/** Request headers the sign-up form sends with `POST /api/auth/sign-up/email`. */
export const POW_HEADERS = { challenge: "x-sign-up-challenge", proof: "x-sign-up-proof" } as const;

/** Difficulty range the server accepts from configuration (`SIGNUP_POW_BITS`); the default suits a mid-range phone. */
export const POW_BITS = { min: 8, max: 26, default: 17 } as const;

/** How long an issued challenge may be spent (the browser solves it as the page opens, before the form is filled). */
export const POW_TTL_SEC = 600;

/** A proof is a decimal counter of at most this many digits. */
export const POW_PROOF_MAX_DIGITS = 15;

/** The string that is hashed for a proof. */
export const powInput = (challenge: string, proof: string): string => `${challenge}.${proof}`;

/** Number of leading zero bits in `digest`. */
export function leadingZeroBits(digest: Uint8Array): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

/** The refusal codes the sign-up endpoint answers with (the form reacts to them; never the reason in detail). */
export const SIGN_UP_REFUSAL = {
  /** The proof is missing, wrong, expired, already used or from another client: solve a new challenge. */
  proofOfWork: "proof_of_work",
  /** Too many sign-up attempts from this address (an IPv6 client: its /64) for now. */
  attempts: "sign_up_attempts",
  /** Too many accounts created from this address or network for now. */
  limited: "sign_up_limited",
  /** The invite code can't be used (unknown, used, expired, revoked, another email's): one answer for all (ADR-0029). */
  inviteCode: "invite_code_invalid",
  /** A temporary-inbox address (ADR-0033); the same code and message as everywhere else the check refuses. */
  disposableEmail: "disposable_email",
} as const;

/**
 * An invite code that goes with a sign-up (ADR-0029 §8): sent in this header next to the proof, never in the form body
 * the identity layer reads. With sign-up closed only a code that grants sign-up lets the request through; the proof
 * and every sign-up limit still apply.
 */
export const SIGN_UP_CODE_HEADER = "x-sign-up-code";
