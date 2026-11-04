// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

import { leadingZeroBits, POW_PROOF_MAX_DIGITS, POW_TTL_SEC, powInput } from "@anhourmail/shared/proof-of-work";

/**
 * Sign-up proof-of-work (ADR-0031). A challenge is stateless and signed:
 *
 *   `v1.<bits>.<expires, unix seconds>.<nonce>.<client binding>.<mac>`
 *
 * - `nonce`: 16 random bytes; the single-use key once spent.
 * - `client binding`: an HMAC of the client address, normalised (`signUpClient(ip).address`; never the address
 *   itself), so a challenge solved on one address can't be spent from another.
 * - `mac`: HMAC-SHA-256 over everything before it, with a key derived from the deployment secret.
 *
 * The browser finds `proof` such that SHA-256(`<challenge>.<proof>`) has `bits` leading zero bits. `verifyProof`
 * checks the signature, expiry, binding, difficulty and work, then claims the nonce once (atomic, `claim`).
 */

const VERSION = "v1";
const B64 = /^[A-Za-z0-9_-]+$/;
/** A proof is a plain decimal counter, never with leading zeros (one spelling per number, so no free replays). */
const PROOF = new RegExp(`^(?:0|[1-9][0-9]{0,${String(POW_PROOF_MAX_DIGITS - 1)}})$`);
const MAX_CHALLENGE_LENGTH = 160;

export type PowKey = Uint8Array;

/** Claims a key once for `ttlMs` (Redis `SET NX PX`); errors propagate, so the caller refuses (fail closed). */
export type PowClaim = (key: string, ttlMs: number) => Promise<boolean>;

export type IssuedChallenge = { challenge: string; bits: number; expiresAt: Date };

/** Why a proof was refused. The first three are noise (anyone can send them) and are only logged, never audited. */
export type PowRefusal =
  "missing" | "malformed" | "forged" | "expired" | "wrong_client" | "too_easy" | "insufficient_work" | "replayed";

export type PowResult = { ok: true } | { ok: false; reason: PowRefusal };

/** Refusals that carry a challenge we signed (so they are bounded by issuance and worth recording). */
export const SIGNED_REFUSALS: ReadonlySet<PowRefusal> = new Set([
  "expired",
  "wrong_client",
  "too_easy",
  "insufficient_work",
  "replayed",
]);

const mac = (key: PowKey, label: string, value: string) =>
  createHmac("sha256", key).update(`${label}\0${value}`).digest();

const binding = (key: PowKey, client: string) => mac(key, "bind", client).subarray(0, 12).toString("base64url");

/** The challenge-signing key: HKDF-SHA-256 of the deployment secret with its own label (never the secret itself). */
export function powKeyFrom(secret: string): PowKey {
  return Buffer.from(hkdfSync("sha256", secret, "", "anhourmail:sign-up-proof-of-work:v1", 32));
}

export function issueChallenge(input: { key: PowKey; bits: number; client: string; now: Date }): IssuedChallenge {
  const expires = Math.floor(input.now.getTime() / 1000) + POW_TTL_SEC;
  const nonce = randomBytes(16).toString("base64url");
  const payload = [VERSION, String(input.bits), String(expires), nonce, binding(input.key, input.client)].join(".");
  const challenge = `${payload}.${mac(input.key, "mac", payload).toString("base64url")}`;
  return { challenge, bits: input.bits, expiresAt: new Date(expires * 1000) };
}

const sha256 = (text: string): Uint8Array => createHash("sha256").update(text).digest();

export async function verifyProof(input: {
  key: PowKey;
  /** The difficulty configured now: a challenge issued easier than this (before a change) is refused. */
  minBits: number;
  client: string;
  challenge: string | null;
  proof: string | null;
  now: Date;
  claim: PowClaim;
}): Promise<PowResult> {
  const { challenge, proof } = input;
  if (!challenge || !proof) return { ok: false, reason: "missing" };
  if (challenge.length > MAX_CHALLENGE_LENGTH || !PROOF.test(proof)) return { ok: false, reason: "malformed" };
  const parts = challenge.split(".");
  const [version, bitsText, expiresText, nonce, bound, signature] = parts;
  if (
    parts.length !== 6 ||
    version !== VERSION ||
    !bitsText ||
    !/^[0-9]{1,2}$/.test(bitsText) ||
    !expiresText ||
    !/^[0-9]{1,12}$/.test(expiresText) ||
    !nonce ||
    !B64.test(nonce) ||
    !bound ||
    !B64.test(bound) ||
    !signature ||
    !B64.test(signature)
  ) {
    return { ok: false, reason: "malformed" };
  }
  const payload = parts.slice(0, 5).join(".");
  const expected = mac(input.key, "mac", payload);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "forged" };

  const expiresMs = Number(expiresText) * 1000;
  if (expiresMs <= input.now.getTime()) return { ok: false, reason: "expired" };
  const want = Buffer.from(binding(input.key, input.client), "base64url");
  const got = Buffer.from(bound, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: "wrong_client" };
  const bits = Number(bitsText);
  if (bits < input.minBits) return { ok: false, reason: "too_easy" };
  if (leadingZeroBits(sha256(powInput(challenge, proof))) < bits) {
    return { ok: false, reason: "insufficient_work" };
  }
  // Last, so only a correct proof spends the challenge; an error here propagates (the caller refuses).
  const first = await input.claim(`am:pow:${nonce}`, expiresMs - input.now.getTime() + 1000);
  return first ? { ok: true } : { ok: false, reason: "replayed" };
}
